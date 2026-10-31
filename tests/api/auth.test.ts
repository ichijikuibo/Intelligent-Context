import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

const helpers = vi.hoisted(() => ({
  buildUser: (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'admin',
    passwordHash: 'stored-password-hash',
    role: 'admin',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: true,
    accessAllModels: true,
    allowedModels: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastLoginAt: null,
    ...overrides,
  }),
  buildPublicUser: (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'admin',
    role: 'admin',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: true,
    accessAllModels: true,
    allowedModels: [],
    createdAt: new Date(0).toISOString(),
    lastLoginAt: null,
    ...overrides,
  }),
}));

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  createSessionToken: vi.fn(),
  generateApiKey: vi.fn(),
  hashApiKey: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  attachAuthContext: vi.fn(),
  createSessionCookieHeader: vi.fn(),
  clearSessionCookieHeader: vi.fn(),
  usersRepo: {
    count: vi.fn(),
    create: vi.fn(),
    toPublicUser: vi.fn(),
    findByEmail: vi.fn(),
    touchLastLogin: vi.fn(),
    findById: vi.fn(),
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    findApiKeyById: vi.fn(),
    revokeApiKey: vi.fn(),
  },
  projectsRepo: {
    findAllForUser: vi.fn(),
  },
}));

vi.mock('../../src/config/config', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/auth/credentials', () => ({
  createSessionToken: mocks.createSessionToken,
  generateApiKey: mocks.generateApiKey,
  getSessionSecret: () => 'session-secret',
  hashApiKey: mocks.hashApiKey,
  hashPassword: mocks.hashPassword,
  verifyPassword: mocks.verifyPassword,
}));

vi.mock('../../src/auth/context', () => ({
  attachAuthContext: mocks.attachAuthContext,
  clearSessionCookieHeader: mocks.clearSessionCookieHeader,
  createSessionCookieHeader: mocks.createSessionCookieHeader,
  requireAuthenticated: () => (req: any, res: any, next: () => void) => {
    const roleHeader = req.headers['x-test-role'];
    if (typeof roleHeader !== 'string' || roleHeader.length === 0) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    req.user = helpers.buildPublicUser({
      role: roleHeader,
      accessAllProjects: roleHeader === 'admin',
    });
    req.userId = req.user.id;
    req.userRole = req.user.role;
    next();
  },
}));

vi.mock('../../src/db/repositories/users', () => ({
  usersRepo: mocks.usersRepo,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

import { createAuthRouter } from '../../src/api/routes/auth';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter());
  return app;
}

describe('createAuthRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getConfig.mockReturnValue({
      mode: 'local',
      proxy: { apiKey: 'proxy-key' },
    });
    mocks.createSessionToken.mockReturnValue('session-token');
    mocks.createSessionCookieHeader.mockReturnValue('ic_session=session-token; Path=/; HttpOnly; Secure');
    mocks.clearSessionCookieHeader.mockReturnValue('ic_session=; Path=/; HttpOnly; Secure; Max-Age=0');
    mocks.hashPassword.mockReturnValue('hashed-password');
    mocks.verifyPassword.mockReturnValue(true);
    mocks.attachAuthContext.mockImplementation(async (req: any) => req.user ?? null);
    mocks.usersRepo.toPublicUser.mockImplementation((user: any) =>
      helpers.buildPublicUser({
        id: user.id,
        email: user.email,
        role: user.role,
        accessAllProjects: user.accessAllProjects,
        accessAllModels: user.accessAllModels,
        allowedModels: user.allowedModels,
      })
    );
    mocks.projectsRepo.findAllForUser.mockResolvedValue([{ id: 'project-1', name: 'Project One' }]);
  });

  it('reports bootstrap status for a fresh local install', async () => {
    mocks.usersRepo.count.mockResolvedValue(0);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/bootstrap-status');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        needsBootstrap: true,
        mode: 'local',
        defaultAdminLogin: 'admin',
      });
    });
  });

  it('rejects bootstrap requests without both login and password', async () => {
    mocks.usersRepo.count.mockResolvedValue(0);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin' }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Login and password are required.' });
    });
  });

  it('creates the initial admin account, defaults the local login to admin, and sets a session cookie', async () => {
    const createdUser = helpers.buildUser({ email: 'admin' });
    mocks.usersRepo.count.mockResolvedValue(0);
    mocks.usersRepo.create.mockResolvedValue(createdUser);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'secret-password' }),
      });

      expect(response.status).toBe(201);
      expect(response.headers.get('set-cookie')).toContain('ic_session=session-token');
      expect(await response.json()).toEqual({
        user: helpers.buildPublicUser(),
        projects: [{ id: 'project-1', name: 'Project One' }],
      });
    });

    expect(mocks.hashPassword).toHaveBeenCalledWith('secret-password');
    expect(mocks.usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'admin',
        passwordHash: 'hashed-password',
        role: 'admin',
      })
    );
  });

  it('rejects logins with an invalid password', async () => {
    mocks.usersRepo.findByEmail.mockResolvedValue(helpers.buildUser({ email: 'admin@example.com' }));
    mocks.verifyPassword.mockReturnValue(false);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'wrong-password' }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Invalid login or password.' });
    });
  });

  it('returns the current user and visible projects for authenticated callers', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/me', {
        headers: { 'x-test-role': 'admin' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        user: helpers.buildPublicUser(),
        projects: [{ id: 'project-1', name: 'Project One' }],
      });
    });

    expect(mocks.attachAuthContext).toHaveBeenCalledTimes(1);
  });
});