import { beforeEach, describe, expect, it } from 'vitest';
import {
  getModelReference,
  listModelReferenceMatches,
  modelReferenceCacheSize,
  normalizeReferenceModelId,
  resetModelReferenceCache,
  setModelReference,
  MODEL_REFERENCE_SOURCE_OPENROUTER,
} from '../../src/proxy/modelReferenceCache';

/** A small slice of the OpenRouter catalog, keyed the way OpenRouter keys it. */
function primeCatalog(): void {
  setModelReference(MODEL_REFERENCE_SOURCE_OPENROUTER, [
    { modelId: 'deepseek/deepseek-v4.1-flash', contextLength: 1_048_576, supportsVision: true },
    { modelId: 'deepseek/deepseek-v4.1-flash-20260910', contextLength: 1_048_576 },
    { modelId: 'deepseek/deepseek-v4-flash-0731', contextLength: 1_048_576 },
    { modelId: 'anthropic/claude-sonnet-5', contextLength: 1_000_000, supportsVision: true },
    { modelId: 'openai/gpt-4o', contextLength: 128_000 },
    { modelId: 'openai/gpt-4o-mini', contextLength: 128_000 },
    { modelId: 'openai/gpt-5', contextLength: 400_000 },
    { modelId: 'openai/gpt-5.5', contextLength: 1_050_000 },
    { modelId: 'z-ai/glm-5.3', contextLength: 1_048_576 },
  ]);
}

describe('modelReferenceCache ID normalization', () => {
  it('lower-cases, strips provider prefixes and drops variant suffixes', () => {
    expect(normalizeReferenceModelId('  DeepSeek/DeepSeek-V4.1-Flash  ')).toBe('deepseek/deepseek-v4.1-flash');
    expect(normalizeReferenceModelId('deepseek/deepseek-v4.1-flash:free')).toBe('deepseek/deepseek-v4.1-flash');
    expect(normalizeReferenceModelId('CCO-deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(normalizeReferenceModelId('')).toBe('');
  });
});

describe('modelReferenceCache matching', () => {
  beforeEach(() => {
    resetModelReferenceCache();
    primeCatalog();
  });

  it('matches a bare model ID against the vendor-qualified catalog entry', () => {
    // The case that motivated suffix matching: a provider stores only the
    // trailing name, the catalog stores `vendor/name`.
    const match = getModelReference('deepseek-v4.1-flash');

    expect(match?.modelId).toBe('deepseek/deepseek-v4.1-flash');
    expect(match?.contextLength).toBe(1_048_576);
    expect(match?.supportsVision).toBe(true);
  });

  it('matches a provider-scoped ID and an exact full catalog ID', () => {
    expect(getModelReference('DSK-deepseek-v4.1-flash')?.modelId).toBe('deepseek/deepseek-v4.1-flash');
    expect(getModelReference('deepseek/deepseek-v4.1-flash')?.modelId).toBe('deepseek/deepseek-v4.1-flash');
    expect(getModelReference('ANTH-claude-sonnet-5')?.contextLength).toBe(1_000_000);
  });

  it('matches a trailing fragment of the catalog name', () => {
    // "ends with" rather than exact: the request is a suffix of the full name.
    expect(getModelReference('deepseek-v4.1-flash')?.modelId).toBe('deepseek/deepseek-v4.1-flash');
    expect(getModelReference('claude-sonnet-5')?.modelId).toBe('anthropic/claude-sonnet-5');
    expect(getModelReference('glm-5.3')?.modelId).toBe('z-ai/glm-5.3');
  });

  it('falls back from a dated snapshot to the base model', () => {
    // Provider stores the dated ID, the catalog has both the dated row and the
    // base row — the exact dated row wins because it is the closest match.
    expect(getModelReference('deepseek/deepseek-v4.1-flash-20260910')?.modelId)
      .toBe('deepseek/deepseek-v4.1-flash-20260910');

    // Provider stores a date the catalog does not have: fall back to the base.
    expect(getModelReference('deepseek-v4.1-flash-20261111')?.modelId)
      .toBe('deepseek/deepseek-v4.1-flash');
  });

  it('never bridges a non-numeric variant suffix', () => {
    // `gpt-4o-mini` must not inherit `gpt-4o`'s defaults and vice versa.
    expect(getModelReference('gpt-4o')?.modelId).toBe('openai/gpt-4o');
    expect(getModelReference('gpt-4o-mini')?.modelId).toBe('openai/gpt-4o-mini');

    // `gpt-5` must not pick up `gpt-5.5` (a different model with a bigger window).
    expect(getModelReference('gpt-5')?.contextLength).toBe(400_000);
    expect(getModelReference('gpt-5.5')?.contextLength).toBe(1_050_000);
  });

  it('matches a short name exactly but never fuzzily', () => {
    setModelReference(MODEL_REFERENCE_SOURCE_OPENROUTER, [
      { modelId: 'someone/o1', contextLength: 200_000 },
      { modelId: 'someone/o1-preview', contextLength: 128_000 },
    ]);

    // Exact bare-name match is fine — that is the same model.
    expect(getModelReference('o1')?.modelId).toBe('someone/o1');

    // A short request must not fuzzily reach a longer, different model.
    expect(getModelReference('preview')).toBeUndefined();
    expect(getModelReference('o1-mini')).toBeUndefined();
  });

  it('returns undefined for a model the catalog does not know', () => {
    expect(getModelReference('totally-unknown-model')).toBeUndefined();
    expect(getModelReference('')).toBeUndefined();
  });

  it('lists every candidate match, closest first', () => {
    const matches = listModelReferenceMatches('deepseek-v4.1-flash');

    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]?.modelId).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('replaces and clears a source without touching the others', () => {
    setModelReference('other-catalog', [{ modelId: 'other/thing', contextLength: 42 }]);
    expect(modelReferenceCacheSize()).toBe(10);

    setModelReference(MODEL_REFERENCE_SOURCE_OPENROUTER, []);
    expect(getModelReference('deepseek-v4.1-flash')).toBeUndefined();
    expect(getModelReference('other/thing')?.contextLength).toBe(42);
  });

  it('keeps the first row when two vendors expose the same bare name', () => {
    resetModelReferenceCache();
    setModelReference(MODEL_REFERENCE_SOURCE_OPENROUTER, [
      { modelId: 'first/shared-model', contextLength: 100_000 },
      { modelId: 'second/shared-model', contextLength: 200_000 },
    ]);

    expect(getModelReference('shared-model')?.contextLength).toBe(100_000);
  });
});
