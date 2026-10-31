import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { drizzle as drizzleSqlJs } from 'drizzle-orm/sql-js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getConfig } from '../config/config';
import { logger } from '../utils/logger';
import * as sqliteSchema from './schema.sqlite';
import * as pgSchema from './schema.pg';

// ── SEA-aware sql.js WASM resolution ──────────────────────────────────────
// In SEA mode the bundled script has no access to node_modules, so we look
// for sql-wasm.wasm next to the executable and fall back to the default
// locateFile otherwise.

function resolveSqlJsWasm(): string {
  // 1. Explicit env override
  if (process.env.SQLJS_WASM_PATH) {
    return process.env.SQLJS_WASM_PATH;
  }
  // 2. Next to the executable (SEA-friendly)
  const exeDir = path.dirname(process.execPath);
  const nextToExe = path.join(exeDir, 'sql-wasm.wasm');
  if (fs.existsSync(nextToExe)) {
    return nextToExe;
  }
  // 3. Default — let sql.js use its built-in locateFile
  return '';
}

// ── Types ──────────────────────────────────────────────────────────────────

/** Union of both possible Drizzle ORM database handles. */
export type AppDb = SQLJsDatabase<typeof sqliteSchema> | NodePgDatabase<typeof pgSchema>;

// ── State ──────────────────────────────────────────────────────────────────

let _db: AppDb | null = null;
let _dialect: 'sqlite' | 'postgres' = 'sqlite';

// SQLite-specific state
let _sqlJsDb: SqlJsDatabase | null = null;
let _dbPath = '';
let _dirty = false;
let _saveTimer: ReturnType<typeof setInterval> | null = null;
let _saveCount = 0;

// Postgres-specific state
let _pgPool: Pool | null = null;

const BACKUP_RETENTION_DEFAULT = 10;

// ── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise the database — SQLite (sql.js/WASM) or PostgreSQL depending on
 * config.  Must be called (and awaited) once at startup before any DB ops.
 */
export async function initDatabase(): Promise<AppDb> {
  if (_db) return _db;

  const config = getConfig();

  if (config.database.type === 'postgres') {
    return initPostgres(config.database.postgresUrl!);
  }

  // ── SQLite path (default) ────────────────────────────────────────────
  return initSqlite(config.database.sqlitePath!);
}

// ── SQLite initialisation ──────────────────────────────────────────────────

