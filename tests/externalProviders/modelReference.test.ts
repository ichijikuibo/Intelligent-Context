import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  axiosIsAxiosError: vi.fn((error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError),
  replaceSource: vi.fn(),
  countBySource: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('axios', () => ({
  default: {
    get: mocks.axiosGet,
    isAxiosError: mocks.axiosIsAxiosError,
  },
}));

vi.mock('../../src/db/repositories/modelReference', () => ({
  modelReferenceRepo: {
    replaceSource: mocks.replaceSource,
    countBySource: mocks.countBySource,
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import {
  MODEL_REFERENCE_ENABLED_KEY,
  MODEL_REFERENCE_LAST_ERROR_KEY,
  MODEL_REFERENCE_LAST_SYNC_KEY,
  getModelReferenceSyncStatus,
  isModelReferenceSyncEnabled,
  normalizeOpenRouterEntry,
  setModelReferenceSyncEnabled,
  syncModelReference,
} from '../../src/externalProviders/modelReference';
import {
  resetSystemConfigCache,
  setSystemConfigCacheValue,
} from '../../src/config/systemConfigCache';

/** One catalog entry shaped the way OpenRouter returns them. */
function openRouterEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek: DeepSeek V4.1 Flash',
    context_length: 1_048_576,
    architecture: { input_modalities: ['text', 'image'] },
    top_provider: { context_length: 1_048_576, max_completion_tokens: 943_718 },
    supported_parameters: ['max_tokens', 'reasoning', 'reasoning_effort', 'tools'],
    ...overrides,
  };
}

describe('normalizeOpenRouterEntry', () => {
  it('extracts context, output ceiling, vision and reasoning support', () => {
    expect(normalizeOpenRouterEntry(openRouterEntry())).toEqual({
      modelId: 'deepseek/deepseek-v4.1-flash',
      source: 'openrouter',
      vendor: 'deepseek',
      displayName: 'DeepSeek: DeepSeek V4.1 Flash',
      contextLength: 1_048_576,
      maxOutputTokens: 943_718,
      supportsVision: true,
      supportsReasoning: true,
    });
  });

  it('reports no vision for a text-only model', () => {
    const row = normalizeOpenRouterEntry(
      openRouterEntry({ architecture: { input_modalities: ['text'] } })
    );

    expect(row?.supportsVision).toBe(false);
  });

  it('treats an advertised reasoning object as reasoning support', () => {
    const row = normalizeOpenRouterEntry(
      openRouterEntry({
        supported_parameters: ['max_tokens'],
        reasoning: { mandatory: false, default_enabled: true },
      })
    );

    expect(row?.supportsReasoning).toBe(true);
  });

  it('falls back to the provider context window when the model reports none', () => {
    const row = normalizeOpenRouterEntry(
      openRouterEntry({ context_length: undefined, top_provider: { context_length: 131_072 } })
    );

    expect(row?.contextLength).toBe(131_072);
  });

  it('skips aliases, routers and entries without an ID', () => {
    expect(normalizeOpenRouterEntry(openRouterEntry({ id: '~deepseek/deepseek-pro-latest' }))).toBeUndefined();
    expect(normalizeOpenRouterEntry(openRouterEntry({ id: 'openrouter/auto' }))).toBeUndefined();
    expect(normalizeOpenRouterEntry(openRouterEntry({ id: '  ' }))).toBeUndefined();
  });

  it('tolerates malformed optional fields', () => {
    const row = normalizeOpenRouterEntry(
      openRouterEntry({
        name: 42,
        architecture: { input_modalities: 'image' },
        supported_parameters: null,
        top_provider: { max_completion_tokens: -5 },
      })
    );

    expect(row?.displayName).toBeUndefined();
    expect(row?.supportsVision).toBe(false);
    expect(row?.supportsReasoning).toBe(false);
    expect(row?.maxOutputTokens).toBeUndefined();
  });
});

describe('syncModelReference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSystemConfigCache();
    mocks.replaceSource.mockResolvedValue(2);
  });

  it('stores the normalized catalog and records the sync time', async () => {
    mocks.axiosGet.mockResolvedValue({
      data: {
        data: [
          openRouterEntry(),
          openRouterEntry({ id: 'openai/gpt-4o', context_length: 128_000 }),
          openRouterEntry({ id: '~openai/gpt-latest' }),
        ],
      },
    });

    const result = await syncModelReference();

    expect(result).toEqual({ ok: true, count: 2 });
    expect(mocks.replaceSource).toHaveBeenCalledTimes(1);

    const [source, rows] = mocks.replaceSource.mock.calls[0] as [string, unknown[]];
    expect(source).toBe('openrouter');
    expect(rows).toHaveLength(2);

    const status = getModelReferenceSyncStatus();
    expect(status.lastError).toBe('');
    expect(status.lastSyncAt).not.toBe('');
  });

  it('keeps the previous rows and records the error when the request fails', async () => {
    mocks.axiosGet.mockRejectedValue({ isAxiosError: true, message: 'boom', response: { status: 503 } });

    const result = await syncModelReference();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
    expect(result.error).toContain('503');
    expect(mocks.replaceSource).not.toHaveBeenCalled();
    expect(getModelReferenceSyncStatus().lastError).toContain('boom');
  });

  it('rejects an unexpected payload shape', async () => {
    mocks.axiosGet.mockResolvedValue({ data: { nope: true } });

    const result = await syncModelReference();

    expect(result.ok).toBe(false);
    expect(mocks.replaceSource).not.toHaveBeenCalled();
  });

  it('reports a storage failure without losing the error', async () => {
    mocks.axiosGet.mockResolvedValue({ data: { data: [openRouterEntry()] } });
    mocks.replaceSource.mockRejectedValue(new Error('disk full'));

    const result = await syncModelReference();

    expect(result).toEqual({ ok: false, count: 0, error: 'disk full' });
    expect(getModelReferenceSyncStatus().lastError).toBe('disk full');
  });
});

describe('reference sync enable flag', () => {
  beforeEach(() => {
    resetSystemConfigCache();
  });

  it('defaults to enabled and can be switched off', () => {
    expect(isModelReferenceSyncEnabled()).toBe(true);

    setModelReferenceSyncEnabled(false);
    expect(isModelReferenceSyncEnabled()).toBe(false);

    setSystemConfigCacheValue(MODEL_REFERENCE_ENABLED_KEY, 'true');
    expect(isModelReferenceSyncEnabled()).toBe(true);
  });

  it('surfaces the stored status', () => {
    setSystemConfigCacheValue(MODEL_REFERENCE_LAST_SYNC_KEY, '2026-10-04T10:00:00.000Z');
    setSystemConfigCacheValue(MODEL_REFERENCE_LAST_ERROR_KEY, 'oops');

    expect(getModelReferenceSyncStatus()).toEqual({
      enabled: true,
      lastSyncAt: '2026-10-04T10:00:00.000Z',
      lastError: 'oops',
    });
  });
});
