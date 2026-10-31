import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

const helpers = vi.hoisted(() => {
  const cache = new Map<string, string>();
  const queryChain: Record<string, (...args: unknown[]) => unknown> = {};
  queryChain.select = () => queryChain;
  queryChain.from = () => queryChain;
  queryChain.where = () => queryChain;
  queryChain.update = () => queryChain;
  queryChain.set = () => queryChain;
  queryChain.insert = () => queryChain;
  queryChain.values = () => queryChain;

  return { cache, queryChain };
});

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  db: vi.fn(() => helpers.queryChain),
  markDirty: vi.fn(),
  selectOne: vi.fn(),
  execute: vi.fn(),
  getSystemConfigCacheValue: vi.fn((key: string) => helpers.cache.get(key) ?? ''),
  setSystemConfigCacheValue: vi.fn((key: string, value: string) => {
    helpers.cache.set(key, value);
  }),
  projectsRepo: {
    findById: vi.fn(),
    getSettings: vi.fn(),
    update: vi.fn(),
  },
  providersRepo: {
    findAll: vi.fn(),
  },
  formatZodError: vi.fn(() => 'validation.error'),
  t: vi.fn((_: unknown, key: string) => key),
  modelReferenceRepo: {
    countBySource: vi.fn(async () => 0),
  },
  modelReference: {
    getModelReferenceSyncStatus: vi.fn(() => ({
      enabled: true,
      lastSyncAt: '',
      lastError: '',
    })),
    setModelReferenceSyncEnabled: vi.fn(),
    syncModelReference: vi.fn(async () => ({ ok: true, count: 0 })),
  },
}));

vi.mock('../../src/config/config', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/db/connection', () => ({
  db: mocks.db,
  markDirty: mocks.markDirty,
  selectOne: mocks.selectOne,
  execute: mocks.execute,
}));

