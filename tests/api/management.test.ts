import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicUser, UserRole } from '../../src/db/repositories/users';
import { withTestServer } from '../helpers/http';

const helpers = vi.hoisted(() => ({
  mountedRoute: (label: string) => (_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json({ route: label });
  },
  buildUser: (role: UserRole): PublicUser => ({
    id: 'user-1',
    email: 'user@example.com',
    role,
    isApproved: true,
    isDisabled: false,
    accessAllProjects: role === 'admin',
    accessAllModels: true,
    allowedModels: [],
    createdAt: new Date(0),
    lastLoginAt: null,
  }),
}));

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getSystemModelConfig: vi.fn(),
  projectsRepo: {
    findAll: vi.fn(),
    findAllForUser: vi.fn(),
    findById: vi.fn(),
  },
  providersRepo: {
    findAll: vi.fn(),
  },
  projectMembersRepo: {
    canAccessProject: vi.fn(),
  },
  resolveProviderForJob: vi.fn(),
  resolveProviderAndModelForJob: vi.fn(),
  runCategorizedSummarizer: vi.fn(),
  runAnalyzer: vi.fn(),
  getLastClientInfo: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  t: vi.fn((_: unknown, key: string) => key),
}));

vi.mock('../../src/api/routes/setup', () => ({
  createSetupRouter: () => helpers.mountedRoute('setup'),
}));

vi.mock('../../src/api/routes/auth', () => ({
  createAuthRouter: () => helpers.mountedRoute('auth'),
}));

vi.mock('../../src/api/routes/i18n', () => ({
  createI18nRouter: () => helpers.mountedRoute('i18n'),
}));

vi.mock('../../src/api/routes/providers', () => ({
  createProvidersRouter: () => helpers.mountedRoute('providers'),
}));

vi.mock('../../src/api/routes/users', () => ({
  createUsersRouter: () => helpers.mountedRoute('users'),
}));

vi.mock('../../src/api/routes/projects', () => ({
  createProjectsRouter: () => (req: any, res: any, next: () => void) => {
    if (req.path === '/' || req.path === '') {
      res.json({ route: 'projects' });
      return;
    }

    next();
  },
}));

vi.mock('../../src/api/routes/context', () => ({
  createContextRouter: () => helpers.mountedRoute('context'),
}));

vi.mock('../../src/api/routes/codeExtracts', () => ({
  createCodeExtractsRouter: () => helpers.mountedRoute('code-extracts'),
}));

vi.mock('../../src/api/routes/files', () => ({
  createFilesRouter: () => helpers.mountedRoute('files'),
}));

vi.mock('../../src/api/routes/findings', () => ({
  createFindingsRouter: () => helpers.mountedRoute('findings'),
}));

vi.mock('../../src/api/routes/stats', () => ({
  createStatsRouter: () => helpers.mountedRoute('stats'),
}));

vi.mock('../../src/api/routes/chat', () => ({
  createChatRouter: () => helpers.mountedRoute('chat'),
}));

vi.mock('../../src/api/routes/settings', () => ({
  createSettingsRouter: () => helpers.mountedRoute('settings'),
}));

