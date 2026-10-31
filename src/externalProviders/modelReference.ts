/**
 * Syncs a public model catalog (OpenRouter's `/api/v1/models`) into the local
 * reference table.
 *
 * Many providers only report a bare list of model IDs, but the IDE extension
 * needs a real context window to budget against and the vision picker needs to
 * know which models can see images. OpenRouter publishes both for most popular
 * models, so the catalog is mirrored into `model_reference` and used purely as
 * a **default** — a user override or a value the provider reports itself always
 * wins.
 */
import axios from 'axios';
import { modelReferenceRepo } from '../db/repositories/modelReference';
import {
  MODEL_REFERENCE_SOURCE_OPENROUTER,
  type ModelReferenceDefaults,
} from '../proxy/modelReferenceCache';
import { getSystemConfigCacheValue, setSystemConfigCacheValue } from '../config/systemConfigCache';
import { logger } from '../utils/logger';

export { MODEL_REFERENCE_SOURCE_OPENROUTER };

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const SYNC_TIMEOUT_MS = 30_000;

/** `system_config` key holding the enable/disable flag. */
export const MODEL_REFERENCE_ENABLED_KEY = 'modelReferenceSyncEnabled';
/** `system_config` key holding the last successful sync timestamp (ISO string). */
export const MODEL_REFERENCE_LAST_SYNC_KEY = 'modelReferenceLastSyncAt';
/** `system_config` key holding the last sync error, if any. */
export const MODEL_REFERENCE_LAST_ERROR_KEY = 'modelReferenceLastError';

/** Raw shape of one OpenRouter catalog entry (only the fields we consume). */
interface OpenRouterModelEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown };
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
  supported_parameters?: unknown;
  reasoning?: unknown;
}

function toPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Turn one raw catalog entry into a reference row, or `undefined` when the
 * entry carries no ID.
 *
 * Alias rows (`~deepseek/…`) and the router pseudo-models (`openrouter/auto`)
 * are skipped: they describe routing behaviour rather than a real model, so
 * their limits would be misleading.
 */
export function normalizeOpenRouterEntry(entry: OpenRouterModelEntry): ModelReferenceDefaults | undefined {
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id || id.startsWith('~') || id.startsWith('openrouter/')) return undefined;

  const inputModalities = Array.isArray(entry.architecture?.input_modalities)
    ? entry.architecture.input_modalities.filter((value): value is string => typeof value === 'string')
    : [];

  const supportedParameters = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.filter((value): value is string => typeof value === 'string')
    : [];

  const slash = id.indexOf('/');
  const vendor = slash > 0 ? id.slice(0, slash) : undefined;

  return {
    modelId: id,
    source: MODEL_REFERENCE_SOURCE_OPENROUTER,
    vendor,
    displayName: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
    // The top-level window is the model's own limit; the per-provider value can
    // be smaller (a single upstream host may cap it), so prefer the larger one.
    contextLength: toPositiveInt(entry.context_length) ?? toPositiveInt(entry.top_provider?.context_length),
    maxOutputTokens: toPositiveInt(entry.top_provider?.max_completion_tokens),
    supportsVision: inputModalities.includes('image'),
    supportsReasoning:
      supportedParameters.includes('reasoning') ||
      supportedParameters.includes('reasoning_effort') ||
      supportedParameters.includes('include_reasoning') ||
      Boolean(entry.reasoning),
  };
}

export interface ModelReferenceSyncResult {
  ok: boolean;
  count: number;
  error?: string;
}

/** True unless the user has switched the reference sync off. */
export function isModelReferenceSyncEnabled(): boolean {
  const value = getSystemConfigCacheValue(MODEL_REFERENCE_ENABLED_KEY).trim().toLowerCase();
  // Default on: the endpoint is public, key-less and read-only.
  return value !== 'false';
}

export function setModelReferenceSyncEnabled(enabled: boolean): void {
  setSystemConfigCacheValue(MODEL_REFERENCE_ENABLED_KEY, enabled ? 'true' : 'false');
}

/** Metadata for the Settings/Models UI. */
export function getModelReferenceSyncStatus(): {
  enabled: boolean;
  lastSyncAt: string;
  lastError: string;
} {
  return {
    enabled: isModelReferenceSyncEnabled(),
    lastSyncAt: getSystemConfigCacheValue(MODEL_REFERENCE_LAST_SYNC_KEY),
    lastError: getSystemConfigCacheValue(MODEL_REFERENCE_LAST_ERROR_KEY),
  };
}

/**
 * Fetch the catalog and replace the stored reference rows.
 *
 * A failure leaves the previous rows in place, so a network blip never costs
 * the user their defaults.
 */
export async function syncModelReference(): Promise<ModelReferenceSyncResult> {
  let payload: { data?: OpenRouterModelEntry[] };

  try {
    const response = await axios.get(OPENROUTER_MODELS_URL, {
      timeout: SYNC_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });
    payload = response.data;
  } catch (err) {
    const message = axios.isAxiosError(err)
      ? `${err.message}${err.response?.status ? ` (HTTP ${err.response.status})` : ''}`
      : String(err);

    setSystemConfigCacheValue(MODEL_REFERENCE_LAST_ERROR_KEY, message);
    logger.warn('Model reference sync failed', { error: message });
    return { ok: false, count: 0, error: message };
  }

  if (!payload || !Array.isArray(payload.data)) {
    const message = 'Unexpected response format from the model catalog endpoint';
    setSystemConfigCacheValue(MODEL_REFERENCE_LAST_ERROR_KEY, message);
    logger.warn('Model reference sync failed', { error: message });
    return { ok: false, count: 0, error: message };
  }

  const rows: ModelReferenceDefaults[] = [];
  for (const entry of payload.data) {
    const normalized = normalizeOpenRouterEntry(entry);
    if (normalized) rows.push(normalized);
  }

  try {
    const count = await modelReferenceRepo.replaceSource(MODEL_REFERENCE_SOURCE_OPENROUTER, rows);
    setSystemConfigCacheValue(MODEL_REFERENCE_LAST_SYNC_KEY, new Date().toISOString());
    setSystemConfigCacheValue(MODEL_REFERENCE_LAST_ERROR_KEY, '');
    logger.info('Model reference synced', { source: MODEL_REFERENCE_SOURCE_OPENROUTER, count });
    return { ok: true, count };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setSystemConfigCacheValue(MODEL_REFERENCE_LAST_ERROR_KEY, message);
    logger.error('Model reference could not be stored', { error: message });
    return { ok: false, count: 0, error: message };
  }
}

/** Sync only when the feature is enabled (used by the scheduler). */
export async function syncModelReferenceIfEnabled(): Promise<void> {
  if (!isModelReferenceSyncEnabled()) return;
  await syncModelReference();
}
