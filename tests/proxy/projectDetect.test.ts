import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectsRepo: {
    upsertByRootPath: vi.fn(),
    findByRootPath: vi.fn(),
    findByName: vi.fn(),
    findAllWithPathPatterns: vi.fn(),
    findAllWithPathPatternsForUser: vi.fn(),
    ensureDefaultProject: vi.fn(),
  },
  projectMembersRepo: {
    canAccessProject: vi.fn(),
    grant: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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

import { projectDetectMiddleware } from '../../src/proxy/middleware/projectDetect';
import { getLastClientInfo, resetClientInfo } from '../../src/proxy/clientInfo';

function makeReq(body: Record<string, unknown> = {}, headers: Record<string, unknown> = {}) {
  return {
    body,
    headers,
  } as Parameters<typeof projectDetectMiddleware>[0];
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Parameters<typeof projectDetectMiddleware>[1];
}

describe('projectDetectMiddleware', () => {
  beforeEach(() => {
    mocks.projectsRepo.upsertByRootPath.mockReset();
    mocks.projectsRepo.findByRootPath.mockReset();
    mocks.projectsRepo.findByName.mockReset();
    mocks.projectsRepo.findAllWithPathPatterns.mockReset();
    mocks.projectsRepo.findAllWithPathPatternsForUser.mockReset();
    mocks.projectsRepo.ensureDefaultProject.mockReset();
    mocks.projectMembersRepo.canAccessProject.mockReset();
    mocks.projectMembersRepo.grant.mockReset();
    mocks.logger.info.mockReset();
    resetClientInfo();

    mocks.projectsRepo.findByName.mockResolvedValue(undefined);
    mocks.projectsRepo.findAllWithPathPatterns.mockResolvedValue([]);
    mocks.projectsRepo.findAllWithPathPatternsForUser.mockResolvedValue([]);
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(true);
  });

  it('uses the seeded default project when no match is found', async () => {
    mocks.projectsRepo.ensureDefaultProject.mockResolvedValue({
      id: 'default-project',
      name: 'Default Project',
      rootPath: 'default',
      pathPattern: null,
      isDefault: true,
      settings: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = makeReq({ messages: [] });
    const next = vi.fn();

    await projectDetectMiddleware(req, makeRes(), next);

    expect(mocks.projectsRepo.ensureDefaultProject).toHaveBeenCalledTimes(1);
    expect(req.projectId).toBe('default-project');
    expect(req.projectName).toBe('Default Project');
    expect(req.projectRoot).toBe('default');
    expect(req.projectSource).toBe('default');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('prefers the workspace hint before falling back to the default project', async () => {
    mocks.projectsRepo.upsertByRootPath.mockResolvedValue({
      id: 'project-1',
      name: 'Repo One',
      rootPath: 'C:\\repo-one',
      pathPattern: null,
      isDefault: false,
      settings: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = makeReq({ workspace_root: 'C:\\repo-one' });
    const next = vi.fn();

    await projectDetectMiddleware(req, makeRes(), next);

    expect(mocks.projectsRepo.upsertByRootPath).toHaveBeenCalledWith('C:\\repo-one');
    expect(mocks.projectsRepo.ensureDefaultProject).not.toHaveBeenCalled();
    expect(req.projectId).toBe('project-1');
    expect(req.projectSource).toBe('body-hint');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('skips the default project when the authenticated user does not have access to it', async () => {
    mocks.projectsRepo.ensureDefaultProject.mockResolvedValue({
      id: 'default-project',
      name: 'Default Project',
      rootPath: 'default',
      pathPattern: null,
      isDefault: true,
      settings: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(false);

    const req = makeReq({ messages: [] });
    req.user = {
      id: 'user-1',
      email: 'user@example.com',
      role: 'user',
      isApproved: true,
      isDisabled: false,
      accessAllProjects: false,
      accessAllModels: false,
      allowedModels: [],
      createdAt: new Date(),
      lastLoginAt: null,
    } as any;
    const next = vi.fn();

    await projectDetectMiddleware(req, makeRes(), next);

    expect(req.projectId).toBeUndefined();
    expect(req.projectSource).toBe('none');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects explicit project hints for projects the user cannot access', async () => {
    mocks.projectsRepo.findByRootPath.mockResolvedValue({
      id: 'project-2',
      name: 'Repo Two',
      rootPath: 'C:\\repo-two',
      pathPattern: null,
      isDefault: false,
      settings: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(false);

    const req = makeReq({}, { 'x-project-root': 'C:\\repo-two' });
    req.user = {
      id: 'user-2',
      email: 'limited@example.com',
      role: 'user',
      isApproved: true,
      isDisabled: false,
      accessAllProjects: false,
      accessAllModels: false,
      allowedModels: [],
      createdAt: new Date(),
      lastLoginAt: null,
    } as any;
    const res = makeRes();
    const next = vi.fn();

    await projectDetectMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('detects a project from the X-IC-Project-Name header when no root path is sent', async () => {
    mocks.projectsRepo.findByName.mockResolvedValue({
      id: 'project-named',
      name: 'intelligent-context',
      rootPath: 'C:\\src\\intelligent-context',
      pathPattern: null,
      isDefault: false,
      settings: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = makeReq({ messages: [] }, { 'x-ic-project-name': 'intelligent-context' });
    const next = vi.fn();

    await projectDetectMiddleware(req, makeRes(), next);

    expect(mocks.projectsRepo.findByName).toHaveBeenCalledWith('intelligent-context');
    expect(mocks.projectsRepo.ensureDefaultProject).not.toHaveBeenCalled();
    expect(req.projectId).toBe('project-named');
    expect(req.projectSource).toBe('name-hint');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls through to the default project when the name hint matches nothing', async () => {
    mocks.projectsRepo.findByName.mockResolvedValue(undefined);
    mocks.projectsRepo.ensureDefaultProject.mockResolvedValue({
      id: 'default-project',
      name: 'Default Project',
      rootPath: 'default',
      pathPattern: null,
      isDefault: true,
      settings: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = makeReq({ messages: [] }, { 'x-ic-project-name': 'unknown-workspace' });
    const next = vi.fn();

    await projectDetectMiddleware(req, makeRes(), next);

    expect(req.projectId).toBe('default-project');
    expect(req.projectSource).toBe('default');
  });

  it('records the IDE client identity reported via X-IC-* headers', async () => {
    mocks.projectsRepo.findByName.mockResolvedValue({
      id: 'project-named',
      name: 'intelligent-context',
      rootPath: 'C:\\src\\intelligent-context',
      pathPattern: null,
      isDefault: false,
      settings: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = makeReq(
      { messages: [] },
      {
        'user-agent': 'Visual Studio Code 1.104.0',
        'x-ic-project-name': 'intelligent-context',
        'x-ic-file': 'C:\\src\\intelligent-context\\src\\index.ts',
        'x-ic-branch': 'feat/vscode-provider',
      }
    );

    await projectDetectMiddleware(req, makeRes(), vi.fn());

    const client = getLastClientInfo();
    expect(client?.ide).toBe('VS Code');
    expect(client?.projectName).toBe('intelligent-context');
    expect(client?.resolvedProjectName).toBe('intelligent-context');
    expect(client?.file).toBe('C:\\src\\intelligent-context\\src\\index.ts');
    expect(client?.branch).toBe('feat/vscode-provider');
  });
});