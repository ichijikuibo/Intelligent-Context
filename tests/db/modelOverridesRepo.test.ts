import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDbHarness, createSchemaTables } from './helpers/mockDb';

type ModelOverridesModule = typeof import('../../src/db/repositories/modelOverrides');
type MetadataCacheModule = typeof import('../../src/proxy/modelMetadataCache');

describe('modelOverridesRepo', () => {
  const schemaTables = createSchemaTables();

  let dbHarness = createMockDbHarness();
  let selectAll = vi.fn();
  let execute = vi.fn();
  let markDirty = vi.fn();
  let overridesModule: ModelOverridesModule;
  let cacheModule: MetadataCacheModule;

  async function loadModule() {
    vi.resetModules();

    dbHarness = createMockDbHarness();
    selectAll = vi.fn();
    execute = vi.fn();
    markDirty = vi.fn();

    vi.doMock('drizzle-orm', () => ({
      eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
      and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
      inArray: (left: unknown, values: unknown) => ({ op: 'inArray', left, values }),
    }));

    vi.doMock('../../src/db/connection', () => ({
      db: () => dbHarness.api,
      selectAll,
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

    overridesModule = await import('../../src/db/repositories/modelOverrides');
    // Imported after resetModules so it is the same module instance the repo uses.
    cacheModule = await import('../../src/proxy/modelMetadataCache');
    cacheModule.resetModelMetadataCache();
  }

  beforeEach(async () => {
    await loadModule();
  });

  it('inserts an override row and refreshes the in-memory cache', async () => {
    // upsert's refreshCacheForProvider re-reads the provider's rows.
    selectAll.mockResolvedValueOnce([
      {
        providerId: 'provider-1',
        modelId: 'deepseek-v4',
        displayName: 'DeepSeek V4',
        contextLength: 1_000_000,
        apiFormat: 'anthropic',
        supportsReasoning: true,
        supportsVision: true,
      },
    ]);

    const result = await overridesModule.modelOverridesRepo.upsert('provider-1', 'deepseek-v4', {
      displayName: 'DeepSeek V4',
      contextLength: 1_000_000,
      apiFormat: 'anthropic',
      supportsReasoning: true,
      supportsVision: true,
    });

    const deleteRecord = dbHarness.lastRecord('delete');
    const insertRecord = dbHarness.lastRecord('insert');

    expect(deleteRecord?.table).toBe(schemaTables.providerModelOverrides);
    expect(insertRecord?.table).toBe(schemaTables.providerModelOverrides);
    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        providerId: 'provider-1',
        modelId: 'deepseek-v4',
        displayName: 'DeepSeek V4',
        contextLength: 1_000_000,
        apiFormat: 'anthropic',
        supportsReasoning: true,
        supportsVision: true,
      })
    );
    expect(markDirty).toHaveBeenCalled();

    expect(result).toMatchObject({
      providerId: 'provider-1',
      modelId: 'deepseek-v4',
      contextLength: 1_000_000,
      apiFormat: 'anthropic',
      supportsReasoning: true,
      supportsVision: true,
    });

    // Cache reads now serve the override.
    expect(cacheModule.getReportedContextLengthForProvider('provider-1', 'deepseek-v4')).toBe(1_000_000);
    expect(cacheModule.getReportedDisplayNameForProvider('provider-1', 'deepseek-v4')).toBe('DeepSeek V4');
    expect(cacheModule.getReportedApiFormatForProvider('provider-1', 'deepseek-v4')).toBe('anthropic');
    expect(cacheModule.getModelSupportsReasoningForProvider('provider-1', 'deepseek-v4')).toBe(true);
    expect(cacheModule.getModelSupportsVisionForProvider('provider-1', 'deepseek-v4')).toBe(true);
  });

  it('normalizes invalid context lengths and api formats to null', async () => {
    selectAll.mockResolvedValueOnce([]);

    await overridesModule.modelOverridesRepo.upsert('provider-1', 'model-a', {
      contextLength: -5,
      apiFormat: 'gemini' as never,
    });

    const insertRecord = dbHarness.lastRecord('insert');

    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        contextLength: null,
        apiFormat: null,
        displayName: null,
        supportsReasoning: null,
        supportsVision: null,
      })
    );
  });

  it('deletes one override and clears its cached value', async () => {
    cacheModule.setProviderModelOverrides('provider-1', [
      { modelId: 'model-a', contextLength: 32_000 },
    ]);
    selectAll.mockResolvedValueOnce([]);

    await overridesModule.modelOverridesRepo.delete('provider-1', 'model-a');

    expect(cacheModule.getReportedContextLengthForProvider('provider-1', 'model-a')).toBeUndefined();
    expect(dbHarness.lastRecord('delete')?.table).toBe(schemaTables.providerModelOverrides);
  });

  it('deletes overrides for several providers and clears their cache entries', async () => {
    cacheModule.setProviderModelOverrides('provider-1', [{ modelId: 'model-a', contextLength: 32_000 }]);
    cacheModule.setProviderModelOverrides('provider-2', [{ modelId: 'model-b', contextLength: 64_000 }]);

    await overridesModule.modelOverridesRepo.deleteForProviders(['provider-1', 'provider-2']);

    expect(cacheModule.getReportedContextLengthForProvider('provider-1', 'model-a')).toBeUndefined();
    expect(cacheModule.getReportedContextLengthForProvider('provider-2', 'model-b')).toBeUndefined();
    expect(dbHarness.lastRecord('delete')?.table).toBe(schemaTables.providerModelOverrides);
  });

  it('skips the delete statement when asked to clear no providers', async () => {
    await overridesModule.modelOverridesRepo.deleteForProviders([]);

    expect(dbHarness.records.length).toBe(0);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('primes the cache from stored rows grouped by provider', async () => {
    selectAll.mockResolvedValueOnce([
      {
        providerId: 'provider-1',
        modelId: 'model-a',
        displayName: null,
        contextLength: 32_000,
        apiFormat: 'openai',
        supportsReasoning: false,
      },
      {
        providerId: 'provider-1',
        modelId: 'model-b',
        displayName: 'Model B',
        contextLength: null,
        apiFormat: null,
        supportsReasoning: null,
      },
      {
        providerId: 'provider-2',
        modelId: 'model-c',
        displayName: null,
        contextLength: 128_000,
        apiFormat: null,
        supportsReasoning: true,
        supportsVision: true,
      },
    ]);

    await overridesModule.modelOverridesRepo.primeCache();

    expect(cacheModule.getReportedContextLengthForProvider('provider-1', 'model-a')).toBe(32_000);
    expect(cacheModule.getModelSupportsReasoningForProvider('provider-1', 'model-a')).toBe(false);
    expect(cacheModule.getReportedDisplayNameForProvider('provider-1', 'model-b')).toBe('Model B');
    expect(cacheModule.getReportedContextLengthForProvider('provider-2', 'model-c')).toBe(128_000);
    expect(cacheModule.getModelSupportsReasoningForProvider('provider-2', 'model-c')).toBe(true);
    expect(cacheModule.getModelSupportsVisionForProvider('provider-2', 'model-c')).toBe(true);
  });

  it('maps stored nulls to undefined fields', async () => {
    selectAll.mockResolvedValueOnce([
      {
        providerId: 'provider-1',
        modelId: 'model-a',
        displayName: null,
        contextLength: null,
        apiFormat: null,
        supportsReasoning: null,
        supportsVision: null,
      },
    ]);

    const rows = await overridesModule.modelOverridesRepo.findByProvider('provider-1');

    expect(rows).toEqual([{ providerId: 'provider-1', modelId: 'model-a' }]);
  });
});
