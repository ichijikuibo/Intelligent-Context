import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDbHarness, createSchemaTables } from './helpers/mockDb';

type SummariesRepoModule = typeof import('../../src/db/repositories/summaries');

describe('summariesRepo', () => {
  const schemaTables = createSchemaTables();

  let dbHarness = createMockDbHarness();
  let selectAll = vi.fn();
  let selectOne = vi.fn();
  let execute = vi.fn();
  let markDirty = vi.fn();
  let summariesModule: SummariesRepoModule;

  async function loadModule() {
    vi.resetModules();

    dbHarness = createMockDbHarness();
    selectAll = vi.fn().mockResolvedValue([]);
    selectOne = vi.fn();
    execute = vi.fn();
    markDirty = vi.fn();

    vi.doMock('drizzle-orm', () => ({
      eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
      and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
      isNull: (value: unknown) => ({ op: 'isNull', value }),
      desc: (value: unknown) => ({ op: 'desc', value }),
      sql: vi.fn((_strings: TemplateStringsArray) => ({ op: 'sql' })),
      inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
    }));

    vi.doMock('uuid', () => ({
      v4: vi.fn(() => 'summary-uuid'),
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

    summariesModule = await import('../../src/db/repositories/summaries');
  }

  beforeEach(async () => {
    await loadModule();
  });

  it('converts count results to numbers for project summary totals', async () => {
    selectOne.mockResolvedValueOnce({ count: '7' });

    const result = await summariesModule.summariesRepo.countByProject('project-1');

    expect(result).toBe(7);
  });

  it('inserts summaries with serialized source chunk ids and default metadata', async () => {
    selectOne.mockResolvedValueOnce({
      id: 'summary-uuid',
      projectId: 'project-1',
      title: 'Summary',
      content: 'Body',
      sourceChunkIds: '["chunk-1","chunk-2"]',
      version: 1,
    });

    const created = await summariesModule.summariesRepo.insert({
      projectId: 'project-1',
      title: 'Summary',
      content: 'Body',
      sourceChunkIds: ['chunk-1', 'chunk-2'],
    });

    const insertRecord = dbHarness.lastRecord('insert');

    expect(created).toEqual(
      expect.objectContaining({
        id: 'summary-uuid',
      })
    );
    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        id: 'summary-uuid',
        sourceChunkIds: '["chunk-1","chunk-2"]',
        oneLineSummary: '',
        categoriesList: '[]',
        version: 1,
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('increments the version and serializes sourceChunkIds when updating', async () => {
    const findSpy = vi.spyOn(summariesModule.summariesRepo, 'findById');
    findSpy
      .mockResolvedValueOnce({ id: 'summary-1', version: 3 } as any)
      .mockResolvedValueOnce({ id: 'summary-1', version: 4, sourceChunkIds: '["chunk-3"]' } as any);

    const updated = await summariesModule.summariesRepo.update('summary-1', {
      title: 'Updated Summary',
      sourceChunkIds: ['chunk-3'],
    });

    const updateRecord = dbHarness.lastRecord('update');

    expect(updated).toEqual(expect.objectContaining({ id: 'summary-1', version: 4 }));
    expect(updateRecord?.set).toEqual(
      expect.objectContaining({
        title: 'Updated Summary',
        sourceChunkIds: '["chunk-3"]',
        version: 4,
        updatedAt: expect.any(String),
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);

    findSpy.mockRestore();
  });

  it('returns the newest summary whose categories list contains the requested category', async () => {
    selectAll.mockResolvedValueOnce([
      { id: 'summary-1', categoriesList: '["auth"]' },
      { id: 'summary-2', categoriesList: 'not-json' },
      { id: 'summary-3', categoriesList: '["billing","auth"]' },
    ]);

    const found = await summariesModule.summariesRepo.findByCategory('project-1', 'auth');

    expect(found).toEqual({ id: 'summary-1', categoriesList: '["auth"]' });
  });

  it('soft-deletes summaries by stamping deletedAt', async () => {
    selectOne.mockResolvedValueOnce({ id: 'summary-1', projectId: 'project-1', sourceChunkIds: '[]' });
    selectAll.mockResolvedValue([]);

    await summariesModule.summariesRepo.softDelete('summary-1');

    const updateRecord = dbHarness.lastRecord('update');

    expect(updateRecord?.set).toEqual({ deletedAt: expect.any(String) });
    expect(markDirty).toHaveBeenCalledTimes(2);
  });
});