import { Router } from 'express';
import { z } from 'zod';
import {
  hasModelAccess,
  hasUnrestrictedModelAccess,
  modelGrantMatches,
  normalizeModelGrants,
  requireRole,
} from '../../auth/context';
import { providersRepo } from '../../db/repositories/providers';
import { usersRepo } from '../../db/repositories/users';
import { providerModelMetadataRepo } from '../../db/repositories/providerModelMetadata';
import { modelOverridesRepo } from '../../db/repositories/modelOverrides';
import { parseModels, type ProviderConfig } from '../../db/schema';
import { modelMaxTokens } from '../../context/budget';
import { buildProviderScopedModelId, normalizeProviderShortPrefix } from '../../proxy/modelSelection';
import { getModelReference } from '../../proxy/modelReferenceCache';
import { formatZodError, t } from '../../i18n';

const ApiFormatSchema = z.enum(['openai', 'anthropic']);

const ContextLengthSchema = z
  .number()
  .int('Context length must be a whole number')
  .positive('Context length must be greater than zero')
  .max(100_000_000, 'Context length is unrealistically large');

const AddModelSchema = z.object({
  providerId: z.string().min(1, 'Provider is required'),
  modelId: z.string().trim().min(1, 'Model ID is required'),
  displayName: z.string().trim().optional(),
  contextLength: ContextLengthSchema.optional(),
  apiFormat: ApiFormatSchema.optional(),
  supportsReasoning: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
});

const UpdateModelSchema = z.object({
  /** New model ID when renaming; omit to keep the current one. */
  modelId: z.string().trim().min(1, 'Model ID is required').optional(),
  displayName: z.string().trim().nullable().optional(),
  contextLength: ContextLengthSchema.nullable().optional(),
  apiFormat: ApiFormatSchema.nullable().optional(),
  supportsReasoning: z.boolean().nullable().optional(),
  supportsVision: z.boolean().nullable().optional(),
});

/** The caller's own IDE visibility preference. */
const VisibilitySchema = z.object({
  hiddenModels: z.array(z.string()),
});

/** One model row as returned by the Models tab. */
interface ModelRow {
  providerId: string;
  providerName: string;
  providerType: string;
  providerIsExternal: boolean;
  providerIsEnabled: boolean;
  shortPrefix: string | null;
  scopedId: string;
  modelId: string;
  /** Effective values: override > reported > built-in default. */
  displayName: string;
  contextLength: number;
  apiFormat: 'openai' | 'anthropic';
  supportsReasoning: boolean;
  supportsVision: boolean;
  /** Value used when no override and no reported value exists. */
  defaultContextLength: number;
  /** Whether the model ID is part of the provider's model list. */
  inProviderList: boolean;
  /** Whether the *current* user is allowed to use this model. */
  canAccess: boolean;
  /**
   * Whether the current user chose to hide this model from their IDE picker.
   * Purely cosmetic: the model stays routable, it is just not advertised.
   */
  hidden: boolean;
  /** Raw override row, when one exists (omitted fields are unset). */
  override?: {
    displayName?: string;
    contextLength?: number;
    apiFormat?: 'openai' | 'anthropic';
    supportsReasoning?: boolean;
    supportsVision?: boolean;
  };
  /** Values reported by the provider's /models endpoint, when any. */
  reported?: {
    displayName?: string;
    contextLength?: number;
    apiFormat?: 'openai' | 'anthropic';
  };
  /**
   * Defaults from the shared reference catalog (OpenRouter), when the model is
   * known there. Used only as a fallback below a user override or a value the
   * provider reported itself.
   */
  reference?: {
    source: string;
    modelId: string;
    displayName?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsReasoning?: boolean;
  };
}

function providerSummary(provider: ProviderConfig) {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    isEnabled: provider.isEnabled,
    isExternal: Boolean(provider.externalProviderId),
    shortPrefix: normalizeProviderShortPrefix(provider.shortPrefix) || null,
  };
}

/** The scoped-ID prefix a grant must use for this provider (`OCA-`, `*-`). */
export function providerGrantPrefix(provider: Pick<ProviderConfig, 'shortPrefix'>): string {
  const prefix = normalizeProviderShortPrefix(provider.shortPrefix);
  return prefix ? `${prefix}-` : '*-';
}

/**
 * Merge the three sources a model's settings can come from:
 *   - the user's override (Models dialog)
 *   - the provider's reported metadata (external provider sync)
 *   - the built-in name heuristic / defaults
 */
