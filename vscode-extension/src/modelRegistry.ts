/**
 * Fetches, caches, and describes the models offered by the Intelligent Context
 * proxy.
 *
 * The proxy's `/v1/models` endpoint already disambiguates duplicate model IDs
 * across providers with a provider short prefix (for example `OCO-deepseek-v4`
 * from opencode Go and `DSK-deepseek-v4` from DeepSeek direct), so two providers
 * can expose the same underlying model and the user picks between them.
 */
import * as vscode from 'vscode';
import type { ConnectionStore } from './connection';
import { listModels, ProxyClientError } from './proxyClient';
import type { ProxyModelEntry } from './types';

/** Conservative fallbacks when the proxy does not report sizes. */
const FALLBACK_CONTEXT_WINDOW = 32_000;
const FALLBACK_OUTPUT_TOKENS = 4_096;

/**
 * How long a successful catalog fetch is served from cache before another
 * network round-trip is allowed.
 *
 * VS Code enumerates chat models aggressively — a single chat turn, opening the
 * picker, or our own change notification can each trigger a fresh enumeration.
 * Without a floor between fetches the extension fires a burst of `/v1/models`
 * requests and trips the proxy's rate limiter. User-initiated refreshes bypass
 * this via `refresh(..., force = true)`.
 */
const CACHE_TTL_MS = 60_000;

/** Minimum delay between automatic retries after a failed fetch. */
const FAILURE_BACKOFF_MS = 10_000;

export interface CachedModelList {
  models: ProxyModelEntry[];
  fetchedAt: number;
}

export class ModelRegistry {
  private cached: CachedModelList | undefined;
  private readonly onDidChange = new vscode.EventEmitter<void>();
  /** In-flight fetch, so a burst of callers shares one network request. */
  private inFlight: Promise<ProxyModelEntry[]> | undefined;
  /** Identity of the last catalog we notified listeners about. */
  private lastSignature: string | undefined;
  /** When the last fetch failed, used to back off before retrying. */
  private lastFailureAt = 0;

  readonly onDidChangeModels = this.onDidChange.event;

  constructor(private readonly connections: ConnectionStore) {}

  /** Cached models, or undefined when never successfully fetched. */
  getCached(): CachedModelList | undefined {
    return this.cached;
  }

  /**
   * Fetch the model list from the proxy.
   *
   * `silent` mirrors the old contract: on failure, a silent refresh returns the
   * previous cache when one exists so background callers never interrupt the
   * user just to report an offline proxy, while a non-silent refresh surfaces
   * the error so a user-invoked refresh can show a message.
   *
   * Three guard rails keep a single chat turn from hammering `/v1/models`:
   *   - a successful list is served from cache for `CACHE_TTL_MS`;
   *   - concurrent callers share one in-flight request;
   *   - `onDidChangeModels` fires only when the catalog actually changes, so a
   *     re-enumeration triggered by our own change event cannot loop.
   *
   * Pass `force = true` for user-initiated refreshes to bypass the cache TTL
   * and the failure backoff.
   */
  async refresh(silent: boolean, force = false): Promise<ProxyModelEntry[]> {
    const now = Date.now();

    if (!force) {
      // Serve a fresh-enough cache instead of re-querying the proxy. This is
      // what breaks the re-enumeration loop: after we notify VS Code that the
      // catalog changed it asks again, and this returns instantly.
      if (this.cached && now - this.cached.fetchedAt < CACHE_TTL_MS) {
        return this.cached.models;
      }

      // After a failure, don't retry on behalf of every caller at once.
      if (now - this.lastFailureAt < FAILURE_BACKOFF_MS) {
        if (this.cached) return this.cached.models;
        throw new ProxyClientError(
          'The Intelligent Context proxy could not be reached. Retrying shortly.',
        );
      }
    }

    // Coalesce a burst of concurrent refreshes into a single network request.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.runFetch(silent).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runFetch(silent: boolean): Promise<ProxyModelEntry[]> {
    const { baseUrl, apiKey } = await this.connections.resolve();

    try {
      const models = await listModels(baseUrl, apiKey);
      this.lastFailureAt = 0;

      // Only notify when the catalog really changed. Firing on every successful
      // fetch would make VS Code re-enumerate the list, which calls straight
      // back into refresh() — an endless request loop. Set the cache before
      // firing so a re-entrant caller is served from it.
      const signature = signatureOf(models);
      const changed = signature !== this.lastSignature;
      this.lastSignature = signature;
      this.cached = { models, fetchedAt: Date.now() };
      if (changed) this.onDidChange.fire();

      return models;
    } catch (error) {
      this.lastFailureAt = Date.now();
      if (silent && this.cached) {
        return this.cached.models;
      }
      throw error;
    }
  }

