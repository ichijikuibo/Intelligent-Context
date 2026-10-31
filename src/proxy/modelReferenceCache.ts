/**
 * In-memory reference catalog of well-known models.
 *
 * Providers frequently do not report anything beyond a bare model list, yet the
 * IDE extension needs a real context window to budget against. A public model
 * catalog (OpenRouter's `/api/v1/models`) carries that information for most
 * popular models, so it is synced into `model_reference` and mirrored here.
 *
 * This is a **default source only**. Resolution order everywhere is:
 *
 *   user override  >  provider-reported  >  reference  >  built-in heuristic
 *
 * Lookups are deliberately forgiving about naming: OpenRouter keys models as
 * `vendor/model` with optional variant suffixes (`:free`, `:batch`), while a
 * local provider usually stores just the bare model ID.
 */
import { stripModelPrefix } from './modelSelection';

/** Which catalog a row came from. */
export const MODEL_REFERENCE_SOURCE_OPENROUTER = 'openrouter';

export interface ModelReferenceDefaults {
  /** Normalized model ID this row was stored under. */
  modelId: string;
  /** Catalog the row came from. */
  source: string;
  /** Vendor / publisher, when the catalog reports one. */
  vendor?: string;
  /** Human-readable name reported by the catalog. */
  displayName?: string;
  /** Maximum context window in tokens. */
  contextLength?: number;
  /** Provider ceiling for a single response, in tokens (informational). */
  maxOutputTokens?: number;
  /** Whether the catalog lists image as an input modality. */
  supportsVision?: boolean;
  /** Whether the catalog advertises reasoning-effort parameters. */
  supportsReasoning?: boolean;
}

/** Rows keyed by their full normalized ID (`vendor/model`). */
const byFullId = new Map<string, ModelReferenceDefaults>();

/** Rows keyed by the last path segment (`model`), first writer wins. */
const byShortId = new Map<string, ModelReferenceDefaults>();

/**
 * Normalize a model ID for lookup.
 *
 * - lower-cases and trims
 * - drops OpenRouter variant suffixes (`:free`, `:batch`, …)
 * - drops a provider-scoped prefix (`CCO-deepseek-v4` → `deepseek-v4`)
 */
export function normalizeReferenceModelId(modelId: string): string {
  const trimmed = stripModelPrefix(String(modelId ?? '').trim()).toLowerCase();
  if (!trimmed) return '';

  const colon = trimmed.indexOf(':');
  const withoutVariant = colon > 0 ? trimmed.slice(0, colon) : trimmed;
  return withoutVariant.trim();
}

/** The bare model name, without the vendor path. */
export function shortReferenceModelId(normalizedId: string): string {
  const slash = normalizedId.lastIndexOf('/');
  return slash >= 0 ? normalizedId.slice(slash + 1) : normalizedId;
}

/** Replace the cached catalog for one source. */
export function setModelReference(source: string, rows: Iterable<ModelReferenceDefaults>): void {
  for (const [key, value] of byFullId) {
    if (value.source === source) byFullId.delete(key);
  }
  for (const [key, value] of byShortId) {
    if (value.source === source) byShortId.delete(key);
  }

  for (const row of rows) {
    const modelId = normalizeReferenceModelId(row.modelId);
    if (!modelId) continue;

    const entry: ModelReferenceDefaults = { ...row, modelId, source };
    byFullId.set(modelId, entry);

    // Short IDs collide across vendors (e.g. `openai/gpt-4o` and a reseller's
    // `reseller/gpt-4o`). Keep the first row seen so the mapping is stable.
    const shortId = shortReferenceModelId(modelId);
    if (!byShortId.has(shortId)) {
      byShortId.set(shortId, entry);
    }
  }
}

/** Remove every cached row for a source. */
export function clearModelReference(source: string): void {
  for (const [key, value] of byFullId) {
    if (value.source === source) byFullId.delete(key);
  }
  for (const [key, value] of byShortId) {
    if (value.source === source) byShortId.delete(key);
  }
}

/** Reset the whole cache (tests, or a full re-prime). */
export function resetModelReferenceCache(): void {
  byFullId.clear();
  byShortId.clear();
}

/**
 * Minimum length a name must have before it may participate in a fuzzy
 * (suffix) match. Short names like `o1` or `turbo` — and generic fragments like
 * `preview` — match far too much. Exact matches are unaffected by this.
 */
const MIN_FUZZY_LENGTH = 8;

/**
 * How many characters two names may differ by before a suffix match is
 * considered a different model rather than a variant of the same one.
 * Covers vendor prefixes and dated snapshots.
 */
const MAX_FUZZY_DISTANCE = 32;

