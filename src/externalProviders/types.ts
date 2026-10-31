import type { ProviderType } from '../db/repositories/providers';

/** Definition of an external model provider that auto-creates and manages
 *  one or more internal providers (OpenAI-compatible or Anthropic-compatible). */
export interface ExternalProviderDef {
  /** Unique key, e.g. "opencode-go" — stored in external_providers.provider_key */
  key: string;
  /** Human-readable name used as the default name when creating the DB record */
  displayName: string;
  /** Locale key for the human-readable name shown in the UI, e.g. "externalProvider.anthropic.displayName" */
  displayNameKey: string;
  /** Locale key for the description shown in the UI, e.g. "externalProvider.anthropic.description" */
  descriptionKey: string;
  /** Base URL for the provider's API (e.g. https://opencode.ai/zen/go/v1) */
  baseUrl: string;
  /** The /models endpoint path relative to baseUrl */
  modelsPath: string;
  /**
   * Build the authentication headers for requests to this provider's API.
   * Different providers use different auth schemes
   * (e.g. OpenAI uses "Authorization: Bearer <key>",
   * Anthropic uses "X-Api-Key: <key>").
   */
  buildAuthHeaders: (apiKey: string) => Record<string, string>;
  /**
   * Each entry describes an auto-created internal provider.
   * One external provider can create multiple internal providers
   * (e.g. opencode Go creates both an OpenAI and an Anthropic provider).
   */
  subProviders: ExternalSubProviderDef[];
  /**
   * Classify a model ID returned by the /models endpoint into the
   * appropriate sub-provider. Returns the index into `subProviders`.
   * Return -1 to skip this model.
   *
   * Newer providers expose metadata per entry (context length, supported
   * endpoints); those receive the raw entry as a second argument and may
   * classify on it instead of the ID.
   */
  classifyModel: (modelId: string, entry?: ExternalModelListEntry) => number;
  /**
   * Optional: transform the model ID before storing it.
   * Useful if the upstream model names need mapping.
   */
  transformModelId?: (modelId: string) => string;
  /**
   * Optional: normalize a raw /models entry into the fields the sync persists.
   *
   * Providers whose model lists carry richer metadata (e.g. CommandCode's
   * `context_length` / `supported_endpoints`, or opencode v2's `Model.Info`)
   * implement this so the context window can be stored per model. Providers
   * that only return the bare OpenAI triple can omit it and rely on
   * `transformModelId` + `classifyModel` instead.
   *
   * Return `null` to skip the entry.
   */
  normalizeModel?: (entry: ExternalModelListEntry) => NormalizedExternalModel | null;
}

/** Metadata the sync persists for a single model. */
export interface ProviderModelMetadata {
  /** Raw context window reported by the upstream provider, in tokens. */
  contextLength?: number;
  /** Human-readable model name reported upstream. */
  displayName?: string;
  /** Wire protocol the upstream advertises for this model. */
  apiFormat?: 'openai' | 'anthropic';
}

/** A raw /models entry after provider-specific normalization. */
export interface NormalizedExternalModel {
  /** Model ID used for routing (after any `transformModelId` mapping). */
  id: string;
  /** Index into `subProviders`; -1 to skip. */
  bucketIndex: number;
  /** Metadata to persist alongside the model. */
  metadata?: ProviderModelMetadata;
}

/** Describes one auto-created internal provider within an external provider. */
export interface ExternalSubProviderDef {
  /** Type of internal provider to create */
  type: ProviderType;
  /** Short prefix for the auto-created provider, e.g. "OCO" for opencode OpenAI.
   *  If multiple accounts are added, a number suffix is appended (OCO2, OCO3…). */
  prefix: string;
  /** Human-readable suffix for the auto-created provider name,
   *  e.g. " (OpenAI)" → "opencode Go (OpenAI)" */
  nameSuffix: string;
}

/** Response from an external provider's /models endpoint. */
export interface ExternalModelListEntry {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  /** Human-readable model name (CommandCode, OpenRouter-style listings). */
  name?: string;
  /** Maximum context window in tokens, as reported upstream. */
  context_length?: number;
  /**
   * Wire endpoints the model accepts, e.g.
   * `['/chat/completions']`, `['/messages']`, `['/chat/completions', '/responses']`.
   */
  supported_endpoints?: string[];
}

export interface ExternalModelListResponse {
  object: string;
  data: ExternalModelListEntry[];
}

/**
 * Classify a model by the wire endpoints it advertises.
 *
 * Returns `undefined` when the entry carries no usable endpoint list so
 * callers can fall back to ID-based heuristics.
 */
export function classifyByEndpoint(
  entry: ExternalModelListEntry
): 'openai' | 'anthropic' | undefined {
  const endpoints = entry.supported_endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) return undefined;

  if (endpoints.includes('/messages')) return 'anthropic';
  if (endpoints.includes('/chat/completions') || endpoints.includes('/responses')) {
    return 'openai';
  }
  return undefined;
}

/** Extract a positive context length from a raw entry, if one is present. */
export function contextLengthFromEntry(
  entry: ExternalModelListEntry
): number | undefined {
  const value = entry.context_length;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
