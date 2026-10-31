import { Router } from 'express';
import { getConfig } from '../../config/config';
import { normalizeRequestContextMode, resolveRequestContextMode } from '../../config/systemModels';
import { db, markDirty, selectOne, execute } from '../../db/connection';
import { getSystemConfigCacheValue, setSystemConfigCacheValue } from '../../config/systemConfigCache';
import { projectsRepo } from '../../db/repositories/projects';
import { providersRepo } from '../../db/repositories/providers';
import { parseModels, systemConfig } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { formatZodError, t } from '../../i18n';
import { buildProviderScopedModelId } from '../../proxy/modelSelection';
import { getModelSupportsVisionForProvider } from '../../proxy/modelMetadataCache';
import { getModelReference } from '../../proxy/modelReferenceCache';
import {
  MODEL_REFERENCE_SOURCE_OPENROUTER,
  getModelReferenceSyncStatus,
  setModelReferenceSyncEnabled,
  syncModelReference,
} from '../../externalProviders/modelReference';
import { modelReferenceRepo } from '../../db/repositories/modelReference';

interface AvailableModelOption {
  value: string;
  label: string;
  model: string;
  providerId: string;
  providerName: string;
  providerType: string;
  shortPrefix: string;
}

async function getAvailableModelOptions(): Promise<AvailableModelOption[]> {
  const seen = new Set<string>();
  const result: AvailableModelOption[] = [];
  const providers = (await providersRepo.findAll()).filter((p) => p.isEnabled);
  for (const p of providers) {
    for (const model of parseModels(p)) {
      const value = buildProviderScopedModelId(p, model);
      if (seen.has(value)) continue;

      seen.add(value);
      result.push({
        value,
        label: `${model} [${p.name}]`,
        model,
        providerId: p.id,
        providerName: p.name,
        providerType: p.type,
        shortPrefix: p.shortPrefix ?? '',
      });
    }
  }

  return result.sort((a, b) =>
    a.model.localeCompare(b.model) ||
    a.providerName.localeCompare(b.providerName) ||
    a.value.localeCompare(b.value)
  );
}

/**
 * Models offered in the vision-model picker: models the user marked as
 * vision-capable, plus models the shared reference catalog reports as
 * accepting images. A previously configured selection that is no longer
 * capable stays in the list so it remains visible and can be changed.
 */
function buildVisionModelOptions(
  all: AvailableModelOption[],
  configured: string
): AvailableModelOption[] {
  const capable = all.filter(
    (option) =>
      getModelSupportsVisionForProvider(option.providerId, option.model) === true ||
      getModelReference(option.model)?.supportsVision === true
  );

  if (!configured || capable.some((option) => option.value === configured)) {
    return capable;
  }

  const match = all.find((option) => option.value === configured);
  return [
    match ?? {
      value: configured,
      label: `${configured} (not marked as vision-capable)`,
      model: configured,
      providerId: '',
      providerName: '',
      providerType: '',
      shortPrefix: '',
    },
    ...capable,
  ];
}

async function getConfigValue(key: string): Promise<string> {
  const cached = getSystemConfigCacheValue(key);
  if (cached !== '') return cached;
  const row = await selectOne(db()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, key)));
  const value = row?.value ?? '';
  setSystemConfigCacheValue(key, value);
  return value;
}

async function setConfigValue(key: string, value: string): Promise<void> {
  const existing = await selectOne(db()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, key)));
  if (existing) {
    await execute(db().update(systemConfig).set({ value }).where(eq(systemConfig.key, key)));
  } else {
    await execute(db().insert(systemConfig).values({ key, value }));
  }
  setSystemConfigCacheValue(key, value);
  markDirty();
}

async function getBooleanConfigValue(key: string, fallback = false): Promise<boolean> {
  const fromDb = await getConfigValue(key);
  if (fromDb === '') return fallback;
  return fromDb.trim().toLowerCase() === 'true';
}

