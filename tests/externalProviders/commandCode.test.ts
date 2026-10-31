import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEffectiveContextConfig: vi.fn(),
}));

vi.mock('../../src/config/configOverrides', () => ({
  getEffectiveContextConfig: mocks.getEffectiveContextConfig,
}));

import { commandCodeDef } from '../../src/externalProviders/commandCode';
import {
  classifyByEndpoint,
  contextLengthFromEntry,
  type ExternalModelListEntry,
} from '../../src/externalProviders/types';
import {
  getReportedContextLength,
  getReportedContextLengthForProvider,
  getReportedDisplayNameForProvider,
  getReportedApiFormatForProvider,
  setProviderModelMetadata,
  clearProviderModelMetadata,
  resetModelMetadataCache,
} from '../../src/proxy/modelMetadataCache';
import { modelMaxTokens } from '../../src/context/budget';
import { buildModelCatalogEntry } from '../../src/proxy/modelCatalog';

/** A representative CommandCode /models payload entry. */
function entry(overrides: Partial<ExternalModelListEntry> = {}): ExternalModelListEntry {
  return {
    id: 'claude-sonnet-5',
    object: 'model',
    created: 1790451354,
    owned_by: 'command-code',
    name: 'Claude Sonnet 5',
    context_length: 1_000_000,
    supported_endpoints: ['/messages'],
    ...overrides,
  };
}

beforeEach(() => {
  resetModelMetadataCache();
  mocks.getEffectiveContextConfig.mockReturnValue({
    reservedResponseTokens: 4000,
    contextOverheadTokens: 500,
    defaultModelMaxTokens: 16_000,
  });
});

afterEach(() => {
  resetModelMetadataCache();
});

describe('classifyByEndpoint', () => {
  it('maps /messages to the anthropic wire format', () => {
    expect(classifyByEndpoint(entry({ supported_endpoints: ['/messages'] }))).toBe('anthropic');
  });

  it('maps chat completions and responses to the openai wire format', () => {
    expect(classifyByEndpoint(entry({ supported_endpoints: ['/chat/completions', '/responses'] }))).toBe('openai');
    expect(classifyByEndpoint(entry({ supported_endpoints: ['/responses'] }))).toBe('openai');
  });

  it('prefers /messages when both are advertised', () => {
    expect(
      classifyByEndpoint(entry({ supported_endpoints: ['/chat/completions', '/messages'] })),
    ).toBe('anthropic');
  });

  it('returns undefined without a usable endpoint list', () => {
    expect(classifyByEndpoint(entry({ supported_endpoints: [] }))).toBeUndefined();
    expect(classifyByEndpoint(entry({ supported_endpoints: undefined }))).toBeUndefined();
    expect(classifyByEndpoint(entry({ supported_endpoints: ['/embeddings'] }))).toBeUndefined();
  });
});

describe('contextLengthFromEntry', () => {
  it('returns a positive integer context length', () => {
    expect(contextLengthFromEntry(entry({ context_length: 1_050_000 }))).toBe(1_050_000);
  });

  it('ignores missing, zero, negative and non-finite values', () => {
    expect(contextLengthFromEntry(entry({ context_length: undefined }))).toBeUndefined();
    expect(contextLengthFromEntry(entry({ context_length: 0 }))).toBeUndefined();
    expect(contextLengthFromEntry(entry({ context_length: -1 }))).toBeUndefined();
    expect(contextLengthFromEntry(entry({ context_length: Number.NaN }))).toBeUndefined();
  });
});