vi.mock('../../src/config/systemConfigCache', () => ({
  getSystemConfigCacheValue: mocks.getSystemConfigCacheValue,
  setSystemConfigCacheValue: mocks.setSystemConfigCacheValue,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

vi.mock('../../src/db/repositories/modelReference', () => ({
  modelReferenceRepo: mocks.modelReferenceRepo,
}));

vi.mock('../../src/externalProviders/modelReference', () => ({
  MODEL_REFERENCE_SOURCE_OPENROUTER: 'openrouter',
  getModelReferenceSyncStatus: mocks.modelReference.getModelReferenceSyncStatus,
  setModelReferenceSyncEnabled: mocks.modelReference.setModelReferenceSyncEnabled,
  syncModelReference: mocks.modelReference.syncModelReference,
}));

vi.mock('../../src/db/schema', () => ({
  systemConfig: {
    key: 'key',
    value: 'value',
  },
  parseModels: (provider: { models?: string }) =>
    (provider.models || '')
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model.length > 0),
}));

vi.mock('../../src/i18n', () => ({
  formatZodError: mocks.formatZodError,
  t: mocks.t,
}));

import { createSettingsRouter } from '../../src/api/routes/settings';
import {
  resetModelMetadataCache,
  setProviderModelOverrides,
} from '../../src/proxy/modelMetadataCache';
import {
  resetModelReferenceCache,
  setModelReference,
} from '../../src/proxy/modelReferenceCache';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(createSettingsRouter());
  return app;
}

describe('createSettingsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helpers.cache.clear();

    mocks.getConfig.mockReturnValue({
      context: {
        tokenBudget: 2048,
        autoSummarizeThreshold: 5,
        fallbackExtraction: false,
        embeddingModel: 'text-embedding-3-small',
        maxCandidates: 20,
        minConfidence: 0.6,
        semanticDuplicateThreshold: 0.92,
        debugLearningBlocks: false,
        bypassSelectorItemThreshold: 10,
        bypassSelectorTokenThreshold: 2000,
        contextReplayTtlMinutes: 30,
        maxCachedContexts: 50,
        reservedResponseTokens: 4000,
        contextOverheadTokens: 500,
        defaultModelMaxTokens: 16000,
      },
      workers: {
        summarizeIntervalMinutes: 15,
        analyzeIntervalHours: 6,
        idleThresholdMinutes: 20,
      },
    });
    mocks.selectOne.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue(undefined);
    mocks.providersRepo.findAll.mockResolvedValue([
      {
        id: 'provider-1',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        shortPrefix: 'OAI',
        models: 'gpt-4.1-mini, gpt-4.1',
        apiKey: 'configured',
        isEnabled: true,
        isDefault: true,
      },
      {
        id: 'provider-2',
        name: 'Anthropic',
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        shortPrefix: 'ANTH',
        models: 'claude-3.7, gpt-4.1-mini',
        apiKey: 'configured',
        isEnabled: true,
        isDefault: false,
      },
      {
        id: 'provider-3',
        name: 'Disabled',
        type: 'openai',
        baseUrl: 'https://disabled.example',
        models: 'ignored-model',
        apiKey: 'configured',
        isEnabled: false,
        isDefault: false,
      },
    ]);
  });

  it('returns configured model selections, provider-scoped available models, and context overrides', async () => {
    helpers.cache.set('requestContextMode', 'gatherer');
    helpers.cache.set('contextSelectorModel', 'selector-model');
    helpers.cache.set('summarizerModel', 'summarizer-model');
    helpers.cache.set('analyzerModel', 'analyzer-model');
    helpers.cache.set('enableAgentAnalyzer', 'true');
    helpers.cache.set('analyzerAgentMaxTurns', '42');
    helpers.cache.set('context.tokenBudget', '4096');

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        models: {
          requestContextMode: 'gatherer',
          contextSelector: 'selector-model',
          summarizer: 'summarizer-model',
          analyzer: 'analyzer-model',
          learning: '',
        },
        analyzer: {
          agentEnabled: true,
          agentMaxTurns: 42,
        },
        availableModels: ['ANTH-claude-3.7', 'OAI-gpt-4.1', 'ANTH-gpt-4.1-mini', 'OAI-gpt-4.1-mini'],
        availableModelOptions: [
          {
            value: 'ANTH-claude-3.7',
            label: 'claude-3.7 [Anthropic]',
          },
          {
            value: 'OAI-gpt-4.1',
            label: 'gpt-4.1 [OpenAI]',
          },
          {
            value: 'ANTH-gpt-4.1-mini',
            label: 'gpt-4.1-mini [Anthropic]',
          },
          {
            value: 'OAI-gpt-4.1-mini',
            label: 'gpt-4.1-mini [OpenAI]',
          },
        ],
        context: {
          tokenBudget: 4096,
          contextReplayTtlMinutes: 30,
        },
      });
    });
  });

  it('lists only vision-capable models for the vision model picker', async () => {
    setProviderModelOverrides('provider-1', [{ modelId: 'gpt-4.1-mini', supportsVision: true }]);

    try {
      await withTestServer(createApp(), async ({ request }) => {
        const body = await (await request('/')).json();

        expect(body.models.vision).toBe('');
        expect(body.availableVisionModelOptions).toEqual([
          {
            value: 'OAI-gpt-4.1-mini',
            label: 'gpt-4.1-mini [OpenAI]',
            model: 'gpt-4.1-mini',
            providerId: 'provider-1',
            providerName: 'OpenAI',
            providerType: 'openai',
            shortPrefix: 'OAI',
          },
        ]);
      });
    } finally {
      resetModelMetadataCache();
    }
  });

  it('offers models the shared catalog reports as vision-capable', async () => {
    // No per-model override at all — the reference catalog alone makes
    // `gpt-4.1` a candidate.
    setModelReference('openrouter', [
      { modelId: 'openai/gpt-4.1', contextLength: 1_047_576, supportsVision: true },
      { modelId: 'openai/gpt-3.5-turbo', contextLength: 16_385, supportsVision: false },
    ]);

    try {
      await withTestServer(createApp(), async ({ request }) => {
        const body = await (await request('/')).json();

        expect(body.availableVisionModelOptions.map((option: { value: string }) => option.value))
          .toEqual(['OAI-gpt-4.1']);
      });
    } finally {
      resetModelReferenceCache();
    }
  });

  it('keeps a configured vision model visible even when it is no longer marked', async () => {    helpers.cache.set('visionModel', 'ANTH-claude-3.7');
    setProviderModelOverrides('provider-1', [{ modelId: 'gpt-4.1-mini', supportsVision: true }]);

    try {
      await withTestServer(createApp(), async ({ request }) => {
        const body = await (await request('/')).json();

        expect(body.models.vision).toBe('ANTH-claude-3.7');
        expect(body.availableVisionModelOptions.map((option: { value: string }) => option.value))
          .toEqual(['ANTH-claude-3.7', 'OAI-gpt-4.1-mini']);
      });
    } finally {
      resetModelMetadataCache();
    }
  });

  it('rejects invalid global settings payloads before persisting overrides', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenBudget: 99 }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'validation.error' });
    });

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.markDirty).not.toHaveBeenCalled();
  });

  it('persists selected models and numeric overrides through the system-config helpers', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestContextMode: 'basic',
          contextSelectorModel: 'selector-model',
          learningModel: 'deepseek-chat',
          enableAgentAnalyzer: true,
          analyzerAgentMaxTurns: 42,
          tokenBudget: 4096,
          contextReplayTtlMinutes: 0,
          maxRecordLearnings: 300,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('requestContextMode', 'basic');
    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('contextSelectorModel', 'selector-model');
    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('learningModel', 'deepseek-chat');
    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('enableAgentAnalyzer', 'true');
    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('analyzerAgentMaxTurns', '42');
    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('context.tokenBudget', '4096');
    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('context.contextReplayTtlMinutes', '0');
    expect(mocks.setSystemConfigCacheValue).toHaveBeenCalledWith('context.maxRecordLearnings', '300');
    expect(mocks.markDirty).toHaveBeenCalledTimes(8);
  });

  it('merges project settings updates with the existing project configuration', async () => {
    mocks.projectsRepo.findById.mockResolvedValue({ id: 'project-1', settings: '{}' });
    mocks.projectsRepo.getSettings.mockReturnValue({
      mainModel: 'gpt-4.1-mini',
      autoSummarizeThreshold: 5,
    });
    mocks.projectsRepo.update.mockResolvedValue(undefined);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/project/project-1', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ analyzerModel: 'gpt-4.1' }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    expect(mocks.projectsRepo.update).toHaveBeenCalledWith('project-1', {
      settings: {
        mainModel: 'gpt-4.1-mini',
        autoSummarizeThreshold: 5,
        analyzerModel: 'gpt-4.1',
      },
    });
  });
});