async function buildRowsForProvider(provider: ProviderConfig): Promise<ModelRow[]> {
  const [reported, overrides] = await Promise.all([
    providerModelMetadataRepo.findByProvider(provider.id),
    modelOverridesRepo.findByProvider(provider.id),
  ]);

  const reportedByModel = new Map(reported.map((row) => [row.modelId, row]));
  const overrideByModel = new Map(overrides.map((row) => [row.modelId, row]));
  const providerModels = parseModels(provider);

  // Provider list first, then any override rows left behind by a removed model
  // so the user can still see and clean them up.
  const modelIds = [
    ...providerModels,
    ...overrides.map((row) => row.modelId).filter((id) => !providerModels.includes(id)),
  ];

  return modelIds.map((modelId) => {
    const override = overrideByModel.get(modelId);
    const reportedRow = reportedByModel.get(modelId);
    const reportedContext =
      reportedRow?.contextLength && reportedRow.contextLength > 0
        ? reportedRow.contextLength
        : undefined;
    const reference = getModelReference(modelId);
    const referenceContext =
      reference?.contextLength && reference.contextLength > 0
        ? reference.contextLength
        : undefined;

    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.type,
      providerIsExternal: Boolean(provider.externalProviderId),
      providerIsEnabled: provider.isEnabled,
      shortPrefix: normalizeProviderShortPrefix(provider.shortPrefix) || null,
      scopedId: buildProviderScopedModelId(provider, modelId),
      modelId,
      displayName:
        override?.displayName ?? reportedRow?.displayName ?? modelId,
      contextLength:
        override?.contextLength && override.contextLength > 0
          ? override.contextLength
          : reportedContext ?? referenceContext ?? modelMaxTokens(modelId),
      apiFormat:
        override?.apiFormat ??
        reportedRow?.apiFormat ??
        (provider.type === 'anthropic' ? 'anthropic' : 'openai'),
      supportsReasoning:
        override?.supportsReasoning === true || reference?.supportsReasoning === true,
      supportsVision:
        override?.supportsVision === true || reference?.supportsVision === true,
      defaultContextLength: modelMaxTokens(modelId),
      inProviderList: providerModels.includes(modelId),
      canAccess: true,
      hidden: false,
      override: override
        ? {
            displayName: override.displayName,
            contextLength: override.contextLength,
            apiFormat: override.apiFormat,
            supportsReasoning: override.supportsReasoning,
            supportsVision: override.supportsVision,
          }
        : undefined,
      reported: reportedRow
        ? {
            displayName: reportedRow.displayName,
            contextLength: reportedContext,
            apiFormat: reportedRow.apiFormat,
          }
        : undefined,
      reference: reference
        ? {
            source: reference.source,
            modelId: reference.modelId,
            displayName: reference.displayName,
            contextLength: referenceContext,
            maxOutputTokens: reference.maxOutputTokens,
            supportsVision: reference.supportsVision,
            supportsReasoning: reference.supportsReasoning,
          }
        : undefined,
    };
  });
}

async function buildRow(provider: ProviderConfig, modelId: string): Promise<ModelRow | undefined> {
  const rows = await buildRowsForProvider(provider);
  return rows.find((row) => row.modelId === modelId);
}

