import { afterEach, describe, expect, it } from 'vitest';
import {
  buildModelDisplayName,
  looksLikeModelLabel,
  modelLabelFor,
  parseModelDisplayName,
  MODEL_LABEL_SEPARATOR,
} from '../../src/proxy/modelLabels';
import {
  resetModelMetadataCache,
  setProviderModelMetadata,
} from '../../src/proxy/modelMetadataCache';

afterEach(() => {
  resetModelMetadataCache();
});

describe('buildModelDisplayName', () => {
  it('prefixes the model label with the provider name', () => {
    expect(buildModelDisplayName('CommandCode (OpenAI)', 'DeepSeek V4.1 Flash')).toBe(
      'CommandCode (OpenAI) · DeepSeek V4.1 Flash',
    );
  });

  it('uses the documented separator', () => {
    expect(buildModelDisplayName('A', 'B')).toBe(`A${MODEL_LABEL_SEPARATOR}B`);
  });
});

describe('parseModelDisplayName', () => {
  it('splits a provider-prefixed label', () => {
    expect(parseModelDisplayName('CommandCode (OpenAI) · DeepSeek V4.1 Flash')).toEqual({
      providerName: 'CommandCode (OpenAI)',
      modelLabel: 'DeepSeek V4.1 Flash',
    });
  });

  it('splits only on the first separator', () => {
    expect(parseModelDisplayName('Provider · Model · With · Separators')).toEqual({
      providerName: 'Provider',
      modelLabel: 'Model · With · Separators',
    });
  });

  it('returns undefined when there is no provider prefix', () => {
    expect(parseModelDisplayName('DeepSeek V4.1 Flash')).toBeUndefined();
    expect(parseModelDisplayName('deepseek/deepseek-v4.1-flash')).toBeUndefined();
    expect(parseModelDisplayName('')).toBeUndefined();
  });

  it('returns undefined when either half is empty', () => {
    expect(parseModelDisplayName(' · Model')).toBeUndefined();
    expect(parseModelDisplayName('Provider · ')).toBeUndefined();
  });
});

describe('looksLikeModelLabel', () => {
  it('detects provider-prefixed labels', () => {
    expect(looksLikeModelLabel('CommandCode (OpenAI) · DeepSeek V4.1 Flash')).toBe(true);
  });

  it('detects bare display labels, which contain spaces', () => {
    expect(looksLikeModelLabel('DeepSeek V4.1 Flash')).toBe(true);
    expect(looksLikeModelLabel('GPT-6 Astra')).toBe(true);
  });

  it('ignores real model IDs', () => {
    expect(looksLikeModelLabel('deepseek/deepseek-v4.1-flash')).toBe(false);
    expect(looksLikeModelLabel('CCO-deepseek-v4.1-flash')).toBe(false);
    expect(looksLikeModelLabel('gpt-4.1-mini')).toBe(false);
    expect(looksLikeModelLabel('   ')).toBe(false);
  });
});

describe('modelLabelFor', () => {
  it('prefers the provider-reported display name', () => {
    setProviderModelMetadata('provider-cc', [
      { modelId: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' },
    ]);

    expect(modelLabelFor('provider-cc', 'deepseek/deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash');
  });

  it('falls back to the raw model ID when the provider reports no name', () => {
    expect(modelLabelFor('provider-cc', 'deepseek/deepseek-v4.1-flash')).toBe(
      'deepseek/deepseek-v4.1-flash',
    );
  });

  it('does not leak another provider\'s display name', () => {
    setProviderModelMetadata('provider-a', [
      { modelId: 'shared-model', displayName: 'Shared Model A' },
    ]);

    expect(modelLabelFor('provider-b', 'shared-model')).toBe('shared-model');
  });
});
