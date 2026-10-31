const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/;
const PREFIX_SCOPED_MODEL_PATTERN = /^([A-Z][A-Z0-9]{1,15})-([a-z0-9].+)$/;

export function normalizeProviderShortPrefix(prefix: string | null | undefined): string {
  const normalized = String(prefix ?? '')
    .trim()
    .replace(/-+$/, '')
    .toUpperCase();

  return SHORT_PREFIX_PATTERN.test(normalized) ? normalized : '';
}

export function buildProviderScopedModelId(
  provider: { id: string; shortPrefix?: string | null },
  model = ''
): string {
  const shortPrefix = normalizeProviderShortPrefix(provider.shortPrefix);
  if (shortPrefix) {
    return model ? `${shortPrefix}-${model}` : shortPrefix;
  }

  return model ? `${provider.id}:${model}` : provider.id;
}

export interface NormalizedModelSelection {
  model: string;
  providerIdHint?: string;
}

export function normalizeRequestedModelSelection(
  model: string,
  providerIdHint?: string
): NormalizedModelSelection {
  if (providerIdHint || !model) {
    return { model, providerIdHint };
  }

  const separatorIndex = model.indexOf(':');
  if (separatorIndex > 0) {
    const candidateProviderId = model.slice(0, separatorIndex);
    const candidateModel = model.slice(separatorIndex + 1);

    if (UUID_PATTERN.test(candidateProviderId) && candidateModel.length > 0) {
      return {
        model: candidateModel,
        providerIdHint: candidateProviderId,
      };
    }
  }

  if (UUID_PATTERN.test(model)) {
    return {
      model: '',
      providerIdHint: model,
    };
  }

  const prefixedModelMatch = model.match(PREFIX_SCOPED_MODEL_PATTERN);
  if (prefixedModelMatch) {
    return {
      model: prefixedModelMatch[2],
      providerIdHint: prefixedModelMatch[1],
    };
  }

  if (SHORT_PREFIX_PATTERN.test(model)) {
    return {
      model: '',
      providerIdHint: model,
    };
  }

  return { model };
}

/**
 * Strip any provider-scoped prefix (short prefix or UUID prefix) from a
 * model ID, returning just the base model name.
 *
 * Examples:
 *   "DSK-deepseek-chat"      → "deepseek-chat"
 *   "ANTH-claude-sonnet-4"   → "claude-sonnet-4"
 *   "550e8400-...:gpt-4o"    → "gpt-4o"
 *   "gpt-4o"                 → "gpt-4o"
 */
export function stripModelPrefix(model: string): string {
  const normalized = normalizeRequestedModelSelection(model);
  return normalized.model || model;
}