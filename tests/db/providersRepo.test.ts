import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../src/utils/appErrors';
import { createMockDbHarness, createSchemaTables } from './helpers/mockDb';

type ProvidersRepoModule = typeof import('../../src/db/repositories/providers');

describe('providersRepo', () => {
  const schemaTables = createSchemaTables();

  let dbHarness = createMockDbHarness();
  let selectAll = vi.fn();
  let selectOne = vi.fn();
  let execute = vi.fn();
  let markDirty = vi.fn();
  let providersModule: ProvidersRepoModule;

  async function loadModule() {
    vi.resetModules();

    dbHarness = createMockDbHarness();
    selectAll = vi.fn();
    selectOne = vi.fn();
    execute = vi.fn();
    markDirty = vi.fn();

    vi.doMock('drizzle-orm', () => ({
      eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
      and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
    }));

    vi.doMock('uuid', () => ({
      v4: vi.fn(() => 'provider-uuid'),
    }));

    vi.doMock('../../src/db/connection', () => ({
      db: () => dbHarness.api,
      selectAll,
      selectOne,
      execute,
      markDirty,
    }));

    vi.doMock('../../src/db/schema', async () => {
      const actual = await vi.importActual<typeof import('../../src/db/schema')>('../../src/db/schema');
      return {
        ...actual,
        getSchema: () => schemaTables,
      };
    });

    providersModule = await import('../../src/db/repositories/providers');
  }

  beforeEach(async () => {
    await loadModule();
  });

  it('prefers the enabled default provider for a type', async () => {
    selectAll.mockResolvedValueOnce([
      { id: 'provider-1', type: 'openai', isEnabled: true, isDefault: false },
      { id: 'provider-2', type: 'openai', isEnabled: true, isDefault: true },
    ]);

    const result = await providersModule.providersRepo.findBestForType('openai');

    expect(result).toEqual({ id: 'provider-2', type: 'openai', isEnabled: true, isDefault: true });
  });

  it('prefers exact model matches and boosts default providers when routing by model', async () => {
    selectAll.mockResolvedValueOnce([
      {
        id: 'provider-1',
        name: 'Partial Match',
        models: 'gpt-4, gpt-4.1',
        isEnabled: true,
        isDefault: false,
      },
      {
        id: 'provider-2',
        name: 'Exact Default',
        models: 'gpt-4.1-mini, gpt-4.1',
        isEnabled: true,
        isDefault: true,
      },
    ]);

    const result = await providersModule.providersRepo.findProviderForModel('gpt-4.1-mini');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'provider-2',
        name: 'Exact Default',
      })
    );
  });

  it('makes the first provider of a type the default when inserting', async () => {
    selectAll.mockResolvedValueOnce([]);
    selectOne.mockResolvedValueOnce({
      id: 'provider-uuid',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      models: 'gpt-4.1-mini',
      isEnabled: true,
      isDefault: true,
    });

    const created = await providersModule.providersRepo.insert({
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      models: 'gpt-4.1-mini',
    });

    const insertRecord = dbHarness.lastRecord('insert');

    expect(created).toEqual(
      expect.objectContaining({
        id: 'provider-uuid',
        isDefault: true,
      })
    );
    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        id: 'provider-uuid',
        name: 'OpenAI',
        isDefault: true,
        isEnabled: true,
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate provider names to a provider conflict error', async () => {
    selectAll.mockResolvedValueOnce([]);
    execute.mockRejectedValueOnce({
      code: '23505',
      message: 'duplicate key value violates unique constraint "provider_configs_name_key"',
    });

    const error = await providersModule.providersRepo
      .insert({
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'secret',
      })
      .catch((caught) => caught as AppError);

    expect(error.code).toBe('provider_conflict');
    expect(error.statusCode).toBe(409);
  });

  it('rejects duplicate short prefixes before insert', async () => {
    selectAll.mockResolvedValueOnce([]);
    selectOne.mockResolvedValueOnce({
      id: 'provider-existing',
      shortPrefix: 'OAI',
    });

    const error = await providersModule.providersRepo
      .insert({
        name: 'OpenAI Duplicate',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'secret',
        shortPrefix: 'oai-',
      })
      .catch((caught) => caught as AppError);

    expect(error.code).toBe('provider_prefix_conflict');
    expect(error.statusCode).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it('ignores blank apiKey updates while persisting other fields', async () => {
    selectOne.mockResolvedValueOnce({
      id: 'provider-1',
      name: 'Updated Provider',
      apiKey: 'existing-secret',
    });

    await providersModule.providersRepo.update('provider-1', {
      name: 'Updated Provider',
      apiKey: '',
      models: 'gpt-4.1-mini, gpt-4.1',
    });

    const updateRecord = dbHarness.lastRecord('update');

    expect(updateRecord?.set).toEqual(
      expect.objectContaining({
        name: 'Updated Provider',
        models: 'gpt-4.1-mini, gpt-4.1',
        updatedAt: expect.any(Date),
      })
    );
    expect(updateRecord?.set).not.toHaveProperty('apiKey');
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('unsets existing defaults before setting a new default provider', async () => {
    const findByIdSpy = vi.spyOn(providersModule.providersRepo, 'findById').mockResolvedValue({
      id: 'provider-2',
      type: 'openai',
      isDefault: false,
    } as any);

    await providersModule.providersRepo.setDefault('provider-2');

    const updateRecords = dbHarness.records.filter((record) => record.kind === 'update');

    expect(updateRecords).toHaveLength(2);
    expect(updateRecords[0]?.set).toEqual(
      expect.objectContaining({
        isDefault: false,
        updatedAt: expect.any(Date),
      })
    );
    expect(updateRecords[1]?.set).toEqual(
      expect.objectContaining({
        isDefault: true,
        updatedAt: expect.any(Date),
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);

    findByIdSpy.mockRestore();
  });

  it('resolves a provider-prefixed display label to the provider and raw model ID', async () => {
    // The label uses the name the provider reported, not the raw model ID, so
    // resolution depends on the metadata cache.
    const { setProviderModelMetadata } = await import('../../src/proxy/modelMetadataCache');
    setProviderModelMetadata('provider-cc', [
      { modelId: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' },
    ]);

    selectAll.mockResolvedValueOnce([
      {
        id: 'provider-cc',
        name: 'CommandCode (OpenAI)',
        models: 'deepseek/deepseek-v4.1-flash,claude-sonnet-5',
        isEnabled: true,
      },
    ]);

    const result = await providersModule.providersRepo.findModelForLabel(
      'CommandCode (OpenAI) · DeepSeek V4.1 Flash'
    );

    expect(result).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({ id: 'provider-cc' }),
        modelId: 'deepseek/deepseek-v4.1-flash',
      })
    );
  });

  it('treats the provider name in a label as authoritative', async () => {
    const { setProviderModelMetadata } = await import('../../src/proxy/modelMetadataCache');
    setProviderModelMetadata('provider-a', [
      { modelId: 'shared-model', displayName: 'Shared Model' },
    ]);
    setProviderModelMetadata('provider-b', [
      { modelId: 'shared-model', displayName: 'Shared Model' },
    ]);

    selectAll.mockResolvedValueOnce([
      { id: 'provider-a', name: 'Gateway A', models: 'shared-model', isEnabled: true },
      { id: 'provider-b', name: 'Gateway B', models: 'shared-model', isEnabled: true },
    ]);

    // Both gateways expose the same label; the named one must win.
    const result = await providersModule.providersRepo.findModelForLabel('Gateway B · Shared Model');

    expect(result).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({ id: 'provider-b' }),
        modelId: 'shared-model',
      })
    );
  });

  it('falls back to the bare model label when the provider prefix is stale', async () => {
    const { setProviderModelMetadata } = await import('../../src/proxy/modelMetadataCache');
    setProviderModelMetadata('provider-cc', [
      { modelId: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' },
    ]);

    selectAll.mockResolvedValueOnce([
      {
        id: 'provider-cc',
        name: 'CommandCode (OpenAI)',
        models: 'deepseek/deepseek-v4.1-flash',
        isEnabled: true,
      },
    ]);

    // The label was built before the provider was renamed.
    const result = await providersModule.providersRepo.findModelForLabel(
      'CommandCode · DeepSeek V4.1 Flash'
    );

    expect(result).toEqual(
      expect.objectContaining({ modelId: 'deepseek/deepseek-v4.1-flash' })
    );
  });

  it('returns undefined when a label matches no configured model', async () => {
    selectAll.mockResolvedValueOnce([
      {
        id: 'provider-cc',
        name: 'CommandCode (OpenAI)',
        models: 'deepseek/deepseek-v4.1-flash',
        isEnabled: true,
      },
    ]);

    const result = await providersModule.providersRepo.findModelForLabel(
      'Somewhere · Nonexistent Model'
    );

    expect(result).toBeUndefined();
  });
});