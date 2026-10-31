import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDbHarness, createSchemaTables } from './helpers/mockDb';

type ProjectMembersRepoModule = typeof import('../../src/db/repositories/projectMembers');

describe('projectMembersRepo', () => {
  const schemaTables = createSchemaTables();

  let dbHarness = createMockDbHarness();
  let selectAll = vi.fn();
  let selectOne = vi.fn();
  let execute = vi.fn();
  let markDirty = vi.fn();
  let projectMembersModule: ProjectMembersRepoModule;

  async function loadModule() {
    vi.resetModules();

    dbHarness = createMockDbHarness();
    selectAll = vi.fn();
    selectOne = vi.fn();
    execute = vi.fn();
    markDirty = vi.fn();

    vi.doMock('drizzle-orm', () => ({
      eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
      and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
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

    projectMembersModule = await import('../../src/db/repositories/projectMembers');
  }

  beforeEach(async () => {
    await loadModule();
  });

  it('updates the role when granting membership that already exists', async () => {
    const existingSpy = vi
      .spyOn(projectMembersModule.projectMembersRepo, 'findByProjectAndUser')
      .mockResolvedValue({ projectId: 'project-1', userId: 'user-1', role: 'member' } as any);

    await projectMembersModule.projectMembersRepo.grant('project-1', 'user-1', 'owner');

    const updateRecord = dbHarness.lastRecord('update');

    expect(updateRecord?.set).toEqual({ role: 'owner' });
    expect(markDirty).toHaveBeenCalledTimes(1);

    existingSpy.mockRestore();
  });

  it('inserts a new membership when no existing row is found', async () => {
    const existingSpy = vi
      .spyOn(projectMembersModule.projectMembersRepo, 'findByProjectAndUser')
      .mockResolvedValue(undefined);

    await projectMembersModule.projectMembersRepo.grant('project-1', 'user-1');

    const insertRecord = dbHarness.lastRecord('insert');

    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        userId: 'user-1',
        role: 'member',
        createdAt: expect.any(Date),
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);

    existingSpy.mockRestore();
  });

  it('replaces memberships using a deduped project list', async () => {
    await projectMembersModule.projectMembersRepo.replaceForUser('user-1', ['project-1', 'project-2', 'project-1']);

    const deleteRecords = dbHarness.records.filter((record) => record.kind === 'delete');
    const insertRecords = dbHarness.records.filter((record) => record.kind === 'insert');

    expect(deleteRecords).toHaveLength(1);
    expect(insertRecords).toHaveLength(2);
    expect(insertRecords.map((record) => (record.values as { projectId: string }).projectId)).toEqual([
      'project-1',
      'project-2',
    ]);
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('allows project access immediately for admins and falls back to membership checks otherwise', async () => {
    const findSpy = vi.spyOn(projectMembersModule.projectMembersRepo, 'findByProjectAndUser');

    expect(
      await projectMembersModule.projectMembersRepo.canAccessProject(
        { id: 'admin-1', role: 'admin', accessAllProjects: false },
        'project-1'
      )
    ).toBe(true);
    expect(findSpy).not.toHaveBeenCalled();

    findSpy.mockResolvedValueOnce(undefined as any);
    expect(
      await projectMembersModule.projectMembersRepo.canAccessProject(
        { id: 'user-1', role: 'user', accessAllProjects: false },
        'project-1'
      )
    ).toBe(false);

    findSpy.mockRestore();
  });
});