import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, getDialect, getRawDb, getPgPool, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type ChunkEmbedding, type NewChunkEmbedding } from '../schema';
import { float32ToBuffer, bufferToFloat32 } from '../../utils/similarity';

function tables() {
  return getSchema();
}

/**
 * Run a parameterised read-only SQL query against whichever database is active.
 * Used by findAllByProject to discover chunk IDs before joining with embeddings.
 */
async function rawQueryAll(sqliteSql: string, pgSql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  if (getDialect() === 'postgres') {
    const pool = getPgPool();
    const result = await pool.query(pgSql, params as any[]);
    return result.rows as Array<Record<string, unknown>>;
  }

  // SQLite path — use sql.js raw exec
  const rawDb = getRawDb();
  const result = rawDb.exec(sqliteSql, params as any);
  if (result.length === 0) return [];
  const columns = result[0].columns;
  return (result[0].values as unknown[][]).map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export const embeddingsRepo = {
  async findByChunkId(chunkId: string): Promise<ChunkEmbedding | undefined> {
    const { chunkEmbeddings } = tables();
    return selectOne(db()
      .select()
      .from(chunkEmbeddings)
      .where(eq(chunkEmbeddings.chunkId, chunkId)));
  },

  async findByChunkIds(chunkIds: string[]): Promise<ChunkEmbedding[]> {
    if (chunkIds.length === 0) return [];
    const { chunkEmbeddings } = tables();
    return selectAll(db()
      .select()
      .from(chunkEmbeddings)
      .where(inArray(chunkEmbeddings.chunkId, chunkIds)));
  },

  async findAllByProject(projectId: string): Promise<Array<ChunkEmbedding & { projectId: string }>> {
    const d = db();
    const { chunkEmbeddings } = tables();

    // Get all chunk IDs for this project via a raw query
    const rows_raw = await rawQueryAll(
      'SELECT id FROM learning_chunks WHERE project_id = ? AND deleted_at IS NULL',
      'SELECT id FROM learning_chunks WHERE project_id = $1 AND deleted_at IS NULL',
      [projectId]
    );
    const idSet = new Set(rows_raw.map((r) => r.id as string));

    const rows = await selectAll(d
      .select({
        id: chunkEmbeddings.id,
        chunkId: chunkEmbeddings.chunkId,
        vector: chunkEmbeddings.vector,
        model: chunkEmbeddings.model,
        dimensions: chunkEmbeddings.dimensions,
        createdAt: chunkEmbeddings.createdAt,
      })
      .from(chunkEmbeddings)
    );

    return rows
      .filter((r: { chunkId: string }) => idSet.has(r.chunkId))
      .map((r: { chunkId: string; id: string; vector: unknown; model: string; dimensions: number; createdAt: Date }) => ({ ...r, projectId }));
  },

  async upsert(chunkId: string, vector: Float32Array, model: string): Promise<void> {
    const { chunkEmbeddings } = tables();
    const existing = await this.findByChunkId(chunkId);
    if (existing) {
      await execute(db()
        .update(chunkEmbeddings)
        .set({ vector: float32ToBuffer(vector), model, dimensions: vector.length })
        .where(eq(chunkEmbeddings.id, existing.id)));
    } else {
      const row: NewChunkEmbedding = {
        id: uuidv4(),
        chunkId,
        vector: float32ToBuffer(vector),
        model,
        dimensions: vector.length,
        createdAt: new Date(),
      };
      await execute(db().insert(chunkEmbeddings).values(row));
    }
    markDirty();
  },

  getVector(embedding: ChunkEmbedding): Float32Array {
    const vec = embedding.vector as Uint8Array;
    return bufferToFloat32(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  },

  async delete(chunkId: string): Promise<void> {
    const { chunkEmbeddings } = tables();
    await execute(db()
      .delete(chunkEmbeddings)
      .where(eq(chunkEmbeddings.chunkId, chunkId))
    );
    markDirty();
  },
};