/**
 * Look up reference defaults for a model ID.
 *
 * Catalog keys look like `deepseek/deepseek-v4.1-flash` while a provider
 * usually stores only the trailing part (`deepseek-v4.1-flash`), so matching
 * runs in tiers, most specific first:
 *
 *   1. exact full ID   `deepseek/deepseek-v4.1-flash`
 *   2. exact bare name `deepseek-v4.1-flash`
 *   3. suffix overlap  request `deepseek-flash-v4.1` → `…/deepseek-flash-v4.1`
 *   4. snapshot tail   request `deepseek-v4.1-flash` → `…-20260910`
 *
 * Tiers 3 and 4 pick the **closest** match (smallest length difference) and
 * never bridge a non-numeric suffix, so `gpt-4o` cannot inherit `gpt-4o-mini`'s
 * defaults and `gpt-5` cannot inherit `gpt-5.5`'s.
 */
export function getModelReference(modelId: string): ModelReferenceDefaults | undefined {
  const normalized = normalizeReferenceModelId(modelId);
  if (!normalized) return undefined;

  const exact = byFullId.get(normalized);
  if (exact) return exact;

  const wanted = shortReferenceModelId(normalized);
  const short = byShortId.get(wanted);
  if (short) return short;

  return findClosestBySuffix(wanted);
}

/** Every cached row whose name could describe `modelId`, closest match first. */
export function listModelReferenceMatches(modelId: string): ModelReferenceDefaults[] {
  const normalized = normalizeReferenceModelId(modelId);
  if (!normalized) return [];

  const wanted = shortReferenceModelId(normalized);
  const matches: ModelReferenceDefaults[] = [];
  const seen = new Set<string>();

  const push = (entry: ModelReferenceDefaults | undefined): void => {
    if (!entry || seen.has(entry.modelId)) return;
    seen.add(entry.modelId);
    matches.push(entry);
  };

  push(byFullId.get(normalized));
  push(byShortId.get(wanted));

  const fuzzy = [...byShortId.entries()]
    .map(([shortId, entry]) => ({ entry, distance: matchDistance(shortId, wanted) }))
    .filter((candidate): candidate is { entry: ModelReferenceDefaults; distance: number } =>
      candidate.distance !== undefined
    )
    .sort((a, b) => a.distance - b.distance);

  for (const candidate of fuzzy) {
    push(candidate.entry);
  }

  return matches;
}

/**
 * Distance between two names that describe the same model, or `undefined` when
 * they do not.
 *
 * Only three shapes count, and each is deliberately narrow:
 *
 *   - the longer name extends the shorter one by nothing but a date/number
 *     snapshot (`deepseek-v4.1-flash` ↔ `…-20260910`);
 *   - the request is a longer form of the catalog name (`deepseek-ai-gpt-4o`),
 *     which is how vendor-prefixed provider IDs are matched;
 *   - the request is a trailing fragment of the catalog name
 *     (`flash-v4.1` → `deepseek-flash-v4.1`).
 *
 * A plain prefix is never enough: `gpt-4o` must not inherit `gpt-4o-mini`'s
 * defaults, nor `gpt-5` those of `gpt-5.5`.
 */
function matchDistance(candidate: string, wanted: string): number | undefined {
  if (candidate === wanted) return 0;
  if (candidate.length < MIN_FUZZY_LENGTH || wanted.length < MIN_FUZZY_LENGTH) {
    return undefined;
  }

  // A dated snapshot in either direction is the same model: the catalog may
  // carry `…-20260910` while the provider stores the base name, or the other
  // way round.
  const snapshot =
    snapshotExtension(candidate, wanted) ?? snapshotExtension(wanted, candidate);
  if (snapshot !== undefined) return snapshot;

  if (wanted.endsWith(candidate)) {
    const distance = wanted.length - candidate.length;
    return distance <= MAX_FUZZY_DISTANCE ? distance : undefined;
  }

  if (candidate.endsWith(wanted)) {
    const distance = candidate.length - wanted.length;
    return distance <= MAX_FUZZY_DISTANCE ? distance : undefined;
  }

  return undefined;
}

/**
 * Length of the extra part when `longer` extends `shorter` by nothing more than
 * a date/number snapshot tag (`deepseek-v4.1-flash` → `…-20260910`).
 */
function snapshotExtension(longer: string, shorter: string): number | undefined {
  if (!longer.startsWith(shorter)) return undefined;

  const remainder = longer.slice(shorter.length);
  if (!/^-\d{4,}$/.test(remainder)) return undefined;
  return remainder.length;
}

function findClosestBySuffix(wanted: string): ModelReferenceDefaults | undefined {
  let best: ModelReferenceDefaults | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [shortId, entry] of byShortId) {
    const distance = matchDistance(shortId, wanted);
    if (distance === undefined) continue;

    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }

  return best;
}

/** Diagnostics: how many reference rows are cached. */
export function modelReferenceCacheSize(): number {
  return byFullId.size;
}
