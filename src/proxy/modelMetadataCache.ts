/**
 * In-memory cache of per-model metadata reported by providers' `/models`
 * endpoints, plus per-model overrides written from the management UI.
 *
 * Token budgeting is synchronous (`computeContextBudget` → `modelMaxTokens`),
 * so the real context window has to be available without a DB round-trip.
 * The repository layer populates this cache at startup and after every sync;
 * readers only ever touch the in-memory maps.
 *
 * Two layers are kept apart so a provider sync can replace its reported values
 * wholesale without discarding a user's edits:
 *   - reported: written by the external-provider sync from `/models`
 *   - override: written by the Models dialog in the management UI
 *
 * Effective values read override-first, then reported. Lookups accept either a
 * raw model ID (`gpt-6-astra`) or a provider-scoped one (`CCO-gpt-6-astra`);
 * the short prefix is stripped before lookup.
 */
import { stripModelPrefix } from './modelSelection';

interface CachedModelMetadata {
  /** Raw upstream model ID this row was reported under. */
  modelId: string;
  contextLength: number;
  displayName?: string;
  apiFormat?: 'openai' | 'anthropic';
  /** Provider that reported this model. */
  providerId: string;
}

interface CachedModelOverride {
  /** Raw upstream model ID this row overrides. */
  modelId: string;
  contextLength?: number;
  displayName?: string;
  apiFormat?: 'openai' | 'anthropic';
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  /** Provider this override belongs to. */
  providerId: string;
}

/** Reported rows keyed by provider + lower-cased raw model ID. */
const reportedCache = new Map<string, CachedModelMetadata>();

/** Override rows keyed the same way; always win over reported rows. */
const overrideCache = new Map<string, CachedModelOverride>();

function keyOf(providerId: string, modelId: string): string {
  return `${providerId}::${modelId.trim().toLowerCase()}`;
}

/** All effective entries for a given raw model ID, across every provider. */
function entriesForModel(modelId: string): Array<{ providerId: string; entry: CachedModelMetadata | CachedModelOverride }> {
  const wanted = modelId.trim().toLowerCase();
  const matches: Array<{ providerId: string; entry: CachedModelMetadata | CachedModelOverride }> = [];
  for (const entry of reportedCache.values()) {
    if (entry.modelId === wanted) matches.push({ providerId: entry.providerId, entry });
  }
  for (const entry of overrideCache.values()) {
    if (entry.modelId === wanted) matches.push({ providerId: entry.providerId, entry });
  }
  return matches;
}

/**
 * Replace the cached metadata for one provider.
 *
 * Called after a sync so removals upstream are reflected locally. Rows from
 * other providers are untouched, and each provider keeps its own copy — two
 * gateways exposing the same model ID can report different context windows and
 * wire formats, and conflating them would misroute requests.
 */
export function setProviderModelMetadata(
  providerId: string,
  models: Iterable<{ modelId: string; contextLength?: number; displayName?: string; apiFormat?: string }>
): void {
  // Drop this provider's previous entries first.
  for (const [key, value] of reportedCache) {
    if (value.providerId === providerId) reportedCache.delete(key);
  }

  for (const model of models) {
    if (!model.modelId) continue;

    const contextLength =
      typeof model.contextLength === 'number' && model.contextLength > 0
        ? Math.floor(model.contextLength)
        : 0;

    reportedCache.set(keyOf(providerId, model.modelId), {
      modelId: model.modelId.trim().toLowerCase(),
      contextLength,
      displayName: model.displayName,
      apiFormat: normalizeApiFormat(model.apiFormat),
      providerId,
    });
  }
}

/** Remove every cached entry belonging to a provider (used on delete). */
export function clearProviderModelMetadata(providerId: string): void {
  for (const [key, value] of reportedCache) {
    if (value.providerId === providerId) reportedCache.delete(key);
  }
}

/**
 * Replace the cached overrides for one provider.
 *
 * Called by the overrides repository after every write. Reported rows from
 * other providers (or this provider's own reported rows) are untouched — the
 * two layers are merged at read time.
 */
export function setProviderModelOverrides(
  providerId: string,
  models: Iterable<{
    modelId: string;
    contextLength?: number;
    displayName?: string;
    apiFormat?: string;
    supportsReasoning?: boolean;
    supportsVision?: boolean;
  }>
): void {
  for (const [key, value] of overrideCache) {
    if (value.providerId === providerId) overrideCache.delete(key);
  }

  for (const model of models) {
    if (!model.modelId) continue;

    const contextLength =
      typeof model.contextLength === 'number' && model.contextLength > 0
        ? Math.floor(model.contextLength)
        : undefined;

    overrideCache.set(keyOf(providerId, model.modelId), {
      modelId: model.modelId.trim().toLowerCase(),
      contextLength,
      displayName: model.displayName,
      apiFormat: normalizeApiFormat(model.apiFormat),
      supportsReasoning: model.supportsReasoning,
      supportsVision: model.supportsVision,
      providerId,
    });
  }
}