async function getNumberConfigValue(key: string, fallback: number): Promise<number> {
  const fromDb = await getConfigValue(key);
  if (fromDb === '') return fallback;

  const parsed = Number(fromDb);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

/**
 * Read a context-config value with DB-override semantics.
 * The system_config table holds UI overrides; fall back to the YAML/env
 * config when no override has been set.
 */
async function getContextOverride<T extends keyof ReturnType<typeof getConfig>['context']>(
  key: T
): Promise<ReturnType<typeof getConfig>['context'][T]> {
  const fromDb = await getConfigValue(`context.${key}`);
  if (fromDb === '') return getConfig().context[key];
  const yamlValue = getConfig().context[key];
  // For string-typed fields, return the override directly.
  if (typeof yamlValue === 'string') {
    return fromDb as ReturnType<typeof getConfig>['context'][T];
  }
  // For numeric-typed fields, parse and validate.
  if (typeof yamlValue === 'number') {
    const parsed = Number(fromDb);
    if (Number.isFinite(parsed)) return parsed as ReturnType<typeof getConfig>['context'][T];
  }
  // For boolean-typed fields, parse 'true' / 'false'.
  if (typeof yamlValue === 'boolean') {
    return (fromDb === 'true') as ReturnType<typeof getConfig>['context'][T];
  }
  return yamlValue;
}

const GlobalSettingsSchema = z.object({
  requestContextMode: z.enum(['basic', 'selector', 'gatherer']).optional(),
  contextSelectorModel: z.string().optional(),
  summarizerModel: z.string().optional(),
  analyzerModel: z.string().optional(),
  learningModel: z.string().optional(),
  gathererModel: z.string().optional(),
  icToolsModel: z.string().optional(),
  visionModel: z.string().optional(),
  modelReferenceSyncEnabled: z.boolean().optional(),
  enableAgentAnalyzer: z.boolean().optional(),
  analyzerAgentMaxTurns: z.number().int().min(1).max(200).optional(),
  // Context config overrides — all optional, validated individually.
  tokenBudget: z.number().int().min(100).max(1_000_000).optional(),
  bypassSelectorItemThreshold: z.number().int().min(0).max(10000).optional(),
  bypassSelectorTokenThreshold: z.number().int().min(0).max(1_000_000).optional(),
  contextReplayTtlMinutes: z.number().int().min(0).max(1440).optional(),
  maxCachedContexts: z.number().int().min(0).max(100000).optional(),
  reservedResponseTokens: z.number().int().min(0).max(200000).optional(),
  contextOverheadTokens: z.number().int().min(0).max(20000).optional(),
  defaultModelMaxTokens: z.number().int().min(1000).max(2_000_000).optional(),
  maxRecordLearnings: z.number().int().min(1).max(10000).optional(),
});

const ProjectSettingsSchema = z.object({
  mainModel: z.string().optional(),
  contextSelectorModel: z.string().optional(),
  summarizerModel: z.string().optional(),
  analyzerModel: z.string().optional(),
  contextTokenBudget: z.number().int().min(100).max(200000).optional(),
  autoSummarizeThreshold: z.number().int().min(1).max(100).optional(),
  embeddingModel: z.string().optional(),
  defaultProvider: z.string().optional(),
});

export function createSettingsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (_req, res) => {
    const config = getConfig();
    const availableModelOptions = await getAvailableModelOptions();
    const gathererModel = await getConfigValue('gathererModel');
    const visionModel = await getConfigValue('visionModel');
    const requestContextMode = resolveRequestContextMode(
      await getConfigValue('requestContextMode'),
      gathererModel,
    );

    res.json({
      models: {
        requestContextMode,
        contextSelector: await getConfigValue('contextSelectorModel'),
        summarizer: await getConfigValue('summarizerModel'),
        analyzer: await getConfigValue('analyzerModel'),
        learning: await getConfigValue('learningModel'),
        gatherer: gathererModel,
        icTools: await getConfigValue('icToolsModel'),
        vision: visionModel,
      },
      analyzer: {
        agentEnabled: await getBooleanConfigValue('enableAgentAnalyzer', false),
        agentMaxTurns: await getNumberConfigValue('analyzerAgentMaxTurns', 60),
      },
      availableModels: availableModelOptions.map((option) => option.value),
      availableModelOptions,
      availableVisionModelOptions: buildVisionModelOptions(availableModelOptions, visionModel),
      modelReference: {
        ...getModelReferenceSyncStatus(),
        source: MODEL_REFERENCE_SOURCE_OPENROUTER,
        count: await modelReferenceRepo.countBySource(MODEL_REFERENCE_SOURCE_OPENROUTER),
      },
      context: {
        ...config.context,
        tokenBudget: await getContextOverride('tokenBudget'),
        bypassSelectorItemThreshold: await getContextOverride('bypassSelectorItemThreshold'),
        bypassSelectorTokenThreshold: await getContextOverride('bypassSelectorTokenThreshold'),
        contextReplayTtlMinutes: await getContextOverride('contextReplayTtlMinutes'),
        maxCachedContexts: await getContextOverride('maxCachedContexts'),
        reservedResponseTokens: await getContextOverride('reservedResponseTokens'),
        contextOverheadTokens: await getContextOverride('contextOverheadTokens'),
        defaultModelMaxTokens: await getContextOverride('defaultModelMaxTokens'),
        maxRecordLearnings: await getContextOverride('maxRecordLearnings'),
      },
      workers: config.workers,
      providers: (await providersRepo.findAll()).map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        shortPrefix: p.shortPrefix ?? '',
        models: p.models || '',
        configured: !!p.apiKey && p.apiKey !== 'none',
        isEnabled: p.isEnabled,
        isDefault: p.isDefault,
      })),
    });
  });

  router.put('/', async (req, res) => {
    const parsed = GlobalSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }
    if (parsed.data.requestContextMode !== undefined) {
      const mode = normalizeRequestContextMode(parsed.data.requestContextMode);
      await setConfigValue('requestContextMode', mode ?? 'selector');
    }
    if (parsed.data.contextSelectorModel !== undefined) {
      await setConfigValue('contextSelectorModel', parsed.data.contextSelectorModel ?? '');
    }
    if (parsed.data.summarizerModel !== undefined) {
      await setConfigValue('summarizerModel', parsed.data.summarizerModel ?? '');
    }
    if (parsed.data.analyzerModel !== undefined) {
      await setConfigValue('analyzerModel', parsed.data.analyzerModel ?? '');
    }
    if (parsed.data.learningModel !== undefined) {
      await setConfigValue('learningModel', parsed.data.learningModel ?? '');
    }
    if (parsed.data.gathererModel !== undefined) {
      await setConfigValue('gathererModel', parsed.data.gathererModel ?? '');
    }
    if (parsed.data.icToolsModel !== undefined) {
      await setConfigValue('icToolsModel', parsed.data.icToolsModel ?? '');
    }
    if (parsed.data.visionModel !== undefined) {
      await setConfigValue('visionModel', parsed.data.visionModel ?? '');
    }
    if (parsed.data.modelReferenceSyncEnabled !== undefined) {
      await setConfigValue(
        'modelReferenceSyncEnabled',
        parsed.data.modelReferenceSyncEnabled ? 'true' : 'false'
      );
      setModelReferenceSyncEnabled(parsed.data.modelReferenceSyncEnabled);
    }
    if (parsed.data.enableAgentAnalyzer !== undefined) {
      await setConfigValue('enableAgentAnalyzer', parsed.data.enableAgentAnalyzer ? 'true' : 'false');
    }
    if (parsed.data.analyzerAgentMaxTurns !== undefined) {
      await setConfigValue('analyzerAgentMaxTurns', String(parsed.data.analyzerAgentMaxTurns));
    }
    const numericOverrides: Array<[string, number | undefined]> = [
      ['context.tokenBudget', parsed.data.tokenBudget],
      ['context.bypassSelectorItemThreshold', parsed.data.bypassSelectorItemThreshold],
      ['context.bypassSelectorTokenThreshold', parsed.data.bypassSelectorTokenThreshold],
      ['context.contextReplayTtlMinutes', parsed.data.contextReplayTtlMinutes],
      ['context.maxCachedContexts', parsed.data.maxCachedContexts],
      ['context.reservedResponseTokens', parsed.data.reservedResponseTokens],
      ['context.contextOverheadTokens', parsed.data.contextOverheadTokens],
      ['context.defaultModelMaxTokens', parsed.data.defaultModelMaxTokens],
      ['context.maxRecordLearnings', parsed.data.maxRecordLearnings],
    ];
    for (const [key, value] of numericOverrides) {
      if (value === undefined) continue;
      await setConfigValue(key, value === null ? '' : String(value));
    }
    res.json({ ok: true });
  });

  router.put('/project/:id', async (req, res) => {
    const parsed = ProjectSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }
    const project = await projectsRepo.findById(req.params.id);
    if (!project) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }
    const existing = projectsRepo.getSettings(project);
    await projectsRepo.update(req.params.id, {
      settings: { ...existing, ...parsed.data },
    });
    res.json({ ok: true });
  });

  // ── Reference catalog (shared model defaults) ───────────────────────────
  router.get('/reference', async (_req, res) => {
    res.json({
      ...getModelReferenceSyncStatus(),
      source: MODEL_REFERENCE_SOURCE_OPENROUTER,
      count: await modelReferenceRepo.countBySource(MODEL_REFERENCE_SOURCE_OPENROUTER),
    });
  });

  router.post('/reference/sync', async (_req, res) => {
    const result = await syncModelReference();
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error ?? 'Sync failed', count: 0 });
      return;
    }

    res.json({
      ok: true,
      count: result.count,
      ...getModelReferenceSyncStatus(),
      source: MODEL_REFERENCE_SOURCE_OPENROUTER,
    });
  });

  return router;
}
