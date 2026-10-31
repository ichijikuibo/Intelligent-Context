import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, execute, getDialect, selectAll, selectOne } from '../connection';
import { getSchema, type NewStatEntry, type StatEntry } from '../schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

function tables() {
  return getSchema();
}

export interface InsertStatData {
  projectId: string;
  sessionId?: string;
  requestId?: string;
  model: string;
  runId: string;
  type: string;
  direction: 'input' | 'output';
  meta?: Record<string, unknown>;
  tokens?: number;
  body?: string;
}

export interface StatQueryOptions {
  /** Restrict to a single stat type (e.g. 'context_injection'). */
  type?: string;
  /** Restrict to any of these stat types (ignored when `type` is set). */
  types?: string[];
  limit?: number;
  offset?: number;
}

/** A stats row with `meta` normalised to an object and `body` omitted by default. */
export interface StatRecord {
  id: string;
  projectId: string;
  sessionId: string | null;
  requestId: string | null;
  model: string;
  runId: string;
  type: string;
  direction: string;
  meta: Record<string, unknown>;
  tokens: number;
  createdAt: Date;
  body?: string;
}

function parseMeta(raw: unknown): Record<string, unknown> {
  if (!raw) return {};

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }

  return {};
}

function toStatRecord(row: StatEntry, includeBody = false): StatRecord {
  const record: StatRecord = {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId ?? null,
    requestId: row.requestId ?? null,
    model: row.model,
    runId: row.runId,
    type: row.type,
    direction: row.direction,
    meta: parseMeta((row as { meta?: unknown }).meta),
    tokens: row.tokens,
    createdAt: row.createdAt,
  };

  if (includeBody) {
    record.body = row.body ?? '';
  }

  return record;
}

export const statsRepo = {
  async insert(data: InsertStatData): Promise<StatEntry> {
    const { stats } = tables();
    const isPg = getDialect() === 'postgres';
    const row = {
      id: uuidv4(),
      projectId: data.projectId,
      sessionId: data.sessionId ?? null,
      requestId: data.requestId ?? null,
      model: data.model,
      runId: data.runId,
      type: data.type,
      direction: data.direction,
      meta: isPg ? (data.meta ?? {}) : JSON.stringify(data.meta ?? {}),
      tokens: data.tokens ?? 0,
      body: data.body ?? '',
      createdAt: new Date(),
    } as NewStatEntry;
    await execute(db().insert(stats).values(row));
    markDirty();
    return row as unknown as StatEntry;
  },

  /**
   * Most recent stats rows for a project.  `body` is deliberately omitted so
   * the list endpoint stays small; fetch a single row via `findById` for the
   * full body.
   */
  async findByProject(projectId: string, options: StatQueryOptions = {}): Promise<StatRecord[]> {
    const { stats } = tables();
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 500);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const filters = [eq(stats.projectId, projectId)];
    if (options.type) {
      filters.push(eq(stats.type, options.type));
    } else if (options.types && options.types.length > 0) {
      filters.push(inArray(stats.type, options.types));
    }
    const where = filters.length === 1 ? filters[0] : and(...filters);

    const rows = await selectAll<StatEntry>(
      db()
        .select({
          id: stats.id,
          projectId: stats.projectId,
          sessionId: stats.sessionId,
          requestId: stats.requestId,
          model: stats.model,
          runId: stats.runId,
          type: stats.type,
          direction: stats.direction,
          meta: stats.meta,
          tokens: stats.tokens,
          createdAt: stats.createdAt,
        })
        .from(stats)
        .where(where)
        .orderBy(desc(stats.createdAt))
        .limit(limit)
        .offset(offset),
    );

    return rows.map((row) => toStatRecord(row as StatEntry));
  },

  /** Full stats row (including `body`) for a detail view. */
  async findById(id: string): Promise<StatRecord | undefined> {
    const { stats } = tables();
    const row = await selectOne<StatEntry>(
      db().select().from(stats).where(eq(stats.id, id)),
    );
    return row ? toStatRecord(row as StatEntry, true) : undefined;
  },

  async countForProject(projectId: string, type?: string, types?: string[]): Promise<number> {
    const { stats } = tables();
    const filters = [eq(stats.projectId, projectId)];
    if (type) {
      filters.push(eq(stats.type, type));
    } else if (types && types.length > 0) {
      filters.push(inArray(stats.type, types));
    }
    const where = filters.length === 1 ? filters[0] : and(...filters);

    const rows = await selectAll<{ count: number }>(
      db()
        .select({ count: sql<number>`count(*)` })
        .from(stats)
        .where(where),
    );

    return Number(rows?.[0]?.count ?? 0);
  },

  /** Row counts grouped by stat type, for the UI filter dropdown. */
  async countByType(projectId: string, types?: string[]): Promise<Array<{ type: string; count: number }>> {
    const { stats } = tables();
    const filters = [eq(stats.projectId, projectId)];
    if (types && types.length > 0) {
      filters.push(inArray(stats.type, types));
    }
    const where = filters.length === 1 ? filters[0] : and(...filters);

    const rows = await selectAll<{ type: string; count: number }>(
      db()
        .select({ type: stats.type, count: sql<number>`count(*)` })
        .from(stats)
        .where(where)
        .groupBy(stats.type)
        .orderBy(desc(sql`count(*)`)),
    );

    return rows.map((row) => ({ type: row.type, count: Number(row.count) }));
  },
};
