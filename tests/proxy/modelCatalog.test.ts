import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEffectiveContextConfig: vi.fn(),
}));

vi.mock('../../src/config/configOverrides', () => ({
  getEffectiveContextConfig: mocks.getEffectiveContextConfig,
}));

import {
  buildModelCatalogEntry,
  computeMaxInputTokens,
} from '../../src/proxy/modelCatalog';
import {
  resetModelMetadataCache,
  setProviderModelOverrides,
} from '../../src/proxy/modelMetadataCache';
import {
  resetSystemConfigCache,
  setSystemConfigCacheValue,
} from '../../src/config/systemConfigCache';

function primeConfig(overrides: Partial<{ reservedResponseTokens: number; contextOverheadTokens: number; defaultModelMaxTokens: number }> = {}) {
  mocks.getEffectiveContextConfig.mockReturnValue({
    reservedResponseTokens: 4000,
    contextOverheadTokens: 500,
    defaultModelMaxTokens: 16_000,
    ...overrides,
  });
}

describe('computeMaxInputTokens', () => {
  it('subtracts the reserved response and overhead from the context window', () => {
    primeConfig();

    const result = computeMaxInputTokens('gpt-4o');

    expect(result.contextWindow).toBe(128_000);
    expect(result.maxOutputTokens).toBe(4000);
    expect(result.maxInputTokens).toBe(128_000 - 4000 - 500);
  });

  it('uses the configured default window for unknown models', () => {
    primeConfig({ defaultModelMaxTokens: 20_000 });

    const result = computeMaxInputTokens('some-private-model');

    expect(result.contextWindow).toBe(20_000);
    expect(result.maxInputTokens).toBe(20_000 - 4500);
  });

  it('never returns a non-positive input budget', () => {
    primeConfig({ defaultModelMaxTokens: 1000 });

    const result = computeMaxInputTokens('tiny-model');

    expect(result.maxInputTokens).toBeGreaterThan(0);
  });
});

describe('buildModelCatalogEntry', () => {
  it('advertises api_format and token limits for an OpenAI-format provider', () => {
    primeConfig();

    const entry = buildModelCatalogEntry(
      {
        id: 'provider-1',
        name: 'DeepSeek',
        type: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        shortPrefix: 'DSK',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      'deepseek-chat',
    );

    expect(entry).toMatchObject({
      id: 'DSK-deepseek-chat',
      object: 'model',
      provider_type: 'openai',
      provider_name: 'DeepSeek',
      provider_id: 'provider-1',
      base_url: 'https://api.deepseek.com/v1',
      api_format: 'openai',
      model_id: 'deepseek-chat',
      display_name: 'DeepSeek \u00b7 deepseek-chat',
    });
    expect(entry.context_window).toBe(128_000);
    expect(entry.max_input_tokens).toBe(128_000 - 4500);
    expect(entry.max_output_tokens).toBe(4000);
  });

  it('reports anthropic api_format for an Anthropic-format provider', () => {
    primeConfig();

    const entry = buildModelCatalogEntry(
      {
        id: 'provider-2',
        name: 'Anthropic',
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        shortPrefix: 'ANTH',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      'claude-3-5-sonnet',
    );

    expect(entry.api_format).toBe('anthropic');
    expect(entry.id).toBe('ANTH-claude-3-5-sonnet');
  });

  it('prefixes duplicate model IDs per provider so both can be offered at once', () => {
    primeConfig();

    const shared = { createdAt: new Date('2026-01-01T00:00:00.000Z') };

    const viaOpencode = buildModelCatalogEntry(
      { id: 'p1', name: 'opencode Go', type: 'openai', baseUrl: 'https://opencode.ai', shortPrefix: 'OCO', ...shared },
      'deepseek-v4',
    );
    const viaDeepseek = buildModelCatalogEntry(
      { id: 'p2', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', shortPrefix: 'DSK', ...shared },
      'deepseek-v4',
    );

    // Same underlying model, distinguishable IDs and labels — the IDE can show both.
    expect(viaOpencode.model_id).toBe(viaDeepseek.model_id);
    expect(viaOpencode.id).toBe('OCO-deepseek-v4');
    expect(viaDeepseek.id).toBe('DSK-deepseek-v4');
    expect(viaOpencode.id).not.toBe(viaDeepseek.id);
    // The labels must differ, or the user cannot tell the duplicates apart.
    expect(viaOpencode.display_name).toBe('opencode Go \u00b7 deepseek-v4');
    expect(viaDeepseek.display_name).toBe('DeepSeek \u00b7 deepseek-v4');
    expect(viaOpencode.display_name).not.toBe(viaDeepseek.display_name);
  });

  it('honours an explicit scoped id override', () => {
    primeConfig();

    const entry = buildModelCatalogEntry(
      {
        id: 'provider-9',
        name: 'Ollama',
        type: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        shortPrefix: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      'Ignored',
      'custom-scoped-id',
    );

    expect(entry.id).toBe('custom-scoped-id');
    expect(entry.model_id).toBe('Ignored');
    expect(entry.display_name).toBe('Ollama \u00b7 Ignored');
  });

  it('reports per-model overrides for context, format, label, and reasoning', () => {
    primeConfig();
    setProviderModelOverrides('provider-10', [
      {
        modelId: 'custom-model',
        contextLength: 512_000,
        apiFormat: 'anthropic',
        displayName: 'Custom Model',
        supportsReasoning: true,
        supportsVision: true,
      },
    ]);

    try {
      const entry = buildModelCatalogEntry(
        {
          id: 'provider-10',
          name: 'Gateway',
          type: 'openai',
          baseUrl: 'https://gateway.example/v1',
          shortPrefix: 'GW',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        'custom-model',
      );

      expect(entry.context_window).toBe(512_000);
      expect(entry.api_format).toBe('anthropic');
      expect(entry.display_name).toBe('Gateway \u00b7 Custom Model');
      expect(entry.supports_reasoning).toBe(true);
      expect(entry.supports_vision).toBe(true);
      expect(entry.model_id).toBe('custom-model');
    } finally {
      resetModelMetadataCache();
    }
  });

  it('reports vision support only for marked models when no vision model is configured', () => {
    primeConfig();
    setProviderModelOverrides('provider-11', [
      { modelId: 'sees-images', supportsVision: true },
      { modelId: 'text-only' },
    ]);

    try {
      const provider = {
        id: 'provider-11',
        name: 'Gateway',
        type: 'openai' as const,
        baseUrl: 'https://gateway.example/v1',
        shortPrefix: 'GW',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };

      expect(buildModelCatalogEntry(provider, 'sees-images').supports_vision).toBe(true);
      expect(buildModelCatalogEntry(provider, 'text-only').supports_vision).toBe(false);
    } finally {
      resetModelMetadataCache();
    }
  });

  it('reports every model as vision-capable once a vision model is configured', () => {
    primeConfig();
    setSystemConfigCacheValue('visionModel', 'GW-sees-images');

    try {
      const provider = {
        id: 'provider-12',
        name: 'Gateway',
        type: 'openai' as const,
        baseUrl: 'https://gateway.example/v1',
        shortPrefix: 'GW',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };

      expect(buildModelCatalogEntry(provider, 'text-only').supports_vision).toBe(true);
    } finally {
      resetSystemConfigCache();
    }
  });
});
