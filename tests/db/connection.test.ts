import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ConnectionModule = typeof import('../../src/db/connection');

describe('db/connection', () => {
  let existsSync = vi.fn();
  let mkdirSync = vi.fn();
  let readFileSync = vi.fn();
  let writeFileSync = vi.fn();
  let initSqlJs = vi.fn();
  let drizzleSqlJs = vi.fn();
  let drizzlePg = vi.fn();
  let Pool = vi.fn();
  let getConfig = vi.fn();
  let logger: Record<string, ReturnType<typeof vi.fn>>;
  let connectionModule: ConnectionModule | null = null;

  async function loadModule() {
    vi.resetModules();

    existsSync = vi.fn();
    mkdirSync = vi.fn();
    readFileSync = vi.fn();
    writeFileSync = vi.fn();
    initSqlJs = vi.fn();
    drizzleSqlJs = vi.fn();
    drizzlePg = vi.fn();
    Pool = vi.fn();
    getConfig = vi.fn();
    logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    vi.doMock('fs', () => ({
      existsSync,
      mkdirSync,
      readFileSync,
      writeFileSync,
    }));

    vi.doMock('sql.js', () => ({
      default: initSqlJs,
    }));

    vi.doMock('drizzle-orm/sql-js', () => ({
      drizzle: drizzleSqlJs,
    }));

    vi.doMock('drizzle-orm/node-postgres', () => ({
      drizzle: drizzlePg,
    }));

    vi.doMock('pg', () => ({
      Pool,
    }));

    vi.doMock('../../src/config/config', () => ({
      getConfig,
    }));

    vi.doMock('../../src/utils/logger', () => ({
      logger,
    }));

    connectionModule = await import('../../src/db/connection');
    return connectionModule;
  }

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (connectionModule) {
      try {
        await connectionModule.closeDatabase();
      } catch {
        // Ignore cleanup failures in tests that never initialized the module.
      }
    }
    connectionModule = null;
  });

  it('initializes sqlite connections and uses synchronous query helpers', async () => {
    const rawDb = {
      run: vi.fn(),
      export: vi.fn(() => new Uint8Array([1, 2, 3])),
      close: vi.fn(),
    };

    const module = await loadModule();

    existsSync.mockReturnValue(false);
    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    initSqlJs.mockResolvedValue({
      Database: vi.fn(function MockDatabase() {
        return rawDb;
      }),
    });
    drizzleSqlJs.mockReturnValue('sqlite-handle');
    getConfig.mockReturnValue({
      database: {
        type: 'sqlite',
        sqlitePath: 'C:/tmp/intelligent-context.sqlite',
        backupRetention: 2,
      },
    });

    const handle = await module.initDatabase();

    expect(handle).toBe('sqlite-handle');
    expect(mkdirSync).toHaveBeenCalledWith('C:/tmp', { recursive: true });
    expect(rawDb.run).toHaveBeenCalledWith('PRAGMA foreign_keys = ON');
    expect(module.getDialect()).toBe('sqlite');
    expect(module.getRawDb()).toBe(rawDb);

    const all = await module.selectAll({ all: vi.fn(() => [1, 2, 3]) });
    const one = await module.selectOne({ get: vi.fn(() => ({ id: 1 })) });
    const run = vi.fn();
    await module.execute({ run });

    expect(all).toEqual([1, 2, 3]);
    expect(one).toEqual({ id: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('initializes postgres connections and uses async query helpers', async () => {
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ release })),
      end: vi.fn(async () => undefined),
    };

    const module = await loadModule();

    Pool.mockImplementation(function MockPool() {
      return pool;
    });
    drizzlePg.mockReturnValue('pg-handle');
    getConfig.mockReturnValue({
      database: {
        type: 'postgres',
        postgresUrl: 'postgres://intelligent-context:test@localhost:5432/ic_test',
      },
    });

    const handle = await module.initDatabase();

    expect(handle).toBe('pg-handle');
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://intelligent-context:test@localhost:5432/ic_test',
      })
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(module.getDialect()).toBe('postgres');
    expect(module.getPgPool()).toBe(pool);
    expect(() => module.getRawDb()).toThrow('getRawDb() is not available for PostgreSQL');

    expect(await module.selectAll(Promise.resolve([{ id: 1 }]))).toEqual([{ id: 1 }]);
    expect(await module.selectOne(Promise.resolve([{ id: 1 }]))).toEqual({ id: 1 });
    await expect(module.execute(Promise.resolve())).resolves.toBeUndefined();
  });
});