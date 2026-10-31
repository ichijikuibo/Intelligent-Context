import { Router } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { externalProvidersRepo } from '../../db/repositories/externalProviders';
import { providersRepo } from '../../db/repositories/providers';
import {
  providerModelMetadataRepo,
  type ProviderModelMetadataInput,
} from '../../db/repositories/providerModelMetadata';
import {
  listExternalProviderDefs,
  getExternalProviderDef,
} from '../../externalProviders/registry';
import type {
  ExternalModelListResponse,
  ExternalSubProviderDef,
} from '../../externalProviders/types';
import { formatZodError, t } from '../../i18n';
import { logger } from '../../utils/logger';
import { applyUpstreamRequestMiddleware } from '../../proxy/requestMiddleware';

const CreateSchema = z.object({
  providerKey: z.string().min(1, 'Provider key is required'),
  apiKey: z.string().min(1, 'API key is required'),
});

const UpdateSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
});

function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return '••••••••';
  return '••••' + key.slice(-4);
}

/**
 * Strip the numeric collision suffix from an assigned prefix.
 * "OCO2" → "OCO", "CCO" → "CCO".
 */
function basePrefix(prefix: string): string {
  const normalized = String(prefix ?? '').trim().toUpperCase();
  return normalized.replace(/\d+$/, '');
}

export function createExternalProvidersRouter(): Router {
  const router = Router();

  // ── List available external provider definitions (for the "Add" UI) ────
  router.get('/definitions', (req, res) => {
    const defs = listExternalProviderDefs().map((def) => ({
      key: def.key,
      displayName: t(req, def.displayNameKey),
      description: t(req, def.descriptionKey),
      subProviders: def.subProviders.map((sub: ExternalSubProviderDef) => ({
        type: sub.type,
        prefix: sub.prefix,
        nameSuffix: sub.nameSuffix,
      })),
    }));
    res.json(defs);
  });

  // ── List all configured external providers ──────────���───────────────────
  router.get('/', async (req, res) => {
    const providers = await externalProvidersRepo.findAll();
    res.json(
      providers.map((ep) => ({
        ...ep,
        apiKey: maskApiKey(ep.apiKey),
      }))
    );
  });

  // ── Create an external provider ─────────────────────────────────────────
  router.post('/', async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const def = getExternalProviderDef(parsed.data.providerKey);
    if (!def) {
      res.status(400).json({ error: t(req, 'api.error.unknownExternalProvider') });
      return;
    }

    // Check no duplicate
    const existing = await externalProvidersRepo.findByProviderKey(parsed.data.providerKey);
    if (existing) {
      res.status(409).json({ error: t(req, 'api.error.externalProviderAlreadyExists') });
      return;
    }

    try {
      const created = await externalProvidersRepo.create(parsed.data);

      // Immediately sync models in the background
      syncExternalProviderModels(created.id).catch((err) => {
        logger.error('Initial sync failed for external provider', {
          id: created.id,
          error: String(err),
        });
      });

      res.status(201).json({
        ...created,
        apiKey: maskApiKey(created.apiKey),
      });
    } catch (err) {
      logger.error('Failed to create external provider', { error: String(err) });
      res.status(500).json({ error: t(req, 'api.error.internal') });
    }
  });

  // ── Get one external provider ───────────────────────────────────────────
  router.get('/:id', async (req, res) => {
    const provider = await externalProvidersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }
    res.json({
      ...provider,
      apiKey: maskApiKey(provider.apiKey),
    });
  });

  // ── Update API key ──────────────────────────────────────────────────────
  router.put('/:id', async (req, res) => {
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const updated = await externalProvidersRepo.updateApiKey(
      req.params.id,
      parsed.data.apiKey
    );
    if (!updated) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    res.json({
      ...updated,
      apiKey: maskApiKey(updated.apiKey),
    });
  });

  // ── Get sub-providers for an external provider ──────────────────────────
  router.get('/:id/sub-providers', async (req, res) => {
    const provider = await externalProvidersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    const subs = await externalProvidersRepo.findSubProviders(provider.id);

    // Attach the metadata synced from the provider's /models endpoint so the
    // UI can show a real context window per model rather than a bare list.
    const result = [];
    for (const p of subs) {
      const metadata = await providerModelMetadataRepo.findByProvider(p.id);
      result.push({
        ...p,
        apiKey: providersRepo.maskKey(p.apiKey),
        modelMetadata: metadata.map((m) => ({
          modelId: m.modelId,
          contextLength: m.contextLength ?? null,
          displayName: m.displayName ?? null,
          apiFormat: m.apiFormat ?? null,
        })),
      });
    }

    res.json(result);
  });

  // ── Trigger model sync ──────────────────────────────────────────────────
  router.post('/:id/sync', async (req, res) => {
    const provider = await externalProvidersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    try {
      const result = await syncExternalProviderModels(provider.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: String(err),
      });
    }
  });

  // ── Test connection ─────────────────────────────────────────────────────
  router.post('/:id/test', async (req, res) => {
    const provider = await externalProvidersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    const def = getExternalProviderDef(provider.providerKey);
    if (!def) {
      res.status(400).json({ error: t(req, 'api.error.unknownExternalProvider') });
      return;
    }

    try {
      const url = def.baseUrl.replace(/\/$/, '') + def.modelsPath;
      const start = Date.now();
      await axios.get(url, {
        headers: applyUpstreamRequestMiddleware(url, def.buildAuthHeaders(provider.apiKey), {
          jobKey: `provider-test:${provider.id}`,
        }),
        timeout: 15_000,
      });
      const latencyMs = Date.now() - start;
      res.json({ ok: true, latencyMs });
    } catch (err) {
      const status = axios.isAxiosError(err) ? (err.response?.status ?? 0) : 0;
      const message = axios.isAxiosError(err)
        ? `${err.message}${status ? ` (HTTP ${status})` : ''}`
        : String(err);
      res.json({ ok: false, error: message });
    }
  });

  // ── Delete ──────────────────────────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    const provider = await externalProvidersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    await externalProvidersRepo.delete(req.params.id);
    res.status(204).end();
  });

  return router;
}