describe('commandCodeDef', () => {
  it('points at the CommandCode provider gateway', () => {
    expect(commandCodeDef.baseUrl).toBe('https://api.commandcode.ai/provider/v1');
    expect(commandCodeDef.modelsPath).toBe('/models');
  });

  it('exposes OpenAI and Anthropic sub-providers', () => {
    expect(commandCodeDef.subProviders.map((s) => s.type)).toEqual(['openai', 'anthropic']);
    expect(commandCodeDef.subProviders.map((s) => s.prefix)).toEqual(['CCO', 'CCA']);
  });

  it('uses bearer auth', () => {
    expect(commandCodeDef.buildAuthHeaders('k')).toEqual({ Authorization: 'Bearer k' });
  });

  it('routes Claude and GPT models to different sub-providers by endpoint', () => {
    expect(commandCodeDef.classifyModel('claude-sonnet-5', entry())).toBe(1);
    expect(
      commandCodeDef.classifyModel('gpt-6-astra', entry({ supported_endpoints: ['/chat/completions'] })),
    ).toBe(0);
  });

  it('falls back to the ID when no endpoint metadata is present', () => {
    const bare = entry({ supported_endpoints: undefined });
    expect(commandCodeDef.classifyModel('claude-opus-5', bare)).toBe(1);
    expect(commandCodeDef.classifyModel('gpt-6-sol', bare)).toBe(0);
    expect(commandCodeDef.classifyModel('anthropic-foo', bare)).toBe(1);
  });

  it('normalizes an entry into an id, bucket and metadata', () => {
    const normalized = commandCodeDef.normalizeModel!(entry());

    expect(normalized).toEqual({
      id: 'claude-sonnet-5',
      bucketIndex: 1,
      metadata: {
        contextLength: 1_000_000,
        displayName: 'Claude Sonnet 5',
        apiFormat: 'anthropic',
      },
    });
  });

  it('skips entries without an id', () => {
    expect(commandCodeDef.normalizeModel!(entry({ id: '   ' }))).toBeNull();
  });
});

describe('model metadata cache', () => {
  it('reports the context length and label a provider advertised', () => {
    setProviderModelMetadata('p1', [
      { modelId: 'gpt-6-astra', contextLength: 1_050_000, displayName: 'GPT-6 Astra' },
    ]);

    expect(getReportedContextLength('gpt-6-astra')).toBe(1_050_000);
    expect(getReportedDisplayNameForProvider('p1', 'gpt-6-astra')).toBe('GPT-6 Astra');
  });

  it('resolves provider-scoped model IDs by stripping the short prefix', () => {
    setProviderModelMetadata('p1', [{ modelId: 'gpt-6-astra', contextLength: 1_050_000 }]);

    expect(getReportedContextLength('CCO-gpt-6-astra')).toBe(1_050_000);
  });

  it('replaces a provider\'s rows on the next sync', () => {
    setProviderModelMetadata('p1', [{ modelId: 'old-model', contextLength: 100_000 }]);
    setProviderModelMetadata('p1', [{ modelId: 'new-model', contextLength: 200_000 }]);

    expect(getReportedContextLength('old-model')).toBeUndefined();
    expect(getReportedContextLength('new-model')).toBe(200_000);
  });

  it('keeps the widest window when two providers report the same model', () => {
    setProviderModelMetadata('p1', [{ modelId: 'shared', contextLength: 128_000 }]);
    setProviderModelMetadata('p2', [{ modelId: 'shared', contextLength: 1_000_000 }]);
    setProviderModelMetadata('p3', [{ modelId: 'shared', contextLength: 200_000 }]);

    expect(getReportedContextLength('shared')).toBe(1_000_000);
  });

  it('does not let one provider\'s metadata overwrite another\'s for the same model', () => {
    // The exact real-world shape: opencode Go and CommandCode both expose
    // `deepseek-v4`, but report different context windows and wire formats.
    // Conflating them misroutes requests to the wrong endpoint.
    setProviderModelMetadata('opencode', [{
      modelId: 'deepseek-v4',
      contextLength: 128_000,
      apiFormat: 'openai',
      displayName: 'DeepSeek V4',
    }]);
    setProviderModelMetadata('commandcode', [{
      modelId: 'deepseek-v4',
      contextLength: 1_000_000,
      apiFormat: 'anthropic',
      displayName: 'DeepSeek V4 Pro',
    }]);

    expect(getReportedContextLengthForProvider('opencode', 'deepseek-v4')).toBe(128_000);
    expect(getReportedContextLengthForProvider('commandcode', 'deepseek-v4')).toBe(1_000_000);

    expect(getReportedApiFormatForProvider('opencode', 'deepseek-v4')).toBe('openai');
    expect(getReportedApiFormatForProvider('commandcode', 'deepseek-v4')).toBe('anthropic');

    expect(getReportedDisplayNameForProvider('opencode', 'deepseek-v4')).toBe('DeepSeek V4');
    expect(getReportedDisplayNameForProvider('commandcode', 'deepseek-v4')).toBe('DeepSeek V4 Pro');
  });

  it('clearing one provider leaves another provider\'s shared model intact', () => {
    setProviderModelMetadata('opencode', [{ modelId: 'deepseek-v4', contextLength: 128_000 }]);
    setProviderModelMetadata('commandcode', [{ modelId: 'deepseek-v4', contextLength: 1_000_000 }]);

    clearProviderModelMetadata('opencode');

    expect(getReportedContextLengthForProvider('opencode', 'deepseek-v4')).toBeUndefined();
    expect(getReportedContextLengthForProvider('commandcode', 'deepseek-v4')).toBe(1_000_000);
  });

  it('drops a provider\'s entries when cleared', () => {
    setProviderModelMetadata('p1', [{ modelId: 'gpt-6-astra', contextLength: 1_050_000 }]);
    clearProviderModelMetadata('p1');

    expect(getReportedContextLength('gpt-6-astra')).toBeUndefined();
  });

  it('ignores non-positive context lengths', () => {
    setProviderModelMetadata('p1', [{ modelId: 'weird', contextLength: 0 }]);
    expect(getReportedContextLength('weird')).toBeUndefined();
  });
});

