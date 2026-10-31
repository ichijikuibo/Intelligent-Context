import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { createProjectsRouter } from './routes/projects';
import { createContextRouter } from './routes/context';
import { createCodeExtractsRouter } from './routes/codeExtracts';
import { createFilesRouter } from './routes/files';
import { createFindingsRouter } from './routes/findings';
import { createTaskRunsRouter } from './routes/taskRuns';
import { createStatsRouter } from './routes/stats';
import { createChatRouter } from './routes/chat';
import { createI18nRouter } from './routes/i18n';
import { createSetupRouter } from './routes/setup';
import { createSettingsRouter } from './routes/settings';
import { createProvidersRouter } from './routes/providers';
import { createExternalProvidersRouter } from './routes/externalProviders';
import { createModelsRouter } from './routes/models';
import { createAuthRouter } from './routes/auth';
import { createUsersRouter } from './routes/users';
import { createMcpRouter } from '../mcp/route';
import { projectsRepo } from '../db/repositories/projects';
import { providersRepo } from '../db/repositories/providers';
import { chunksRepo } from '../db/repositories/chunks';
import { projectMembersRepo } from '../db/repositories/projectMembers';
import { runCategorizedSummarizer } from '../workers/summaryPipeline';
import { runAnalyzer } from '../workers/analyzer';
import { getConfig } from '../config/config';
import { resolveProviderAndModelForJob } from '../proxy/upstream';
import { getLastClientInfo } from '../proxy/clientInfo';
import { getSystemModelConfig } from '../config/systemModels';
import { localeMiddleware, t } from '../i18n';
import { logger } from '../utils/logger';
import { createJsonErrorHandler, wrapAsyncHandlers } from '../utils/expressErrors';
import { requireAuthenticated, requireRole } from '../auth/context';

// ── SEA-aware UI path resolution ──────────────────────────────────────────
// In SEA (single-executable) mode, __dirname === dirname(process.execPath).
// We look for a `ui/` directory next to the executable, then fall back to
// the embedded asset (via node:sea), and finally to the dev-time relative path.

function resolveUiPath(): string {
  // 1. Explicit env override
  if (process.env.IC_UI_PATH) {
    return process.env.IC_UI_PATH;
  }
  // 2. Next to the executable (SEA + installed layout)
  const exeDir = path.dirname(process.execPath);
  const nextToExe = path.join(exeDir, 'ui');
  if (fs.existsSync(path.join(nextToExe, 'index.html'))) {
    return nextToExe;
  }
  // 3. Dev-time layout (__dirname is src/api, ui is ../../ui)
  const devPath = path.join(__dirname, '../../ui');
  if (fs.existsSync(path.join(devPath, 'index.html'))) {
    return devPath;
  }
  // 4. Fallback (may fail — caller handles)
  return devPath;
}

