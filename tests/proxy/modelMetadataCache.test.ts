import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderModelMetadata,
  clearProviderModelOverrides,
  getModelSupportsReasoningForProvider,
  getModelSupportsVisionForProvider,
  getReportedApiFormatForProvider,
  getReportedContextLength,
  getReportedContextLengthForProvider,
  getReportedDisplayNameForProvider,
  modelMetadataCacheSize,
  resetModelMetadataCache,
  setProviderModelMetadata,
  setProviderModelOverrides,
} from '../../src/proxy/modelMetadataCache';

describe('modelMetadataCache', () => {
  beforeEach(() => {
    resetModelMetadataCache();
  });

  it('serves reported values when no override exists', () => {
    setProviderModelMetadata('provider-1', [
      { modelId: 'model-a', contextLength: 128_000, displayName: 'Model A', apiFormat: 'openai' },
    ]);

    expect(getReportedContextLengthForProvider('provider-1', 'model-a')).toBe(128_000);
    expect(getReportedDisplayNameForProvider('provider-1', 'model-a')).toBe('Model A');
    expect(getReportedApiFormatForProvider('provider-1', 'model-a')).toBe('openai');
  });

  it('lets an override win field-by-field over reported values', () => {
    setProviderModelMetadata('provider-1', [
      { modelId: 'model-a', contextLength: 128_000, displayName: 'Reported name', apiFormat: 'openai' },
    ]);
    setProviderModelOverrides('provider-1', [
      { modelId: 'model-a', displayName: 'Custom name', supportsReasoning: true },
    ]);

    // Overridden fields win; untouched fields fall back to the reported value.
    expect(getReportedDisplayNameForProvider('provider-1', 'model-a')).toBe('Custom name');
    expect(getReportedContextLengthForProvider('provider-1', 'model-a')).toBe(128_000);
    expect(getReportedApiFormatForProvider('provider-1', 'model-a')).toBe('openai');
    expect(getModelSupportsReasoningForProvider('provider-1', 'model-a')).toBe(true);
  });

  it('replaces a provider’s overrides without touching reported rows', () => {
    setProviderModelMetadata('provider-1', [{ modelId: 'model-a', contextLength: 128_000 }]);
    setProviderModelOverrides('provider-1', [{ modelId: 'model-a', contextLength: 32_000 }]);

    expect(getReportedContextLengthForProvider('provider-1', 'model-a')).toBe(32_000);

    setProviderModelOverrides('provider-1', []);

    expect(getReportedContextLengthForProvider('provider-1', 'model-a')).toBe(128_000);
  });

  it('returns undefined for an explicit false reasoning override', () => {
    setProviderModelOverrides('provider-1', [{ modelId: 'model-a', supportsReasoning: false }]);

    expect(getModelSupportsReasoningForProvider('provider-1', 'model-a')).toBe(false);
    expect(getModelSupportsReasoningForProvider('provider-1', 'model-b')).toBeUndefined();
  });

  it('reports vision support only when the override sets it', () => {
    setProviderModelOverrides('provider-1', [
      { modelId: 'model-a', supportsVision: true },
      { modelId: 'model-b', supportsVision: false },
      { modelId: 'model-c' },
    ]);

    expect(getModelSupportsVisionForProvider('provider-1', 'model-a')).toBe(true);
    expect(getModelSupportsVisionForProvider('provider-1', 'model-b')).toBe(false);
    expect(getModelSupportsVisionForProvider('provider-1', 'model-c')).toBeUndefined();
    expect(getModelSupportsVisionForProvider('provider-1', 'model-d')).toBeUndefined();
    expect(getModelSupportsVisionForProvider('', 'model-a')).toBeUndefined();
  });

  it('keeps reported and override caches independent when clearing', () => {
    setProviderModelMetadata('provider-1', [{ modelId: 'model-a', contextLength: 128_000 }]);
    setProviderModelOverrides('provider-1', [{ modelId: 'model-a', contextLength: 32_000 }]);

    clearProviderModelMetadata('provider-1');

    expect(getReportedContextLengthForProvider('provider-1', 'model-a')).toBe(32_000);

    clearProviderModelOverrides('provider-1');

    expect(getReportedContextLengthForProvider('provider-1', 'model-a')).toBeUndefined();
    expect(modelMetadataCacheSize()).toBe(0);
  });

  it('resolves provider-less lookups across providers using the widest effective window', () => {
    setProviderModelMetadata('provider-a', [{ modelId: 'shared-model', contextLength: 64_000 }]);
    setProviderModelMetadata('provider-b', [{ modelId: 'shared-model', contextLength: 200_000 }]);

    expect(getReportedContextLength('shared-model')).toBe(200_000);

    // An override that lowers one provider's window must not be masked by that
    // same provider's stale reported value.
    setProviderModelOverrides('provider-b', [{ modelId: 'shared-model', contextLength: 16_000 }]);

    expect(getReportedContextLength('shared-model')).toBe(64_000);
  });

  it('finds override-only models and strips provider prefixes for provider-less lookups', () => {
    setProviderModelOverrides('provider-1', [{ modelId: 'manual-model', contextLength: 32_000 }]);

    expect(getReportedContextLength('manual-model')).toBe(32_000);
    expect(getReportedContextLength('MNL-manual-model')).toBe(32_000);
    expect(getReportedContextLength('unknown-model')).toBeUndefined();
  });

  it('counts entries from both caches', () => {
    setProviderModelMetadata('provider-1', [{ modelId: 'model-a', contextLength: 128_000 }]);
    setProviderModelOverrides('provider-1', [{ modelId: 'model-b', contextLength: 32_000 }]);

    expect(modelMetadataCacheSize()).toBe(2);

    resetModelMetadataCache();

    expect(modelMetadataCacheSize()).toBe(0);
  });
});