// ── Model Sync Logic ────────────────────────────────────────────────────────

/**
 * Fetch models from an external provider's /models endpoint and update
 * the linked internal providers.
 */
export async function syncExternalProviderModels(
  externalProviderId: string
): Promise<{ ok: boolean; syncedCount: number; error?: string }> {
  const extProvider = await externalProvidersRepo.findById(externalProviderId);
  if (!extProvider) {
    return { ok: false, syncedCount: 0, error: 'External provider not found' };
  }

  const def = getExternalProviderDef(extProvider.providerKey);
  if (!def) {
    return { ok: false, syncedCount: 0, error: 'Unknown provider definition' };
  }

  // Fetch models from the upstream API
  const url = def.baseUrl.replace(/\/$/, '') + def.modelsPath;
  let response: ExternalModelListResponse;
  try {
    const res = await axios.get(url, {
      headers: applyUpstreamRequestMiddleware(url, def.buildAuthHeaders(extProvider.apiKey), {
        jobKey: `provider-sync:${extProvider.id}`,
      }),
      timeout: 30_000,
    });
    response = res.data;
  } catch (err) {
    const message = axios.isAxiosError(err)
      ? `${err.message}${err.response?.status ? ` (HTTP ${err.response.status})` : ''}`
      : String(err);
    await externalProvidersRepo.updateSyncStatus(externalProviderId, 'error', message);
    return { ok: false, syncedCount: 0, error: message };
  }

  if (!response?.data || !Array.isArray(response.data)) {
    const msg = 'Unexpected response format from /models endpoint';
    await externalProvidersRepo.updateSyncStatus(externalProviderId, 'error', msg);
    return { ok: false, syncedCount: 0, error: msg };
  }

  // Classify models into sub-provider buckets, collecting per-model metadata
  // when the upstream advertises it (context length, display name, wire format).
  const buckets = new Map<number, string[]>();
  const metadataByBucket = new Map<number, ProviderModelMetadataInput[]>();

  const addToBucket = (
    bucketIndex: number,
    modelId: string,
    metadata?: Omit<ProviderModelMetadataInput, 'modelId'>
  ): void => {
    if (!buckets.has(bucketIndex)) {
      buckets.set(bucketIndex, []);
      metadataByBucket.set(bucketIndex, []);
    }
    buckets.get(bucketIndex)!.push(modelId);
    metadataByBucket.get(bucketIndex)!.push({ ...metadata, modelId });
  };

  for (const entry of response.data) {
    // Providers with rich catalogs normalize the raw entry themselves so the
    // model ID mapping and the metadata extraction stay in one place.
    if (def.normalizeModel) {
      const normalized = def.normalizeModel(entry);
      if (!normalized) continue;

      const transformedId = def.transformModelId
        ? def.transformModelId(normalized.id)
        : normalized.id;
      const bucketIndex = normalized.bucketIndex;
      if (bucketIndex < 0 || bucketIndex >= def.subProviders.length) continue;

      addToBucket(bucketIndex, transformedId, normalized.metadata
        ? {
            contextLength: normalized.metadata.contextLength,
            displayName: normalized.metadata.displayName,
            apiFormat: normalized.metadata.apiFormat,
          }
        : undefined);
      continue;
    }

    const modelId = entry.id;
    if (!modelId) continue;

    const transformedId = def.transformModelId ? def.transformModelId(modelId) : modelId;
    const bucketIndex = def.classifyModel(transformedId, entry);

    if (bucketIndex < 0 || bucketIndex >= def.subProviders.length) continue;

    addToBucket(bucketIndex, transformedId);
  }

  // Update each internal sub-provider with its models
  const subProviders = await externalProvidersRepo.findSubProviders(externalProviderId);
  let syncedCount = 0;

  for (const sub of subProviders) {
    // Match the internal provider to its definition. The prefix is only used
    // to disambiguate when several sub-providers share a wire type; when a
    // desired prefix was already taken it gets a numeric suffix (OCO → OCO2),
    // so compare the base prefix and ignore that suffix.
    const candidates = def.subProviders
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => s.type === sub.type);
    const defIndex = candidates.length > 0
      ? (candidates.find(({ s }) => basePrefix(s.prefix) === basePrefix(sub.shortPrefix ?? '')) ?? candidates[0]).index
      : -1;
    if (defIndex < 0) continue;

    const models = buckets.get(defIndex) ?? [];
    if (models.length > 0) {
      await providersRepo.update(sub.id, {
        models: models.join(','),
      });
      syncedCount += models.length;
    }

    // Persist metadata even when the provider reported no context lengths, so
    // refreshed display names and formats stay in sync with the model list.
    const metadata = metadataByBucket.get(defIndex) ?? [];
    await providerModelMetadataRepo.replaceForProvider(sub.id, metadata);
  }

  await externalProvidersRepo.updateSyncStatus(externalProviderId, 'success');
  logger.info('External provider models synced', {
    provider: extProvider.name,
    modelCount: syncedCount,
  });

  return { ok: true, syncedCount };
}

/**
 * Sync all enabled external providers. Called by the scheduler.
 */
export async function syncAllExternalProviders(): Promise<void> {
  const all = await externalProvidersRepo.findAll();
  for (const ep of all) {
    if (!ep.isEnabled) continue;
    try {
      await syncExternalProviderModels(ep.id);
    } catch (err) {
      logger.error('Background sync failed for external provider', {
        id: ep.id,
        name: ep.name,
        error: String(err),
      });
    }
  }
}