export function createManagementApp(): express.Application {
  const app = express();
  // Larger limit so chat turns can carry uploaded text/image attachments.
  app.use(express.json({ limit: '32mb' }));
  app.use(cors({ origin: '*' }));
  app.use(localeMiddleware);

  // Serve static management UI (SEA-aware path resolution)
  app.use('/ui', express.static(resolveUiPath()));

  // Redirect root to UI
  app.get('/', (_req, res) => res.redirect('/ui'));

  // Initial setup stays public so the UI can collect the runtime mode and DB details.
  app.use('/api/setup', createSetupRouter());

  // Auth + bootstrap endpoints must stay public.
  app.use('/api/auth', createAuthRouter());

  // Localized message catalog for the management UI stays public so the login screen can translate.
  app.use('/api/i18n', createI18nRouter());

  // Health — publicly visible so the boot screen can check connectivity
  app.get('/api/health', async (req, res) => {
    const config = getConfig();
    const projects = req.user ? await projectsRepo.findAllForUser(req.user) : await projectsRepo.findAll();
    const providers = await providersRepo.findAll();
    res.json({
      status: 'ok',
      mode: config.mode,
      proxyPort: config.proxy.port,
      managementPort: config.management.port,
      projects: projects.length,
      providers: providers.filter((p) => p.isEnabled).map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        isDefault: p.isDefault,
      })),
      // Most recently seen IDE client (populated by project detection headers).
      lastClient: getLastClientInfo(),
    });
  });

  // ── All routes below require authentication ──────────────────────
  // MCP server (Streamable HTTP). The router authenticates the caller itself
  // with the per-user API key, so it is mounted outside the session-cookie
  // routes below.
  app.use('/mcp', createMcpRouter());

  // ── All routes below require authentication ──────────────────────

  // Providers CRUD
  app.use('/api/providers', requireAuthenticated(), requireRole('power_user'), createProvidersRouter());

  // External providers (opencode Go, etc.)
  app.use('/api/external-providers', requireAuthenticated(), requireRole('power_user'), createExternalProvidersRouter());

  // Models registry. Reads are open to every authenticated user (the tab shows
  // each user their own allowed list); the router itself gates the writes.
  app.use('/api/models', requireAuthenticated(), createModelsRouter());

  // User management
  app.use('/api/users', requireAuthenticated(), createUsersRouter());

  // Projects CRUD
  app.use('/api/projects', requireAuthenticated(), createProjectsRouter());

  // Project sub-routes (context, findings, settings)
  const projectRouter = express.Router({ mergeParams: true });
  projectRouter.use(async (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const projectId = (req.params as Record<string, string>)['id'] ?? '';
    const project = await projectsRepo.findById(projectId);
    if (!project) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }

    const allowed = await projectMembersRepo.canAccessProject(req.user, projectId);
    if (!allowed) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }

    next();
  });
  projectRouter.use('/context', createContextRouter());
  projectRouter.use('/code-extracts', createCodeExtractsRouter());
  projectRouter.use('/files', createFilesRouter());
  projectRouter.use('/findings', createFindingsRouter());
  projectRouter.use('/stats', createStatsRouter());
  projectRouter.use('/chat', createChatRouter());

  // Trigger summarization for a project
  projectRouter.post('/summarize', async (req, res) => {
    if (!req.userRole || (req.userRole !== 'admin' && req.userRole !== 'power_user')) {
      res.status(403).json({ error: 'You do not have access to this action.' });
      return;
    }

    const projectId = (req.params as Record<string, string>)['id'] ?? '';
    const models = getSystemModelConfig();
    if (!models.summarizer) {
      res.status(400).json({ error: t(req, 'api.error.noSummarizerModel') });
      return;
    }
    const execution = await resolveProviderAndModelForJob(models.summarizer, 'openai');
    if (!execution) {
      res.status(400).json({ error: t(req, 'api.error.noProviderConfigured') });
      return;
    }
    await runCategorizedSummarizer({ projectId, model: execution.model, provider: execution, trigger: 'manual' });
    res.json({ ok: true });
  });

  // Trigger analysis for a project
  projectRouter.post('/analyze', async (req, res) => {
    if (!req.userRole || (req.userRole !== 'admin' && req.userRole !== 'power_user')) {
      res.status(403).json({ error: 'You do not have access to this action.' });
      return;
    }

    const projectId = (req.params as Record<string, string>)['id'] ?? '';
    const models = getSystemModelConfig();
    if (!models.analyzer) {
      res.status(400).json({ error: t(req, 'api.error.noAnalyzerModel') });
      return;
    }
    const execution = await resolveProviderAndModelForJob(models.analyzer, 'openai');
    if (!execution) {
      res.status(400).json({ error: t(req, 'api.error.noProviderConfigured') });
      return;
    }
    await runAnalyzer({ projectId, model: execution.model, provider: execution },true);
    res.json({ ok: true });
  });

  app.use('/api/projects/:id', projectRouter);

  // Global settings
  app.use('/api/settings', requireAuthenticated(), requireRole('admin'), createSettingsRouter());

  // Background task runs + notifications
  app.use('/api/task-runs', requireAuthenticated(), requireRole('admin'), createTaskRunsRouter());

  wrapAsyncHandlers(app);

  // Error handler
  app.use(createJsonErrorHandler('management'));

  return app;
}

export function startManagementServer(host: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    const app = createManagementApp();
    app.listen(port, host, () => {
      logger.info('Management API started', { host, port, url: `http://${host}:${port}` });
      resolve();
    });
  });
}
