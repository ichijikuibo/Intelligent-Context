import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

const helpers = vi.hoisted(() => ({
  buildUser: (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'stored-password-hash',
    role: 'user',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: false,
    accessAllModels: false,
    allowedModels: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastLoginAt: null,
    ...overrides,
  }),
  buildPublicUser: (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'user@example.com',
    role: 'user',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: false,
    accessAllModels: false,
    allowedModels: [],
    createdAt: new Date(0).toISOString(),
    lastLoginAt: null,
    ...overrides,
  }),
}));

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  projectMembersRepo: {
    listByUser: vi.fn(),
    replaceForUser: vi.fn(),
  },
  projectsRepo: {
    findAll: vi.fn(),
  },
  usersRepo: {
    findAll: vi.fn(),
    create: vi.fn(),
    toPublicUser: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../src/auth/credentials', () => ({
  hashPassword: mocks.hashPassword,
}));

vi.mock('../../src/auth/context', async (importOriginal) => {
  // Keep the real helpers (grant normalisation, access checks) and only stub
  // the Express middleware factories the router mounts.
  const actual = await importOriginal<typeof import('../../src/auth/context')>();
  const ranks = { user: 1, power_user: 2, admin: 3 };

  return {
    ...actual,
    requireAuthenticated: () => (req: any, res: any, next: () => void) => {
      const roleHeader = req.headers['x-test-role'];
      if (typeof roleHeader !== 'string' || roleHeader.length === 0) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }

      req.user = helpers.buildPublicUser({
        role: roleHeader,
        accessAllProjects: roleHeader === 'admin',
        accessAllModels: roleHeader === 'admin',
      });
      req.userId = req.user.id;
      req.userRole = req.user.role;
      next();
    },
    requireRole: (minRole: 'admin' | 'power_user' | 'user') => (req: any, res: any, next: () => void) => {
      const currentRole = req.userRole as 'admin' | 'power_user' | 'user' | undefined;
      if (!currentRole || ranks[currentRole] < ranks[minRole]) {
        res.status(403).json({ error: 'You do not have access to this action.' });
        return;
      }

      next();
    },
  };
});

vi.mock('../../src/db/repositories/projectMembers', () => ({
  projectMembersRepo: mocks.projectMembersRepo,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/db/repositories/users', () => ({
  usersRepo: mocks.usersRepo,
}));

import { createUsersRouter } from '../../src/api/routes/users';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(createUsersRouter());
  return app;
}

describe('createUsersRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.hashPassword.mockReturnValue('hashed-password');
    mocks.usersRepo.toPublicUser.mockImplementation((user: any) =>
      helpers.buildPublicUser({
        id: user.id,
        email: user.email,
        role: user.role,
        isApproved: user.isApproved,
        isDisabled: user.isDisabled,
        accessAllProjects: user.accessAllProjects,
        accessAllModels: user.accessAllModels,
        allowedModels: user.allowedModels,
      })
    );
    mocks.usersRepo.findAll.mockResolvedValue([
      helpers.buildUser({ id: 'user-1', email: 'user@example.com' }),
    ]);
    mocks.projectsRepo.findAll.mockResolvedValue([{ id: 'project-1', name: 'Project One' }]);
    mocks.projectMembersRepo.listByUser.mockResolvedValue([{ projectId: 'project-1' }]);
  });

  it('rejects unauthenticated access to the users collection', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Authentication required.' });
    });
  });

  it('rejects non-admin access to the users collection', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        headers: { 'x-test-role': 'user' },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'You do not have access to this action.' });
    });
  });

  it('returns users with their project memberships for admins', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        headers: { 'x-test-role': 'admin' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          ...helpers.buildPublicUser(),
          projectIds: ['project-1'],
          projects: [{ id: 'project-1', name: 'Project One' }],
        },
      ]);
    });
  });

  it('validates create-user requests before persisting', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'admin',
        },
        body: JSON.stringify({ email: 'new@example.com', role: 'super-admin' }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Email, password, and role are required.' });
    });
  });

  it('creates scoped users and assigns the requested project memberships', async () => {
    const createdUser = helpers.buildUser({
      id: 'user-2',
      email: 'new@example.com',
      role: 'user',
      accessAllProjects: false,
      accessAllModels: false,
      allowedModels: ['gpt-4.1-mini'],
    });
    mocks.usersRepo.create.mockResolvedValue(createdUser);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'admin',
        },
        body: JSON.stringify({
          email: 'new@example.com',
          password: 'secret-password',
          role: 'user',
          allowedModels: ['gpt-4.1-mini'],
          projectIds: ['project-1'],
        }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual(
        helpers.buildPublicUser({
          id: 'user-2',
          email: 'new@example.com',
          allowedModels: ['gpt-4.1-mini'],
        })
      );
    });

    expect(mocks.hashPassword).toHaveBeenCalledWith('secret-password');
    expect(mocks.projectMembersRepo.replaceForUser).toHaveBeenCalledWith('user-2', ['project-1']);
  });

  it('stores wildcard grants and prunes ones covered by a broader grant', async () => {
    mocks.usersRepo.create.mockResolvedValue(helpers.buildUser({ id: 'user-9' }));

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
        body: JSON.stringify({
          email: 'wild@example.com',
          password: 'secret-password',
          role: 'user',
          allowedModels: ['OCA-*', 'OCA-deepseek-v4', 'DSK-glm-5', '  ', 'OCA-*'],
        }),
      });

      expect(response.status).toBe(201);
    });

    expect(mocks.usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ allowedModels: ['OCA-*', 'DSK-glm-5'] })
    );
  });

  it('never leaves an admin restricted', async () => {
    mocks.usersRepo.findById.mockResolvedValue(helpers.buildUser({ id: 'user-4', role: 'user' }));
    mocks.usersRepo.update.mockResolvedValue(helpers.buildUser({ id: 'user-4', role: 'admin' }));

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/user-4', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
        body: JSON.stringify({
          role: 'admin',
          accessAllModels: false,
          allowedModels: ['OCA-*'],
        }),
      });

      expect(response.status).toBe(200);
    });

    // Promoting to admin clears the grant list and forces unrestricted access,
    // so an admin can never be locked out of the models they administer.
    expect(mocks.usersRepo.update).toHaveBeenCalledWith(
      'user-4',
      expect.objectContaining({ accessAllModels: true, allowedModels: [] })
    );
  });

  it('clears explicit project memberships when an update grants access to all projects', async () => {
    mocks.usersRepo.findById.mockResolvedValue(helpers.buildUser({ id: 'user-3', email: 'user3@example.com' }));
    mocks.usersRepo.update.mockResolvedValue(
      helpers.buildUser({
        id: 'user-3',
        email: 'user3@example.com',
        role: 'user',
        accessAllProjects: true,
      })
    );

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/user-3', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'admin',
        },
        body: JSON.stringify({ accessAllProjects: true }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        helpers.buildPublicUser({
          id: 'user-3',
          email: 'user3@example.com',
          accessAllProjects: true,
        })
      );
    });

    expect(mocks.projectMembersRepo.replaceForUser).toHaveBeenCalledWith('user-3', []);
  });
});