export function createModelsRouter(): Router {
  const router = Router();

  // Reads are open to every authenticated user (the tab doubles as each
  // user's own allowed-model list); anything that changes model configuration
  // needs a manager role. Applied once here so the route handlers keep their
  // inferred path-parameter types.
  const requireManager = requireRole('power_user');
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      next();
      return;
    }
    // A user's own visibility preference is not a model setting: any
    // authenticated user may curate their own IDE list.
    if (req.method === 'PUT' && req.path === '/visibility') {
      next();
      return;
    }
    requireManager(req, res, next);
  });

  // ── List providers + every model they expose ────────────────────────────
  //
  // Readable by every authenticated user so the tab doubles as the "what am I
  // allowed to use" list. `canManage` says whether the caller may change model
  // settings; `allModels` says whether they hold `*-*`. Non-managers only see
  // the models they can actually reach, and every row carries `canAccess` so
  // the UI can render the checkbox list without re-implementing the rules.
  router.get('/', async (req, res) => {
    const user = req.user;
    const canManage = user?.role === 'admin' || user?.role === 'power_user';
    const unrestricted = !user || hasUnrestrictedModelAccess(user);
    const hiddenModels = user?.hiddenModels ?? [];

    const providers = await providersRepo.findAll();
    const models: ModelRow[] = [];
    for (const provider of providers) {
      const rows = await buildRowsForProvider(provider);
      for (const row of rows) {
        row.canAccess = unrestricted || hasModelAccess(user!, row.scopedId);
        row.hidden = hiddenModels.some((grant) => modelGrantMatches(grant, row.scopedId));
        // Non-managers only ever see their own list, so the tab cannot leak
        // models they have not been granted.
        if (canManage || row.canAccess) {
          models.push(row);
        }
      }
    }

    const visibleProviderIds = new Set(models.map((row) => row.providerId));

    res.json({
      canManage,
      allModels: unrestricted,
      // The caller's own grants, so the UI can render the checkbox tree
      // (including provider-level `OCA-*` entries) without re-deriving them.
      grants: user?.allowedModels ?? [],
      /** Models the caller has chosen to keep out of their IDE picker. */
      hiddenModels,
      providers: providers
        .filter((provider) => canManage || visibleProviderIds.has(provider.id))
        .map(providerSummary),
      models,
    });
  });

  // ── Save the caller's own IDE visibility preference ─────────────────────
  //
  // This is deliberately not a restriction: hidden models stay routable, the
  // list only controls what `/v1/models` advertises to this user's IDE.
  router.put('/visibility', async (req, res) => {
    const parsed = VisibilitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const user = req.user;
    if (!user) {
      res.status(401).json({ error: t(req, 'api.error.invalidRequest') });
      return;
    }

    const hiddenModels = normalizeModelGrants(parsed.data.hiddenModels);
    await usersRepo.update(user.id, { hiddenModels });

    res.json({ ok: true, hiddenModels });
  });

  // ── Add a model to a manual provider ────────────────────────────────────
  router.post('/', async (req, res) => {
    const parsed = AddModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const provider = await providersRepo.findById(parsed.data.providerId);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    if (provider.externalProviderId) {
      res.status(400).json({ error: t(req, 'api.error.externalProviderModelsManaged') });
      return;
    }

    const models = parseModels(provider);
    const modelId = parsed.data.modelId;
    if (models.includes(modelId)) {
      res.status(409).json({ error: t(req, 'api.error.modelAlreadyExists') });
      return;
    }

    const nextModels = [...models, modelId];
    await providersRepo.update(provider.id, { models: nextModels.join(',') });

    const hasOverride =
      parsed.data.displayName !== undefined ||
      parsed.data.contextLength !== undefined ||
      parsed.data.apiFormat !== undefined ||
      parsed.data.supportsReasoning !== undefined ||
      parsed.data.supportsVision !== undefined;

    if (hasOverride) {
      await modelOverridesRepo.upsert(provider.id, modelId, {
        displayName: parsed.data.displayName,
        contextLength: parsed.data.contextLength,
        apiFormat: parsed.data.apiFormat,
        supportsReasoning: parsed.data.supportsReasoning,
        supportsVision: parsed.data.supportsVision,
      });
    }

    const row = await buildRow({ ...provider, models: nextModels.join(',') }, modelId);
    res.status(201).json(row);
  });

  // ── Update a model's override (optionally renaming the model) ───────────
  router.put('/:providerId/:modelId', async (req, res) => {
    const parsed = UpdateModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const provider = await providersRepo.findById(req.params.providerId);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    const currentId = req.params.modelId;
    const models = parseModels(provider);
    const overrideExists = Boolean(await modelOverridesRepo.find(provider.id, currentId));
    if (!models.includes(currentId) && !overrideExists) {
      res.status(404).json({ error: t(req, 'api.error.modelNotFound') });
      return;
    }

    const nextId = parsed.data.modelId ?? currentId;
    let nextModels = models;
    if (nextId !== currentId) {
      if (provider.externalProviderId) {
        res.status(400).json({ error: t(req, 'api.error.externalProviderModelsManaged') });
        return;
      }
      if (models.includes(nextId)) {
        res.status(409).json({ error: t(req, 'api.error.modelAlreadyExists') });
        return;
      }

      nextModels = models.map((id) => (id === currentId ? nextId : id));
      await providersRepo.update(provider.id, { models: nextModels.join(',') });
      await modelOverridesRepo.delete(provider.id, currentId);
    }

    await modelOverridesRepo.upsert(provider.id, nextId, {
      displayName: parsed.data.displayName ?? undefined,
      contextLength: parsed.data.contextLength ?? undefined,
      apiFormat: parsed.data.apiFormat ?? undefined,
      supportsReasoning: parsed.data.supportsReasoning ?? undefined,
      supportsVision: parsed.data.supportsVision ?? undefined,
    });

    const row = await buildRow({ ...provider, models: nextModels.join(',') }, nextId);
    res.json(row);
  });

  // ── Clear a model's override (revert to reported/default values) ────────
  router.delete('/:providerId/:modelId/override', async (req, res) => {
    const provider = await providersRepo.findById(req.params.providerId);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    await modelOverridesRepo.delete(provider.id, req.params.modelId);
    res.status(204).end();
  });

  // ── Remove a model from a manual provider ───────────────────────────────
  router.delete('/:providerId/:modelId', async (req, res) => {
    const provider = await providersRepo.findById(req.params.providerId);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    if (provider.externalProviderId) {
      res.status(400).json({ error: t(req, 'api.error.externalProviderModelsManaged') });
      return;
    }

    const models = parseModels(provider);
    if (!models.includes(req.params.modelId)) {
      res.status(404).json({ error: t(req, 'api.error.modelNotFound') });
      return;
    }

    await providersRepo.update(provider.id, {
      models: models.filter((id) => id !== req.params.modelId).join(','),
    });
    await modelOverridesRepo.delete(provider.id, req.params.modelId);
    res.status(204).end();
  });

  return router;
}