describe('modelMaxTokens with reported metadata', () => {
  it('prefers the reported window over the name heuristic', () => {
    // The heuristic would return 128_000 for anything containing "gpt-4o".
    setProviderModelMetadata('p1', [{ modelId: 'gpt-4o-custom', contextLength: 1_000_000 }]);

    expect(modelMaxTokens('gpt-4o-custom')).toBe(1_000_000);
  });

  it('falls back to the heuristic when nothing was reported', () => {
    expect(modelMaxTokens('gpt-4o')).toBe(128_000);
    expect(modelMaxTokens('unknown-model')).toBe(16_000);
  });

  it('resolves a provider-scoped model ID', () => {
    setProviderModelMetadata('p1', [{ modelId: 'gpt-6-sol', contextLength: 1_050_000 }]);
    expect(modelMaxTokens('CCO-gpt-6-sol')).toBe(1_050_000);
  });
});

describe('buildModelCatalogEntry with reported metadata', () => {
  const provider = {
    id: 'provider-cc',
    name: 'CommandCode (OpenAI)',
    type: 'openai' as const,
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    shortPrefix: 'CCO',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('advertises the reported context window and display name', () => {
    setProviderModelMetadata('provider-cc', [
      {
        modelId: 'gpt-6-astra',
        contextLength: 1_050_000,
        displayName: 'GPT-6 Astra',
        apiFormat: 'openai',
      },
    ]);

    const catalogEntry = buildModelCatalogEntry(provider, 'gpt-6-astra');

    expect(catalogEntry.id).toBe('CCO-gpt-6-astra');
    expect(catalogEntry.context_window).toBe(1_050_000);
    expect(catalogEntry.max_input_tokens).toBe(1_050_000 - 4500);
    // The provider name prefixes the label so duplicate model IDs stay apart.
    expect(catalogEntry.display_name).toBe('CommandCode (OpenAI) \u00b7 GPT-6 Astra');
    expect(catalogEntry.model_id).toBe('gpt-6-astra');
    expect(catalogEntry.api_format).toBe('openai');
  });

  it('lets a reported api_format override the provider default', () => {
    setProviderModelMetadata('provider-cc', [
      { modelId: 'claude-sonnet-5', contextLength: 1_000_000, apiFormat: 'anthropic' },
    ]);

    const catalogEntry = buildModelCatalogEntry(provider, 'claude-sonnet-5');
    expect(catalogEntry.api_format).toBe('anthropic');
  });

  it('falls back to the model ID and provider type when nothing is reported', () => {
    const catalogEntry = buildModelCatalogEntry(provider, 'gpt-6-luna');

    expect(catalogEntry.display_name).toBe('CommandCode (OpenAI) \u00b7 gpt-6-luna');
    expect(catalogEntry.model_id).toBe('gpt-6-luna');
    expect(catalogEntry.api_format).toBe('openai');
    expect(catalogEntry.context_window).toBe(16_000);
  });
});
