import { Router } from 'express';
import { hasModelAccess, modelGrantMatches } from '../auth/context';
import { authMiddleware } from './middleware/auth';
import { analyzeProjectCommandMiddleware } from './middleware/analyzeProjectCommand';
import { projectDetectMiddleware } from './middleware/projectDetect';
import { contextInjectMiddleware } from './middleware/contextInject';
import { createLearningToolsMiddleware } from './middleware/learningTools';
import { loggingMiddleware } from './middleware/logging';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { proxyToUpstream } from './upstream';
import { normalizeAnthropicRequestMiddleware } from './middleware/normalizeAnthropicRequest';
import { providersRepo } from '../db/repositories/providers';
import { t } from '../i18n';
import type { ClientProtocol } from './clientProtocols';
import { buildProviderScopedModelId } from './modelSelection';
import { buildModelCatalogEntry, type ModelCatalogEntry } from './modelCatalog';

export function createProxyRouter(): Router {
  const router = Router();

  const createContextProxyHandler = (clientProtocol: ClientProtocol) => async (
    req: Parameters<typeof contextInjectMiddleware>[0],
    res: Parameters<typeof contextInjectMiddleware>[1],
    next: Parameters<typeof contextInjectMiddleware>[2]
  ) => {
    const learningToolsMiddleware = createLearningToolsMiddleware(clientProtocol);

    const enabledCount = (await providersRepo.findAll()).filter((p) => p.isEnabled).length;
    if (enabledCount === 0) {
      res.status(502).json({
        error: {
          message: t(req, 'api.error.noProvidersConfigured', { url: 'http://localhost:9090' }),
          type: 'configuration_error',
        },
      });
      return;
    }

    try {
      await contextInjectMiddleware(req, res, () => {
        learningToolsMiddleware(req, res, () => {
          proxyToUpstream(req, res, { clientProtocol }).catch(next);
        });
      });
    } catch (err) {
      next(err);
    }
  };

  // Logging on all proxy routes
  router.use(loggingMiddleware);

  // Health check (no auth required — must be registered before authMiddleware)
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'intelligent-context', version: '0.1.0' });
  });

  // Auth check
  router.use(authMiddleware);
  router.use(rateLimitMiddleware);

  // List models — returns each model ID from each enabled provider as a distinct entry.
  // Entries are enriched with api_format + context sizes so IDE extensions can
  // auto-populate their model pickers without hand-typed model IDs.
  router.get('/v1/models', async (_req, res) => {
    const req = _req;
    const providers = (await providersRepo.findAll()).filter((p) => p.isEnabled);
    // The user's own visibility preference: models they chose not to see in
    // their picker. Cosmetic only — a hidden model is still routable.
    const hiddenModels = req.user?.hiddenModels ?? [];
    const isHidden = (scopedId: string): boolean =>
      hiddenModels.some((grant) => modelGrantMatches(grant, scopedId));

    const data: ModelCatalogEntry[] = [];
    for (const p of providers) {
      const modelList = (p.models || '')
        .split(',')
        .map((m: string) => m.trim())
        .filter((m: string) => m.length > 0)
        .filter((modelId: string) => !req.user || hasModelAccess(req.user, buildProviderScopedModelId(p, modelId)))
        .filter((modelId: string) => !isHidden(buildProviderScopedModelId(p, modelId)));
      for (const modelId of modelList) {
        data.push(buildModelCatalogEntry(p, modelId));
      }
      // If no models listed, still expose the provider with a generic entry
      if (modelList.length === 0 && (!req.user || req.user.role === 'admin' || req.user.accessAllModels)) {
        const scopedId = buildProviderScopedModelId(p);
        if (isHidden(scopedId)) continue;
        // The generic entry has no underlying model, so size it against the
        // conservative default context and label it with the provider name.
        // Label the raw ID as the provider name too, so the display name stays
        // "Provider · Provider" rather than repeating a model-shaped string.
        data.push({
          ...buildModelCatalogEntry(p, p.name, buildProviderScopedModelId(p)),
          display_name: p.name,
        });
      }
    }
    res.json({ object: 'list', data });
  });

  // Main proxy: Chat completions
  router.post(
    '/v1/chat/completions',
    projectDetectMiddleware,
    analyzeProjectCommandMiddleware,
    createContextProxyHandler('openai')
  );

  // Anthropic-compatible messages endpoint
  router.post(
    '/v1/messages',
    projectDetectMiddleware,
    normalizeAnthropicRequestMiddleware,
    analyzeProjectCommandMiddleware,
    createContextProxyHandler('anthropic')
  );

  // Completions (legacy / some tools)
  router.post(
    '/v1/completions',
    projectDetectMiddleware,
    async (req, res, next) => {
      try {
        await proxyToUpstream(req, res);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
