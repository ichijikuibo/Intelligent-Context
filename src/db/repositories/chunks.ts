import { eq, and, desc, gt, sql, isNull, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type LearningChunk, type NewLearningChunk } from '../schema';
import { estimateTokens } from '../../utils/tokens';
import { hashFact } from '../../utils/hashing';
import { filesRepo } from './files';
import { codeExtractsRepo } from './codeExtracts';

function tables() {
  return getSchema();
}

export interface CreateChunkData {
  projectId: string;
  sessionId?: string;
  requestId?: string;
  fact: string;
  category: string;
  confidence: number;
  source?: string;
  hash: string;
}

export const chunksRepo = {
  async findById(id: string): Promise<LearningChunk | undefined> {
    const { learningChunks } = tables();
    return selectOne(db()
      .select()
      .from(learningChunks)
      .where(and(eq(learningChunks.id, id), isNull(learningChunks.deletedAt))));
  },

  async findByIds(ids: string[]): Promise<LearningChunk[]> {
    if (ids.length === 0) return [];
    const { learningChunks } = tables();
    return selectAll(db()
      .select()
      .from(learningChunks)
      .where(and(inArray(learningChunks.id, ids), isNull(learningChunks.deletedAt))));
  },

  async findByProject(
    projectId: string,
    opts: { limit?: number; offset?: number; } = {}
  ): Promise<LearningChunk[]> {
    const { learningChunks } = tables();
    return selectAll(db()
      .select()
      .from(learningChunks)
      .where(and(eq(learningChunks.projectId, projectId), isNull(learningChunks.deletedAt)))
      .orderBy(desc(learningChunks.createdAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0)
    );
  },

  async findByCategory(
    projectId: string,
    category: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<LearningChunk[]> {
    const { learningChunks } = tables();
    return selectAll(db()
      .select()
      .from(learningChunks)
      .where(and(
        eq(learningChunks.projectId, projectId),
        eq(learningChunks.category, category),
        isNull(learningChunks.deletedAt)
      ))
      .orderBy(desc(learningChunks.createdAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0)
    );
  },

  async findFileLinkedByProject(projectId: string): Promise<LearningChunk[]> {
    const { learningChunks, learningFileChunks, learningFileIndex } = tables();
    const rows = await selectAll(db()
      .select({
        id: learningChunks.id,
        projectId: learningChunks.projectId,
        sessionId: learningChunks.sessionId,
        requestId: learningChunks.requestId,
        fact: learningChunks.fact,
        category: learningChunks.category,
        confidence: learningChunks.confidence,
        source: learningChunks.source,
        hash: learningChunks.hash,
        tokensUsed: learningChunks.tokensUsed,
        summarized: learningChunks.summarized,
        createdAt: learningChunks.createdAt,
        deletedAt: learningChunks.deletedAt,
      })
      .from(learningChunks)
      .innerJoin(learningFileChunks, eq(learningFileChunks.chunkId, learningChunks.id))
      .innerJoin(learningFileIndex, eq(learningFileIndex.id, learningFileChunks.fileId))
      .where(and(
        eq(learningChunks.projectId, projectId),
        isNull(learningChunks.deletedAt),
        isNull(learningFileIndex.deletedAt)
      ))
      .orderBy(desc(learningChunks.createdAt)));

    const deduped = new Map<string, LearningChunk>();
    for (const row of rows) {
      if (!deduped.has(row.id)) {
        deduped.set(row.id, row);
      }
    }

    return [...deduped.values()];
  },

  async findByHash(projectId: string, hash: string): Promise<LearningChunk | undefined> {
    const { learningChunks } = tables();
    return selectOne(db()
      .select()
      .from(learningChunks)
      .where(and(
        eq(learningChunks.projectId, projectId),
        eq(learningChunks.hash, hash),
        isNull(learningChunks.deletedAt)
      )));
  },

  async findUnsummarized(
    projectId: string,
    opts: { limit?: number; newestFirst?: boolean } = {}
  ): Promise<LearningChunk[]> {
    const { learningChunks } = tables();
    const query = db()
      .select()
      .from(learningChunks)
      .where(
        and(
          eq(learningChunks.projectId, projectId),
          eq(learningChunks.summarized, false),
          isNull(learningChunks.deletedAt)
        )
      )
      .orderBy(opts.newestFirst ? desc(learningChunks.createdAt) : learningChunks.createdAt);

    return selectAll(opts.limit === undefined ? query : query.limit(opts.limit));
  },

  async countUnsummarized(projectId: string): Promise<number> {
    const { learningChunks } = tables();
    const result = await selectOne<{ count: number | string }>(db()
      .select({ count: sql<number>`count(*)` })
      .from(learningChunks)
      .where(
        and(
          eq(learningChunks.projectId, projectId),
          eq(learningChunks.summarized, false),
          isNull(learningChunks.deletedAt)
        )
      ));

    return Number(result?.count ?? 0);
  },

  async countUnsummarizedCreatedAfter(projectId: string, createdAfter: string): Promise<number> {
    const { learningChunks } = tables();
    const result = await selectOne<{ count: number | string }>(db()
      .select({ count: sql<number>`count(*)` })
      .from(learningChunks)
      .where(
        and(
          eq(learningChunks.projectId, projectId),
          eq(learningChunks.summarized, false),
          gt(learningChunks.createdAt, createdAfter),
          isNull(learningChunks.deletedAt)
        )
      ));

    return Number(result?.count ?? 0);
  },

  async findAllForEmbedding(projectId: string): Promise<LearningChunk[]> {
    // Returns all chunks (embedding service will filter out already-embedded ones)
    const { learningChunks } = tables();
    return selectAll(db()
      .select()
      .from(learningChunks)
      .where(and(eq(learningChunks.projectId, projectId), isNull(learningChunks.deletedAt))));
  },

  /** Simple keyword search across facts */
  async searchByKeywords(projectId: string, keywords: string[], limit = 20): Promise<LearningChunk[]> {
    if (keywords.length === 0) return [];
    const { learningChunks } = tables();

    // Build LIKE conditions for each keyword
    const allChunks = await selectAll(db()
      .select()
      .from(learningChunks)
      .where(and(eq(learningChunks.projectId, projectId), isNull(learningChunks.deletedAt))));

    const lower = keywords.map((k) => k.toLowerCase());
    const scored = (allChunks as LearningChunk[])
      .map((chunk: LearningChunk) => {
        const factLower = chunk.fact.toLowerCase();
        const score = lower.reduce(
          (s: number, kw: string) => s + (factLower.includes(kw) ? 1 : 0),
          0
        );
        return { chunk, score };
      })
      .filter((x: { chunk: LearningChunk; score: number }) => x.score > 0)
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, limit);

    return scored.map((x: { chunk: LearningChunk }) => x.chunk);
  },

  async insert(data: CreateChunkData): Promise<LearningChunk> {
    const { learningChunks } = tables();
    const row: NewLearningChunk = {
      id: uuidv4(),
      projectId: data.projectId,
      sessionId: data.sessionId,
      requestId: data.requestId,
      fact: data.fact,
      category: data.category,
      confidence: data.confidence,
      source: data.source ?? 'extraction',
      hash: data.hash,
      tokensUsed: estimateTokens(data.fact),
      summarized: false,
      createdAt: new Date().toISOString(),
    };
    await execute(db().insert(learningChunks).values(row));
    markDirty();
    return (await this.findById(row.id))!;
  },

  async updateConfidence(id: string, confidence: number): Promise<void> {
    const { learningChunks } = tables();
    await execute(db()
      .update(learningChunks)
      .set({ confidence })
      .where(eq(learningChunks.id, id)));
    markDirty();
  },

  async updateFact(id: string, fact: string): Promise<LearningChunk | undefined> {
    const { learningChunks } = tables();
    await execute(db()
      .update(learningChunks)
      .set({
        fact,
        hash: hashFact(fact),
        tokensUsed: estimateTokens(fact),
      })
      .where(eq(learningChunks.id, id)));
    markDirty();
    return this.findById(id);
  },

  async updateCategory(id: string, category: string): Promise<void> {
    const { learningChunks } = tables();
    await execute(db()
      .update(learningChunks)
      .set({ category })
      .where(eq(learningChunks.id, id)));
    markDirty();
  },

  /** Bulk-reassign the category of many chunks in a single statement. */
  async updateCategoryForIds(ids: string[], category: string): Promise<void> {
    if (ids.length === 0) return;
    const { learningChunks } = tables();
    await execute(db()
      .update(learningChunks)
      .set({ category })
      .where(inArray(learningChunks.id, ids)));
    markDirty();
  },

  async markSummarized(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { learningChunks } = tables();
    const d = db();
    for (const id of ids) {
      await execute(d.update(learningChunks)
        .set({ summarized: true })
        .where(eq(learningChunks.id, id)));
    }
    markDirty();
  },

  async delete(id: string): Promise<void> {
    const { learningChunks } = tables();
    await execute(db().delete(learningChunks).where(eq(learningChunks.id, id)));
    markDirty();
  },

  async softDelete(id: string): Promise<void> {
    const { learningChunks } = tables();
    await execute(db()
      .update(learningChunks)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(learningChunks.id, id)));
    await filesRepo.softDeleteByChunkId(id);
    await codeExtractsRepo.softDeleteByChunkId(id);
    markDirty();
  },

  async countByProject(projectId: string): Promise<number> {
    const { learningChunks } = tables();
    const result = await selectOne<{ count: number | string }>(db()
      .select({ count: sql<number>`count(*)` })
      .from(learningChunks)
      .where(and(eq(learningChunks.projectId, projectId), isNull(learningChunks.deletedAt))));
    return Number(result?.count ?? 0);
  },

  async countByCategory(projectId: string, category: string): Promise<number> {
    const { learningChunks } = tables();
    const result = await selectOne<{ count: number | string }>(db()
      .select({ count: sql<number>`count(*)` })
      .from(learningChunks)
      .where(and(
        eq(learningChunks.projectId, projectId),
        eq(learningChunks.category, category),
        isNull(learningChunks.deletedAt)
      )));
    return Number(result?.count ?? 0);
  },
};