async function initSqlite(dbPath: string): Promise<AppDb> {
  _dialect = 'sqlite';
  _dbPath = dbPath;
  const dir = path.dirname(_dbPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const wasmStartedAt = Date.now();
  const wasmPath = resolveSqlJsWasm();
  const SQL = wasmPath
    ? await initSqlJs({ locateFile: () => wasmPath })
    : await initSqlJs();
  logger.info('sql.js WASM loaded', {
    durationMs: Date.now() - wasmStartedAt,
    wasmPath: wasmPath || 'default (bundled)',
  });

  let buffer: Uint8Array | undefined;
  const readStartedAt = Date.now();
  try {
    buffer = fs.readFileSync(_dbPath);
  } catch {
    // New database — will be created on first save
  }
  if (buffer) {
    logger.info('SQLite database file read', {
      durationMs: Date.now() - readStartedAt,
      sizeBytes: buffer.byteLength,
    });
  }

  const openStartedAt = Date.now();
  _sqlJsDb = new SQL.Database(buffer);
  _sqlJsDb.run('PRAGMA foreign_keys = ON');

  _db = drizzleSqlJs(_sqlJsDb, { schema: sqliteSchema }) as AppDb;
  logger.info('SQLite database parsed & Drizzle initialised', {
    durationMs: Date.now() - openStartedAt,
    sizeBytes: buffer?.byteLength ?? 0,
  });

  // Auto-save every 5 seconds when dirty
  _saveTimer = setInterval(() => {
    if (_dirty) saveDatabase();
  }, 5000);

  logger.info('SQLite database initialised (sql.js/WASM)', { path: _dbPath });
  return _db;
}

// ── Postgres initialisation ────────────────────────────────────────────────

async function initPostgres(connectionString: string): Promise<AppDb> {
  _dialect = 'postgres';

  const poolStartedAt = Date.now();
  _pgPool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  // Verify connectivity
  try {
    const client = await _pgPool.connect();
    client.release();
    logger.info('PostgreSQL database connected', {
      durationMs: Date.now() - poolStartedAt,
    });
  } catch (err) {
    logger.error('PostgreSQL connection failed', { error: String(err) });
    throw err;
  }

  _db = drizzlePg(_pgPool, { schema: pgSchema }) as AppDb;

  logger.info('PostgreSQL database initialised (node-postgres)');
  return _db;
}

// ── Accessors ──────────────────────────────────────────────────────────────

/** Returns the active Drizzle ORM database instance. */
export function getDatabase(): AppDb {
  if (!_db) throw new Error('Database not initialised. Call initDatabase() first.');
  return _db;
}

/**
 * Returns the database as a dialect-erased handle that accepts tables from
 * either schema.  Repositories use this so the same query code compiles
 * regardless of whether the active dialect is SQLite or Postgres.
 */
export function db(): Record<string, any> {
  return getDatabase() as unknown as Record<string, any>;
}

/** Returns the active dialect. */
export function getDialect(): 'sqlite' | 'postgres' {
  return _dialect;
}

/**
 * Dialect-agnostic query helpers.
 *
 * sql-js Drizzle has .all() / .get() / .run() (synchronous).
 * node-postgres Drizzle returns Promises (async).
 *
 * These wrappers work for BOTH dialects so repository code stays simple.
 * All return Promises — always `await` them.
 */

/** Execute a SELECT and return all rows. */
export async function selectAll<T = any>(q: any): Promise<T[]> {
  if (_dialect === 'postgres') {
    return (await q) as T[];
  }
  return q.all() as T[];
}

/** Execute a SELECT and return the first row or undefined. */
export async function selectOne<T = any>(q: any): Promise<T | undefined> {
  if (_dialect === 'postgres') {
    const rows = (await q) as T[];
    return rows[0];
  }
  return q.get() as T | undefined;
}

/** Execute an INSERT / UPDATE / DELETE query. */
export async function execute(q: any): Promise<void> {
  if (_dialect === 'postgres') {
    await q;
    return;
  }
  q.run();
}

/** Returns the raw sql.js Database (SQLite only — throws for Postgres). */
export function getRawDb(): SqlJsDatabase {
  if (!_sqlJsDb) {
    if (_dialect === 'postgres') {
      throw new Error('getRawDb() is not available for PostgreSQL. Use getPgPool() instead.');
    }
    throw new Error('Database not initialised. Call initDatabase() first.');
  }
  return _sqlJsDb;
}

/** Returns the pg Pool (Postgres only — throws for SQLite). */
export function getPgPool(): Pool {
  if (!_pgPool) {
    if (_dialect === 'sqlite') {
      throw new Error('getPgPool() is not available for SQLite. Use getRawDb() instead.');
    }
    throw new Error('Database not initialised. Call initDatabase() first.');
  }
  return _pgPool;
}

// ── Write tracking & persistence ───────────────────────────────────────────

/** Mark the database as needing a save to disk. No-op for Postgres. */
export function markDirty(): void {
  if (_dialect === 'sqlite') {
    _dirty = true;
  }
}

/** Persist the in-memory SQLite database to disk. No-op for Postgres. */
export function saveDatabase(): void {
  if (_dialect === 'postgres' || !_sqlJsDb || !_dbPath) return;

  const saveStartedAt = Date.now();
  try {
    _saveCount++;
    if (_saveCount > 1 && _saveCount % 12 === 0 && fs.existsSync(_dbPath)) {
      const config = getConfig();
      const retention = config.database.backupRetention ?? BACKUP_RETENTION_DEFAULT;
      try {
        const backupDir = path.join(path.dirname(_dbPath), 'backups');
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `db-${timestamp}.sqlite`);
        fs.copyFileSync(_dbPath, backupPath);

        const files = fs
          .readdirSync(backupDir)
          .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite'))
          .sort();

        while (files.length > retention) {
          const oldest = files.shift()!;
          fs.unlinkSync(path.join(backupDir, oldest));
        }
      } catch (backupErr) {
        logger.warn('Backup failed, continuing with save', {
          error: String(backupErr),
        });
      }
    }

    const data = _sqlJsDb.export();
    fs.writeFileSync(_dbPath, Buffer.from(data));
    _dirty = false;
    const durationMs = Date.now() - saveStartedAt;
    if (durationMs > 1000) {
      logger.warn('Database save was slow (full sql.js export + write)', {
        durationMs,
        saveCount: _saveCount,
      });
    } else {
      logger.debug('Database saved', {
        durationMs,
        saveCount: _saveCount,
      });
    }
  } catch (err) {
    logger.error('Failed to save database', { error: String(err) });
  }
}

// ── Shutdown ────────────────────────────────────────────────────────────��──

/** Close the database, saving first. Call on shutdown. */
export async function closeDatabase(): Promise<void> {
  if (_saveTimer) {
    clearInterval(_saveTimer);
    _saveTimer = null;
  }

  if (_dialect === 'sqlite') {
    if (_dirty) saveDatabase();
    if (_sqlJsDb) {
      _sqlJsDb.close();
      _sqlJsDb = null;
    }
  } else if (_dialect === 'postgres') {
    if (_pgPool) {
      await _pgPool.end();
      _pgPool = null;
    }
  }

  _db = null;
}