  /** Human-readable message for a failed refresh, without leaking the API key. */
  static describeError(error: unknown): string {
    if (error instanceof ProxyClientError) {
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** Reset the cache (used when the base URL or API key changes). */
  invalidate(): void {
    this.cached = undefined;
    this.onDidChange.fire();
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}

/**
 * Stable identity for a model catalog, used to decide whether a refresh should
 * notify listeners. Covers the fields that affect what VS Code displays and
 * sends, so an identical list never produces a redundant change event.
 */
function signatureOf(models: readonly ProxyModelEntry[]): string {
  return models
    .map((entry) =>
      [
        entry.id,
        entry.model_id ?? '',
        entry.display_name ?? '',
        entry.api_format ?? '',
        entry.context_window ?? '',
        entry.supports_reasoning ? '1' : '0',
        entry.supports_vision ? '1' : '0',
      ].join('\u0000'),
    )
    .join('\u0001');
}

/**
 * The model identifier to send to the proxy when requesting a catalog entry.
 *
 * This is the provider-scoped `id` (e.g. `CCO-deepseek-v4`), which the proxy
 * parses back into a provider hint. `display_name` is a human label prefixed
 * with the provider name and is **not** a valid wire model, so it must never be
 * sent upstream.
 */
export function resolveWireModel(entry: ProxyModelEntry): string {
  return entry.id || entry.model_id || '';
}

/**
 * Find the catalog entry a chat request refers to.
 *
 * VS Code hands back the `id` we advertised, but a re-sync can replace scoped
 * IDs, so fall back to the raw model ID and then the display label.
 */
export function findModelEntry(
  models: readonly ProxyModelEntry[],
  id: string,
): ProxyModelEntry | undefined {
  return models.find((entry) => entry.id === id)
    ?? models.find((entry) => entry.model_id === id)
    ?? models.find((entry) => entry.display_name === id);
}

/** Compute the token limits advertised to VS Code for a catalog entry. */
export function resolveTokenLimits(entry: ProxyModelEntry): {
  maxInputTokens: number;
  maxOutputTokens: number;
  contextWindow: number;
} {
  const override = vscode.workspace
    .getConfiguration('intelligentContext')
    .get<number>('maxOutputTokensOverride', 0);

  const contextWindow =
    typeof entry.context_window === 'number' && entry.context_window > 0
      ? entry.context_window
      : FALLBACK_CONTEXT_WINDOW;

  const maxOutputTokens =
    typeof override === 'number' && override > 0
      ? override
      : typeof entry.max_output_tokens === 'number' && entry.max_output_tokens > 0
        ? entry.max_output_tokens
        : FALLBACK_OUTPUT_TOKENS;

  const reportedInput =
    typeof entry.max_input_tokens === 'number' && entry.max_input_tokens > 0
      ? entry.max_input_tokens
      : contextWindow - maxOutputTokens;

  // Never advertise a budget that exceeds the window minus the output reserve.
  const maxInputTokens = Math.max(1, Math.min(reportedInput, contextWindow - maxOutputTokens));

  return { maxInputTokens, maxOutputTokens, contextWindow };
}

/**
 * Secondary picker line. The model name already leads with the provider, so
 * this shows the raw upstream model ID plus the wire format instead of
 * repeating the provider name.
 */
export function describeProvider(entry: ProxyModelEntry): string {
  const format = entry.api_format === 'anthropic' ? 'Anthropic format' : 'OpenAI format';
  return `${entry.model_id ?? entry.id} · ${format}`;
}