vi.mock('../../src/config/config', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

vi.mock('../../src/db/repositories/chunks', () => ({
  chunksRepo: {},
}));

vi.mock('../../src/db/repositories/projectMembers', () => ({
  projectMembersRepo: mocks.projectMembersRepo,
}));

vi.mock('../../src/proxy/clientInfo', () => ({
  getLastClientInfo: mocks.getLastClientInfo,
}));

vi.mock('../../src/workers/summaryPipeline', () => ({
  runCategorizedSummarizer: mocks.runCategorizedSummarizer,
}));

vi.mock('../../src/workers/analyzer', () => ({
  runAnalyzer: mocks.runAnalyzer,
}));

vi.mock('../../src/proxy/upstream', () => ({
  resolveProviderForJob: mocks.resolveProviderForJob,
  resolveProviderAndModelForJob: mocks.resolveProviderAndModelForJob,
}));

vi.mock('../../src/i18n', () => ({
  localeMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  t: mocks.t,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/auth/context', () => {
  const ranks: Record<UserRole, number> = {
    user: 1,
    power_user: 2,
    admin: 3,
  };

  return {
    requireAuthenticated: () => (req: any, res: any, next: () => void) => {
      const roleHeader = req.headers['x-test-role'];
      if (typeof roleHeader !== 'string' || roleHeader.length === 0) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }

      const role = roleHeader as UserRole;
      req.user = helpers.buildUser(role);
      req.userId = req.user.id;
      req.userRole = role;
      next();
    },
    requireRole: (minRole: UserRole) => (req: any, res: any, next: () => void) => {
      const currentRole = req.userRole as UserRole | undefined;
      if (!currentRole || ranks[currentRole] < ranks[minRole]) {
        res.status(403).json({ error: 'You do not have access to this action.' });
        return;
      }

      next();
    },
  };
});

import { createManagementApp } from '../../src/api/management';

describe('createManagementApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getConfig.mockReturnValue({
      mode: 'local',
      proxy: { host: '127.0.0.1', port: 1234, apiKey: 'proxy-key' },
      management: { host: '127.0.0.1', port: 9090 },
    });
    mocks.getSystemModelConfig.mockReturnValue({
      contextSelector: '',
      summarizer: 'gpt-4.1-mini',
      analyzer: 'gpt-4.1-mini',
    });
    mocks.projectsRepo.findAll.mockResolvedValue([
      { id: 'project-1', name: 'Project One' },
      { id: 'project-2', name: 'Project Two' },
    ]);
    mocks.projectsRepo.findAllForUser.mockResolvedValue([{ id: 'project-1', name: 'Project One' }]);
    mocks.projectsRepo.findById.mockResolvedValue({ id: 'project-1', name: 'Project One' });
    mocks.providersRepo.findAll.mockResolvedValue([
      { id: 'provider-1', name: 'OpenAI', type: 'openai', isEnabled: true, isDefault: true },
      { id: 'provider-2', name: 'Disabled', type: 'openai', isEnabled: false, isDefault: false },
    ]);
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(true);
    mocks.resolveProviderAndModelForJob.mockResolvedValue({ providerName: 'OpenAI', model: 'gpt-4.1-mini' });
    mocks.runCategorizedSummarizer.mockResolvedValue(undefined);
    mocks.runAnalyzer.mockResolvedValue(undefined);
    mocks.getLastClientInfo.mockReturnValue(null);
  });

  it('exposes public setup, auth, i18n, and health routes without authentication', async () => {
    const app = createManagementApp();

    await withTestServer(app, async ({ request }) => {
      const setupResponse = await request('/api/setup');
      const authResponse = await request('/api/auth');
      const i18nResponse = await request('/api/i18n');
      const healthResponse = await request('/api/health');

      expect(setupResponse.status).toBe(200);
      expect(await setupResponse.json()).toEqual({ route: 'setup' });

      expect(authResponse.status).toBe(200);
      expect(await authResponse.json()).toEqual({ route: 'auth' });

      expect(i18nResponse.status).toBe(200);
      expect(await i18nResponse.json()).toEqual({ route: 'i18n' });

      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({
        status: 'ok',
        mode: 'local',
        managementPort: expect.any(Number),
        proxyPort: expect.any(Number),
        projects: 2,
        // Populated by project detection from IDE client headers.
        lastClient: null,
        providers: [
          {
            id: 'provider-1',
            name: 'OpenAI',
            type: 'openai',
            isDefault: true,
          },
        ],
      });
    });

    expect(mocks.projectsRepo.findAll).toHaveBeenCalledTimes(1);
    expect(mocks.projectsRepo.findAllForUser).not.toHaveBeenCalled();
  });

  it('protects provider routes behind authentication and power-user access', async () => {
    const app = createManagementApp();

    await withTestServer(app, async ({ request }) => {
      const unauthenticatedResponse = await request('/api/providers');
      expect(unauthenticatedResponse.status).toBe(401);
      expect(await unauthenticatedResponse.json()).toEqual({ error: 'Authentication required.' });

      const forbiddenResponse = await request('/api/providers', {
        headers: { 'x-test-role': 'user' },
      });
      expect(forbiddenResponse.status).toBe(403);
      expect(await forbiddenResponse.json()).toEqual({ error: 'You do not have access to this action.' });

      const allowedResponse = await request('/api/providers', {
        headers: { 'x-test-role': 'power_user' },
      });
      expect(allowedResponse.status).toBe(200);
      expect(await allowedResponse.json()).toEqual({ route: 'providers' });
    });
  });

  it('blocks project subroutes when the caller lacks access to the project', async () => {
    const app = createManagementApp();

    await withTestServer(app, async ({ request }) => {
      const unauthenticatedResponse = await request('/api/projects/project-1/context');
      expect(unauthenticatedResponse.status).toBe(401);

      mocks.projectsRepo.findById.mockResolvedValueOnce(undefined);
      const missingProjectResponse = await request('/api/projects/project-1/context', {
        headers: { 'x-test-role': 'admin' },
      });
      expect(missingProjectResponse.status).toBe(404);
      expect(await missingProjectResponse.json()).toEqual({ error: 'api.error.projectNotFound' });

      mocks.projectsRepo.findById.mockResolvedValueOnce({ id: 'project-1', name: 'Project One' });
      mocks.projectMembersRepo.canAccessProject.mockResolvedValueOnce(false);
      const forbiddenProjectResponse = await request('/api/projects/project-1/context', {
        headers: { 'x-test-role': 'power_user' },
      });
      expect(forbiddenProjectResponse.status).toBe(404);
      expect(await forbiddenProjectResponse.json()).toEqual({ error: 'api.error.projectNotFound' });

      mocks.projectsRepo.findById.mockResolvedValueOnce({ id: 'project-1', name: 'Project One' });
      mocks.projectMembersRepo.canAccessProject.mockResolvedValueOnce(true);
      const allowedResponse = await request('/api/projects/project-1/context', {
        headers: { 'x-test-role': 'power_user' },
      });
      expect(allowedResponse.status).toBe(200);
      expect(await allowedResponse.json()).toEqual({ route: 'context' });

      mocks.projectsRepo.findById.mockResolvedValueOnce({ id: 'project-1', name: 'Project One' });
      mocks.projectMembersRepo.canAccessProject.mockResolvedValueOnce(true);
      const codeExtractsResponse = await request('/api/projects/project-1/code-extracts', {
        headers: { 'x-test-role': 'power_user' },
      });
      expect(codeExtractsResponse.status).toBe(200);
      expect(await codeExtractsResponse.json()).toEqual({ route: 'code-extracts' });
    });
  });

  it('runs the summarizer for authorized project members when a model and provider are configured', async () => {
    const execution = { providerName: 'OpenAI', model: 'gpt-4.1-mini' };
    mocks.resolveProviderAndModelForJob.mockResolvedValue(execution);

    const app = createManagementApp();

    await withTestServer(app, async ({ request }) => {
      const response = await request('/api/projects/project-1/summarize', {
        method: 'POST',
        headers: { 'x-test-role': 'power_user' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    expect(mocks.resolveProviderAndModelForJob).toHaveBeenCalledWith('gpt-4.1-mini', 'openai');
    expect(mocks.runCategorizedSummarizer).toHaveBeenCalledWith({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: execution,
      trigger: 'manual',
    });
  });
});