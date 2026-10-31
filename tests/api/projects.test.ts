import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

const helpers = vi.hoisted(() => ({
  buildUser: (role: 'admin' | 'power_user' | 'user', accessAllProjects = role === 'admin') => ({
    id: 'user-1',
    email: 'user@example.com',
    role,
    isApproved: true,
    isDisabled: false,
    accessAllProjects,
    accessAllModels: true,
    allowedModels: [],
    createdAt: new Date(0),
    lastLoginAt: null,
  }),
}));

const mocks = vi.hoisted(() => ({
  projectsRepo: {
    findAllForUser: vi.fn(),
    getSettings: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  projectMembersRepo: {
    grant: vi.fn(),
    canAccessProject: vi.fn(),
  },
  formatZodError: vi.fn(() => 'validation.error'),
  t: vi.fn((_: unknown, key: string) => key),
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/db/repositories/projectMembers', () => ({
  projectMembersRepo: mocks.projectMembersRepo,
}));

vi.mock('../../src/i18n', () => ({
  formatZodError: mocks.formatZodError,
  t: mocks.t,
}));

import { createProjectsRouter } from '../../src/api/routes/projects';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const roleHeader = req.headers['x-test-role'];
    if (typeof roleHeader === 'string' && roleHeader.length > 0) {
      req.user = helpers.buildUser(roleHeader as 'admin' | 'power_user' | 'user', roleHeader === 'admin');
      req.userRole = req.user.role;
    }
    next();
  });
  app.use(createProjectsRouter());
  return app;
}

describe('createProjectsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectsRepo.getSettings.mockReturnValue({});
    mocks.projectsRepo.findAllForUser.mockResolvedValue([{ id: 'project-1', name: 'Project One', settings: '{}' }]);
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(true);
  });

  it('requires authentication to list projects', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Authentication required.' });
    });
  });

  it('rejects project creation for callers without admin or power-user access', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'user',
        },
        body: JSON.stringify({ name: 'Project One', rootPath: '/repo/project-one' }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'You do not have access to this action.' });
    });
  });

  it('returns a validation error for invalid create payloads', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'power_user',
        },
        body: JSON.stringify({ name: '', rootPath: '' }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'validation.error' });
    });

    expect(mocks.formatZodError).toHaveBeenCalledTimes(1);
  });

  it('creates a project and grants membership to scoped creators', async () => {
    const createdProject = { id: 'project-1', name: 'Project One', rootPath: '/repo/project-one', settings: '{}' };
    mocks.projectsRepo.create.mockResolvedValue(createdProject);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-role': 'power_user',
        },
        body: JSON.stringify({
          name: 'Project One',
          rootPath: '/repo/project-one',
          settings: { mainModel: 'gpt-4.1-mini' },
        }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        id: 'project-1',
        name: 'Project One',
        rootPath: '/repo/project-one',
        settings: {},
      });
    });

    expect(mocks.projectMembersRepo.grant).toHaveBeenCalledWith('project-1', 'user-1');
  });

  it('returns not found when a caller cannot access the requested project', async () => {
    mocks.projectsRepo.findById.mockResolvedValue({ id: 'project-1', name: 'Project One', settings: '{}' });
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(false);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/project-1', {
        headers: { 'x-test-role': 'power_user' },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'api.error.projectNotFound' });
    });
  });
});