/** Remove every cached override belonging to a provider (used on delete). */
export function clearProviderModelOverrides(providerId: string): void {
  for (const [key, value] of overrideCache) {
    if (value.providerId === providerId) overrideCache.delete(key);
  }
}

/** Reset the whole cache (tests, or a full re-prime). */
export function resetModelMetadataCache(): void {
  reportedCache.clear();
  overrideCache.clear();
}

/**
 * Reported context window for a model **belonging to a specific provider**.
 * Prefer this over the provider-less variant whenever the caller knows which
 * provider it is describing.
 */
export function getReportedContextLengthForProvider(
  providerId: string,
  modelId: string
): number | undefined {
  if (!providerId || !modelId) return undefined;
  const override = overrideCache.get(keyOf(providerId, modelId));
  if (override && typeof override.contextLength === 'number' && override.contextLength > 0) {
    return override.contextLength;
  }
  const entry = reportedCache.get(keyOf(providerId, modelId));
  return entry && entry.contextLength > 0 ? entry.contextLength : undefined;
}

/** Reported display name for a provider's model, when supplied. */
export function getReportedDisplayNameForProvider(
  providerId: string,
  modelId: string
): string | undefined {
  if (!providerId || !modelId) return undefined;
  const override = overrideCache.get(keyOf(providerId, modelId));
  if (override?.displayName) return override.displayName;
  return reportedCache.get(keyOf(providerId, modelId))?.displayName;
}

/** Reported wire format for a provider's model, when supplied. */
export function getReportedApiFormatForProvider(
  providerId: string,
  modelId: string
): 'openai' | 'anthropic' | undefined {
  if (!providerId || !modelId) return undefined;
  const override = overrideCache.get(keyOf(providerId, modelId));
  if (override?.apiFormat) return override.apiFormat;
  return reportedCache.get(keyOf(providerId, modelId))?.apiFormat;
}

/**
 * Whether the user marked a model as supporting reasoning-effort levels.
 * Returns `undefined` when no override exists, so callers can distinguish
 * "not configured" from an explicit `false`.
 */
export function getModelSupportsReasoningForProvider(
  providerId: string,
  modelId: string
): boolean | undefined {
  if (!providerId || !modelId) return undefined;
  return overrideCache.get(keyOf(providerId, modelId))?.supportsReasoning;
}

/**
 * Whether the user marked a model as processing images itself.
 * Returns `undefined` when no override exists, so callers can distinguish
 * "not configured" from an explicit `false`.
 */
export function getModelSupportsVisionForProvider(
  providerId: string,
  modelId: string
): boolean | undefined {
  if (!providerId || !modelId) return undefined;
  return overrideCache.get(keyOf(providerId, modelId))?.supportsVision;
}

/**
 * Reported context window for a model, across all providers.
 *
 * Used by the synchronous token-budget path, which only has a model name and
 * cannot resolve a provider. Each provider's effective window is computed
 * override-first and the **widest** is returned, so budgeting stays optimistic
 * rather than silently truncating. Callers that know the provider should use
 * {@link getReportedContextLengthForProvider} instead.
 */
export function getReportedContextLength(modelId: string): number | undefined {
  const raw = resolveRawModelId(modelId);
  if (!raw) return undefined;

  // Effective value per provider: an override wins over the reported value.
  const byProvider = new Map<string, number>();
  for (const { providerId, entry } of entriesForModel(raw)) {
    const contextLength = entry.contextLength;
    if (typeof contextLength === 'number' && contextLength > 0) {
      byProvider.set(providerId, contextLength);
    }
  }

  const candidates = [...byProvider.values()];
  if (candidates.length === 0) return undefined;

  return candidates.reduce((widest, value) => Math.max(widest, value), 0);
}

/**
 * Map a possibly provider-scoped ID (`CCO-gpt-6-astra`) back to the raw
 * upstream ID (`gpt-6-astra`) used as the cache key.
 */
function resolveRawModelId(modelId: string): string | undefined {
  if (!modelId) return undefined;
  const trimmed = modelId.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  // Already a raw ID we know about?
  if (entriesForModel(trimmed).length > 0) return trimmed;

  // Otherwise retry with the provider prefix stripped.
  const stripped = stripModelPrefix(modelId).trim().toLowerCase();
  if (stripped.length === 0) return undefined;
  return entriesForModel(stripped).length > 0 ? stripped : undefined;
}

/** Diagnostics: how many models currently carry metadata or overrides. */
export function modelMetadataCacheSize(): number {
  return reportedCache.size + overrideCache.size;
}

function normalizeApiFormat(value: string | undefined): 'openai' | 'anthropic' | undefined {
  return value === 'openai' || value === 'anthropic' ? value : undefined;
}
