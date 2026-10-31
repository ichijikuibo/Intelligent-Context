import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { withTestServer } from '../helpers/http';
import type { PublicUser } from '../../src/db/repositories/users';

const mocks = vi.hoisted(() => ({
  attachAuthContext: vi.fn(),
  executeLearningTool: vi.fn(),
  projectsRepo: {
    findAllForUser: vi.fn(),
    findById: vi.fn(),
    findDefault: vi.fn(),
  },
  projectMembersRepo: {
    canAccessProject: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/auth/context', () => ({
  attachAuthContext: mocks.attachAuthContext,
}));

vi.mock('../../src/proxy/tools/executor', () => ({
  executeLearningTool: mocks.executeLearningTool,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/db/repositories/projectMembers', () => ({
  projectMembersRepo: mocks.projectMembersRepo,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import { createMcpRouter } from '../../src/mcp/route';

const USER: PublicUser = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'user',
  isApproved: true,
  isDisabled: false,
  accessAllProjects: false,
  accessAllModels: false,
  allowedModels: [],
  createdAt: new Date(0),
  lastLoginAt: null,
};

function makeProject(id: string) {
  return {
    id,
    name: `Project ${id}`,
    rootPath: `/repos/${id}`,
    pathPattern: null,
    isDefault: true,
    settings: '{}',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    summarizationLastRun: null,
    analyzerLastRun: null,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter());
  return app;
}

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  };
}

describe('createMcpRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectsRepo.findAllForUser.mockResolvedValue([makeProject('project-1')]);
    mocks.projectsRepo.findById.mockResolvedValue(makeProject('project-1'));
    mocks.projectsRepo.findDefault.mockResolvedValue(makeProject('project-1'));
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(true);
    mocks.executeLearningTool.mockResolvedValue({ success: true, result: { ok: true } });
  });

  it('rejects unauthenticated requests with a JSON-RPC error', async () => {
    mocks.attachAuthContext.mockResolvedValue(null);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(initializeRequest()),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toMatch(/Authentication required/);
    });
  });

  it('answers an authenticated initialize request', async () => {
    mocks.attachAuthContext.mockResolvedValue(USER);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-key',
        },
        body: JSON.stringify(initializeRequest()),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.serverInfo.name).toBe('intelligent-context');
      expect(body.result.instructions).toMatch(/record/i);
    });
  });

  it('lists tools over the authenticated HTTP transport', async () => {
    mocks.attachAuthContext.mockResolvedValue(USER);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-key',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      const names = body.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain('search_project_context');
      expect(names).toContain('record_learning');
    });
  });

  it('does not allow GET or DELETE', async () => {
    mocks.attachAuthContext.mockResolvedValue(USER);

    await withTestServer(createApp(), async ({ request }) => {
      const get = await request('/mcp', { method: 'GET' });
      const del = await request('/mcp', { method: 'DELETE' });
      expect(get.status).toBe(405);
      expect(del.status).toBe(405);
    });
  });
});
