import { beforeEach, describe, expect, it, vi } from 'vitest';

type MigrateModule = typeof import('../../src/db/migrate');

describe('db/migrate', () => {
  let getDialect = vi.fn();
  let getRawDb = vi.fn();
  let getPgPool = vi.fn();
  let markDirty = vi.fn();
  let saveDatabase = vi.fn();
  let logger: Record<string, ReturnType<typeof vi.fn>>;
  let migrateModule: MigrateModule;

  async function loadModule() {
    vi.resetModules();

    getDialect = vi.fn();
    getRawDb = vi.fn();
    getPgPool = vi.fn();
    markDirty = vi.fn();
    saveDatabase = vi.fn();
    logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const mockQueryChain = {
      from: () => mockQueryChain,
      innerJoin: () => mockQueryChain,
      where: () => mockQueryChain,
      orderBy: () => mockQueryChain,
      limit: () => mockQueryChain,
      offset: () => mockQueryChain,
      all: () => [],
      get: () => undefined,
      run: () => {},
    };

    vi.doMock('../../src/db/connection', () => ({
      getDialect,
      getRawDb,
      getPgPool,
      markDirty,
      saveDatabase,
      db: vi.fn(() => ({
        select: () => mockQueryChain,
        insert: () => mockQueryChain,
        update: () => mockQueryChain,
        delete: () => mockQueryChain,
      })),
      selectAll: vi.fn(() => [] as unknown[]),
      // The migration runner rebuilds the file index after migrating.
      selectOne: vi.fn(() => Promise.resolve(undefined)),
      execute: vi.fn(() => Promise.resolve()),
    }));

    vi.doMock('../../src/utils/logger', () => ({
      logger,
    }));

    migrateModule = await import('../../src/db/migrate');
    return migrateModule;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies pending sqlite migrations and persists the database afterward', async () => {
    const rawDb = {
      exec: vi.fn(() => []),
      run: vi.fn(),
    };

    const module = await loadModule();

    getDialect.mockReturnValue('sqlite');
    getRawDb.mockReturnValue(rawDb);

    await module.runMigrations();

    expect(rawDb.run.mock.calls.some(([sql]) => String(sql).includes('CREATE TABLE IF NOT EXISTS _migrations'))).toBe(true);
    expect(rawDb.run.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO _migrations'))).toBe(true);
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(saveDatabase).toHaveBeenCalledTimes(1);
  });

  it('marks sqlite duplicate-column failures as applied instead of throwing', async () => {
    let duplicateThrown = false;
    const rawDb = {
      exec: vi.fn(() => []),
      run: vi.fn((sql: string) => {
        if (!duplicateThrown && sql.includes('CREATE TABLE IF NOT EXISTS projects')) {
          duplicateThrown = true;
          throw new Error('duplicate column name: path_pattern');
        }
      }),
    };

    const module = await loadModule();

    getDialect.mockReturnValue('sqlite');
    getRawDb.mockReturnValue(rawDb);

    await expect(module.runMigrations()).resolves.toBeUndefined();
    expect(rawDb.run.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO _migrations'))).toBe(true);
  });

  it('applies pending postgres migrations and records them', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name FROM _migrations')) {
          return { rowCount: 0, rows: [] };
        }

        return { rowCount: 0, rows: [] };
      }),
    };

    const module = await loadModule();

    getDialect.mockReturnValue('postgres');
    getPgPool.mockReturnValue(pool);

    await module.runMigrations();

    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes('CREATE TABLE IF NOT EXISTS _migrations'))).toBe(true);
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO _migrations'))).toBe(true);
  });

  it('marks postgres duplicate-object failures as applied instead of throwing', async () => {
    let duplicateThrown = false;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name FROM _migrations')) {
          return { rowCount: 0, rows: [] };
        }

        if (!duplicateThrown && sql.includes('CREATE TABLE IF NOT EXISTS projects')) {
          duplicateThrown = true;
          throw new Error('duplicate relation already exists');
        }

        return { rowCount: 0, rows: [] };
      }),
    };

    const module = await loadModule();

    getDialect.mockReturnValue('postgres');
    getPgPool.mockReturnValue(pool);

    await expect(module.runMigrations()).resolves.toBeUndefined();
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes('ON CONFLICT DO NOTHING'))).toBe(true);
  });
});