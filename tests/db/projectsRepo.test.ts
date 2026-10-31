import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../src/utils/appErrors';
import { createMockDbHarness, createSchemaTables } from './helpers/mockDb';

type ProjectsRepoModule = typeof import('../../src/db/repositories/projects');

describe('projectsRepo', () => {
  const schemaTables = createSchemaTables();

  let dbHarness = createMockDbHarness();
  let selectAll = vi.fn();
  let selectOne = vi.fn();
  let execute = vi.fn();
  let markDirty = vi.fn();
  let findByProject = vi.fn();
  let seedProjectCategories = vi.fn();
  let projectsModule: ProjectsRepoModule;

  async function loadModule() {
    vi.resetModules();

    dbHarness = createMockDbHarness();
    selectAll = vi.fn();
    selectOne = vi.fn();
    execute = vi.fn();
    markDirty = vi.fn();
    findByProject = vi.fn();
    seedProjectCategories = vi.fn();

    vi.doMock('drizzle-orm', () => ({
      eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
    }));

    vi.doMock('uuid', () => ({
      v4: vi.fn(() => 'project-uuid'),
    }));

    vi.doMock('../../src/db/connection', () => ({
      db: () => dbHarness.api,
      selectAll,
      selectOne,
      execute,
      markDirty,
    }));

    vi.doMock('../../src/db/schema', async () => {
      const actual = await vi.importActual<typeof import('../../src/db/schema')>('../../src/db/schema');
      return {
        ...actual,
        getSchema: () => schemaTables,
      };
    });

    vi.doMock('../../src/db/repositories/categories', () => ({
      categoriesRepo: {
        findByProject,
      },
      seedProjectCategories,
    }));

    projectsModule = await import('../../src/db/repositories/projects');
  }

  beforeEach(async () => {
    await loadModule();
  });

  it('returns all projects for admins without checking memberships', async () => {
    const allProjects = [
      { id: 'project-1', name: 'Project One' },
      { id: 'project-2', name: 'Project Two' },
    ];
    selectAll.mockResolvedValueOnce(allProjects);

    const result = await projectsModule.projectsRepo.findAllForUser({
      id: 'admin-1',
      role: 'admin',
      accessAllProjects: true,
    });

    expect(result).toEqual(allProjects);
    expect(selectAll).toHaveBeenCalledTimes(1);
  });

  it('filters projects to the caller memberships for scoped users', async () => {
    selectAll
      .mockResolvedValueOnce([{ projectId: 'project-2' }])
      .mockResolvedValueOnce([
        { id: 'project-1', name: 'Project One' },
        { id: 'project-2', name: 'Project Two' },
      ]);

    const result = await projectsModule.projectsRepo.findAllForUser({
      id: 'user-1',
      role: 'user',
      accessAllProjects: false,
    });

    expect(result).toEqual([{ id: 'project-2', name: 'Project Two' }]);
    expect(selectAll).toHaveBeenCalledTimes(2);
  });

  it('creates a project, stores serialized settings, and seeds default categories when missing', async () => {
    findByProject.mockResolvedValueOnce([]);
    selectOne.mockResolvedValueOnce({
      id: 'project-uuid',
      name: 'Project One',
      rootPath: 'D:/repo/project-one',
      settings: '{"mainModel":"gpt-4.1-mini"}',
    });

    const created = await projectsModule.projectsRepo.create({
      name: 'Project One',
      rootPath: 'D:/repo/project-one',
      settings: { mainModel: 'gpt-4.1-mini' },
    });

    const insertRecord = dbHarness.lastRecord('insert');

    expect(created).toEqual({
      id: 'project-uuid',
      name: 'Project One',
      rootPath: 'D:/repo/project-one',
      settings: '{"mainModel":"gpt-4.1-mini"}',
    });
    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        id: 'project-uuid',
        name: 'Project One',
        rootPath: 'D:/repo/project-one',
        pathPattern: null,
        isDefault: false,
        settings: '{"mainModel":"gpt-4.1-mini"}',
      })
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(seedProjectCategories).toHaveBeenCalledWith('project-uuid');
  });

  it('maps duplicate root-path failures to a project conflict error', async () => {
    execute.mockRejectedValueOnce({
      code: '23505',
      message: 'duplicate key value violates unique constraint "projects_root_path_key"',
    });

    const error = await projectsModule.projectsRepo
      .create({ name: 'Project One', rootPath: 'D:/repo/project-one' })
      .catch((caught) => caught as AppError);

    expect(error.code).toBe('project_conflict');
    expect(error.statusCode).toBe(409);
    expect(seedProjectCategories).not.toHaveBeenCalled();
  });

  it('marks an existing default-root project as default instead of creating a duplicate', async () => {
    selectOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 'project-9',
        name: 'Legacy Default',
        rootPath: 'default',
        isDefault: false,
        settings: '{}',
      })
      .mockResolvedValueOnce({
        id: 'project-9',
        name: 'Legacy Default',
        rootPath: 'default',
        isDefault: true,
        settings: '{}',
      });
    findByProject.mockResolvedValueOnce([{ id: 'cat-1' }]);

    const project = await projectsModule.projectsRepo.ensureDefaultProject();

    const updateRecord = dbHarness.lastRecord('update');

    expect(project).toEqual({
      id: 'project-9',
      name: 'Legacy Default',
      rootPath: 'default',
      isDefault: true,
      settings: '{}',
    });
    expect(updateRecord?.set).toEqual(
      expect.objectContaining({
        isDefault: true,
        updatedAt: expect.any(Date),
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(seedProjectCategories).not.toHaveBeenCalled();
  });

  it('returns an empty settings object when the stored payload is invalid JSON', () => {
    expect(projectsModule.projectsRepo.getSettings({ settings: 'not-json' } as any)).toEqual({});
  });
});