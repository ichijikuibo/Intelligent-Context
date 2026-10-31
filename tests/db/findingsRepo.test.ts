import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDbHarness, createSchemaTables } from './helpers/mockDb';

type FindingsRepoModule = typeof import('../../src/db/repositories/findings');

describe('findingsRepo', () => {
  const schemaTables = createSchemaTables();

  let dbHarness = createMockDbHarness();
  let selectAll = vi.fn();
  let selectOne = vi.fn();
  let execute = vi.fn();
  let markDirty = vi.fn();
  let findingsModule: FindingsRepoModule;

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
      desc: (value: unknown) => ({ op: 'desc', value }),
    }));

    vi.doMock('uuid', () => ({
      v4: vi.fn(() => 'finding-uuid'),
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

    findingsModule = await import('../../src/db/repositories/findings');
  }

  beforeEach(async () => {
    await loadModule();
  });

  it('parses stored actions, including legacy update-text fields, when loading a finding', async () => {
    selectOne.mockResolvedValueOnce({
      id: 'finding-1',
      actions: JSON.stringify([
        { action: 'update', targetType: 'summary', targetId: 'summary-1', 'update-text': 'Replace stale text' },
        { action: 'done', targetType: 'finding', targetId: 'finding-1' },
        { action: 'delete', targetType: 'project', targetId: 'project-1' },
      ]),
    });

    const finding = await findingsModule.findingsRepo.findById('finding-1');

    expect(finding?.actions).toEqual([
      {
        action: 'update',
        targetType: 'summary',
        targetId: 'summary-1',
        updateText: 'Replace stale text',
      },
      {
        action: 'done',
        targetType: 'finding',
        targetId: 'finding-1',
      },
    ]);
  });

  it('counts open gaps by reusing the filtered gap query', async () => {
    const gaps = [{ id: 'finding-1' }, { id: 'finding-2' }];
    const findSpy = vi.spyOn(findingsModule.findingsRepo, 'findOpenGapsByProject').mockResolvedValue(gaps as any);

    const count = await findingsModule.findingsRepo.countOpenGapsByProject('project-1');

    expect(count).toBe(2);

    findSpy.mockRestore();
  });

  it('serializes relatedIds and actions when inserting a finding', async () => {
    selectOne.mockResolvedValueOnce({
      id: 'finding-uuid',
      actions: '[{"action":"delete","targetType":"chunk","targetId":"chunk-1"}]',
    });

    const created = await findingsModule.findingsRepo.insert({
      projectId: 'project-1',
      type: 'gap',
      severity: 'medium',
      title: 'Missing coverage',
      description: 'The project is missing a test.',
      relatedIds: { chunkIds: ['chunk-1'], summaryIds: ['summary-2'], findingIds: ['finding-3'] },
      actions: [{ action: 'delete', targetType: 'chunk', targetId: 'chunk-1' }],
    });

    const insertRecord = dbHarness.lastRecord('insert');

    expect(created).toEqual(expect.objectContaining({ id: 'finding-uuid' }));
    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        id: 'finding-uuid',
        relatedIds: '{"chunkIds":["chunk-1"],"summaryIds":["summary-2"],"findingIds":["finding-3"]}',
        actions: '[{"action":"delete","targetType":"chunk","targetId":"chunk-1"}]',
        status: 'open',
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('updates finding status with reviewed and applied timestamps', async () => {
    const reviewedAt = new Date('2026-01-02T00:00:00.000Z');
    const actionsAppliedAt = new Date('2026-01-03T00:00:00.000Z');
    const findSpy = vi.spyOn(findingsModule.findingsRepo, 'findById');
    findSpy.mockResolvedValueOnce({ id: 'finding-1', status: 'implemented', actions: [] } as any);

    const updated = await findingsModule.findingsRepo.updateStatus('finding-1', 'implemented', {
      reviewedAt,
      actionsAppliedAt,
    });

    const updateRecord = dbHarness.lastRecord('update');

    expect(updated).toEqual(expect.objectContaining({ id: 'finding-1', status: 'implemented' }));
    expect(updateRecord?.set).toEqual({
      status: 'implemented',
      reviewedAt,
      actionsAppliedAt,
    });
    expect(markDirty).toHaveBeenCalledTimes(1);

    findSpy.mockRestore();
  });
});