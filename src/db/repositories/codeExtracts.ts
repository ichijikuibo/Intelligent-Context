import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type LearningCodeExtract, type NewLearningCodeExtract } from '../schema';

function tables() {
  return getSchema();
}

export interface CreateCodeExtractData {
  chunkId: string;
  fileName?: string;
  language?: string;
  symbols?: string[];
  code?: string;
}

function normaliseSymbols(symbols: string[] | undefined): string[] {
  return [...new Set((symbols ?? [])
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length > 0))];
}

export const codeExtractsRepo = {
  async findByChunkId(chunkId: string): Promise<LearningCodeExtract[]> {
    const { learningCodeExtracts } = tables();
    return selectAll(db()
      .select()
      .from(learningCodeExtracts)
      .where(and(eq(learningCodeExtracts.chunkId, chunkId), isNull(learningCodeExtracts.deletedAt))));
  },

  async findByChunkIds(chunkIds: string[]): Promise<Map<string, LearningCodeExtract[]>> {
    const result = new Map<string, LearningCodeExtract[]>();
    if (chunkIds.length === 0) return result;

    const { learningCodeExtracts } = tables();
    for (const id of chunkIds) result.set(id, []);

    const rows = await selectAll(db()
      .select()
      .from(learningCodeExtracts)
      .where(and(inArray(learningCodeExtracts.chunkId, chunkIds), isNull(learningCodeExtracts.deletedAt))));

    for (const row of rows) {
      result.get(row.chunkId)?.push(row);
    }

    return result;
  },

  async insertMany(extracts: CreateCodeExtractData[]): Promise<void> {
    if (extracts.length === 0) return;

    const { learningCodeExtracts } = tables();
    const rows = extracts
      .map((extract) => {
        const symbols = normaliseSymbols(extract.symbols);
        const code = extract.code?.trim() ?? '';
        if (symbols.length === 0 && code.length === 0) return null;

        return {
          id: uuidv4(),
          chunkId: extract.chunkId,
          fileName: extract.fileName?.trim() ?? '',
          language: extract.language?.trim() ?? '',
          symbolsJson: JSON.stringify(symbols),
          code,
          createdAt: new Date(),
        };
      })
      .filter((row) => row !== null) as NewLearningCodeExtract[];

    if (rows.length === 0) return;

    for (const row of rows) {
      await execute(db().insert(learningCodeExtracts).values(row));
    }

    markDirty();
  },

  async findById(id: string): Promise<LearningCodeExtract | undefined> {
    const { learningCodeExtracts } = tables();
    return selectOne(db()
      .select()
      .from(learningCodeExtracts)
      .where(and(eq(learningCodeExtracts.id, id), isNull(learningCodeExtracts.deletedAt))));
  },

  async findByIdForProject(
    projectId: string,
    id: string
  ): Promise<(LearningCodeExtract & { projectId: string }) | undefined> {
    const { learningCodeExtracts, learningChunks } = tables();
    return selectOne(db()
      .select({
        id: learningCodeExtracts.id,
        chunkId: learningCodeExtracts.chunkId,
        fileName: learningCodeExtracts.fileName,
        language: learningCodeExtracts.language,
        symbolsJson: learningCodeExtracts.symbolsJson,
        code: learningCodeExtracts.code,
        createdAt: learningCodeExtracts.createdAt,
        deletedAt: learningCodeExtracts.deletedAt,
        projectId: learningChunks.projectId,
      })
      .from(learningCodeExtracts)
      .innerJoin(learningChunks, eq(learningCodeExtracts.chunkId, learningChunks.id))
      .where(and(
        eq(learningCodeExtracts.id, id),
        eq(learningChunks.projectId, projectId),
        isNull(learningCodeExtracts.deletedAt),
        isNull(learningChunks.deletedAt)
      )));
  },

  async findByProject(
    projectId: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<LearningCodeExtract[]> {
    const { learningCodeExtracts, learningChunks } = tables();
    return selectAll(db()
      .select({
        id: learningCodeExtracts.id,
        chunkId: learningCodeExtracts.chunkId,
        fileName: learningCodeExtracts.fileName,
        language: learningCodeExtracts.language,
        symbolsJson: learningCodeExtracts.symbolsJson,
        code: learningCodeExtracts.code,
        createdAt: learningCodeExtracts.createdAt,
        deletedAt: learningCodeExtracts.deletedAt,
      })
      .from(learningCodeExtracts)
      .innerJoin(learningChunks, eq(learningCodeExtracts.chunkId, learningChunks.id))
      .where(and(
        eq(learningChunks.projectId, projectId),
        isNull(learningCodeExtracts.deletedAt),
        isNull(learningChunks.deletedAt)
      ))
      .orderBy(desc(learningCodeExtracts.createdAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0)
    );
  },

  async countByProject(projectId: string): Promise<number> {
    const { learningCodeExtracts, learningChunks } = tables();
    const rows = await selectAll(db()
      .select({ id: learningCodeExtracts.id })
      .from(learningCodeExtracts)
      .innerJoin(learningChunks, eq(learningCodeExtracts.chunkId, learningChunks.id))
      .where(and(
        eq(learningChunks.projectId, projectId),
        isNull(learningCodeExtracts.deletedAt),
        isNull(learningChunks.deletedAt)
      )));
    return rows.length;
  },

  async deleteById(id: string): Promise<void> {
    const { learningCodeExtracts } = tables();
    await execute(db()
      .delete(learningCodeExtracts)
      .where(eq(learningCodeExtracts.id, id)));
    markDirty();
  },

  async softDeleteByChunkId(chunkId: string): Promise<void> {
    const { learningCodeExtracts } = tables();
    await execute(db()
      .update(learningCodeExtracts)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(learningCodeExtracts.chunkId, chunkId)));
    markDirty();
  },
};