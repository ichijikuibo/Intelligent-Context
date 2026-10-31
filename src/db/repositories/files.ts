import { eq, desc, and, isNull, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { logger } from '../../utils/logger';
import {
  getSchema,
  type LearningChunk,
  type LearningFile,
  type LearningFileIndex,
  type NewLearningFileChunk,
  type NewLearningFileIndex,
  type NewLearningFileSummary,
  type Summary,
} from '../schema';

function tables() {
  return getSchema();
}

export interface CreateFileData {
  chunkId: string;
  fileName: string;
  purpose?: string;
}

export interface LinkedLearningFile {
  id: string;
  chunkId: string;
  fileName: string;
  purpose: string;
  createdAt: LearningFileIndex['createdAt'];
  deletedAt: LearningFileIndex['deletedAt'];
}

export interface IndexedLearningFile {
  id: string;
  projectId: string;
  fileName: string;
  normalizedFileName: string;
  purpose: string;
  chunkCount: number;
  summaryCount: number;
  createdAt: LearningFileIndex['createdAt'];
  updatedAt: LearningFileIndex['updatedAt'];
  deletedAt: LearningFileIndex['deletedAt'];
}

interface FileIndexRow {
  id: string;
  projectId: string;
  fileName: string;
  normalizedFileName: string;
  summary: string;
  createdAt: LearningFileIndex['createdAt'];
  updatedAt: LearningFileIndex['updatedAt'];
  deletedAt: LearningFileIndex['deletedAt'];
}

function normalisePathForMatch(value: string): string {
  return value
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/\.$/, '')
    .toLowerCase();
}

function matchesFileHint(fileName: string, normalisedHints: string[]): boolean {
  const normalisedFile = normalisePathForMatch(fileName);
  if (!normalisedFile) return false;

  const fileBaseName = normalisedFile.split('/').pop() ?? normalisedFile;

  return normalisedHints.some((hint) => {
    const hintBaseName = hint.split('/').pop() ?? hint;
    return (
      normalisedFile === hint ||
      hint.endsWith(`/${normalisedFile}`) ||
      normalisedFile.endsWith(`/${hint}`) ||
      fileBaseName === hintBaseName
    );
  });
}

function parseStoredStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function pickPurpose(existing: string, incoming: string | undefined): string {
  const next = incoming?.trim() ?? '';
  const current = existing.trim();
  if (!next) return current;
  if (!current) return next;
  return next.length > current.length ? next : current;
}

function buildLinkedFile(row: {
  id: string;
  chunkId: string;
  fileName: string;
  purpose: string;
  createdAt: LearningFileIndex['createdAt'];
  deletedAt: LearningFileIndex['deletedAt'];
}): LinkedLearningFile {
  return {
    id: row.id,
    chunkId: row.chunkId,
    fileName: row.fileName,
    purpose: row.purpose,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

async function listActiveFileIndexRows(projectId: string): Promise<FileIndexRow[]> {
  const { learningFileIndex } = tables();
  return selectAll(db()
    .select({
      id: learningFileIndex.id,
      projectId: learningFileIndex.projectId,
      fileName: learningFileIndex.fileName,
      normalizedFileName: learningFileIndex.normalizedFileName,
      summary: learningFileIndex.summary,
      createdAt: learningFileIndex.createdAt,
      updatedAt: learningFileIndex.updatedAt,
      deletedAt: learningFileIndex.deletedAt,
    })
    .from(learningFileIndex)
    .where(and(eq(learningFileIndex.projectId, projectId), isNull(learningFileIndex.deletedAt)))
    .orderBy(desc(learningFileIndex.updatedAt)));
}

async function buildIndexedFiles(rows: FileIndexRow[]): Promise<IndexedLearningFile[]> {
  if (rows.length === 0) return [];

  const fileIds = rows.map((row) => row.id);
  const { learningFileChunks, learningFileSummaries, learningChunks, summaries } = tables();

  const [chunkLinks, summaryLinks] = await Promise.all([
    selectAll(db()
      .select({ fileId: learningFileChunks.fileId })
      .from(learningFileChunks)
      .innerJoin(learningChunks, eq(learningChunks.id, learningFileChunks.chunkId))
      .where(and(inArray(learningFileChunks.fileId, fileIds), isNull(learningChunks.deletedAt)))),
    selectAll(db()
      .select({ fileId: learningFileSummaries.fileId })
      .from(learningFileSummaries)
      .innerJoin(summaries, eq(summaries.id, learningFileSummaries.summaryId))
      .where(and(inArray(learningFileSummaries.fileId, fileIds), isNull(summaries.deletedAt)))),
  ]);

  const chunkCounts = new Map<string, number>();
  const summaryCounts = new Map<string, number>();

  for (const row of chunkLinks) {
    chunkCounts.set(row.fileId, (chunkCounts.get(row.fileId) ?? 0) + 1);
  }

  for (const row of summaryLinks) {
    summaryCounts.set(row.fileId, (summaryCounts.get(row.fileId) ?? 0) + 1);
  }

  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    fileName: row.fileName,
    normalizedFileName: row.normalizedFileName,
    purpose: row.summary,
    chunkCount: chunkCounts.get(row.id) ?? 0,
    summaryCount: summaryCounts.get(row.id) ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }));
}

async function findFileIndexRowById(id: string): Promise<FileIndexRow | undefined> {
  const { learningFileIndex } = tables();
  return selectOne(db()
    .select({
      id: learningFileIndex.id,
      projectId: learningFileIndex.projectId,
      fileName: learningFileIndex.fileName,
      normalizedFileName: learningFileIndex.normalizedFileName,
      summary: learningFileIndex.summary,
      createdAt: learningFileIndex.createdAt,
      updatedAt: learningFileIndex.updatedAt,
      deletedAt: learningFileIndex.deletedAt,
    })
    .from(learningFileIndex)
    .where(eq(learningFileIndex.id, id)));
}

async function findFileIndexRowByNormalizedPath(projectId: string, normalizedFileName: string): Promise<FileIndexRow | undefined> {
  const { learningFileIndex } = tables();
  return selectOne(db()
    .select({
      id: learningFileIndex.id,
      projectId: learningFileIndex.projectId,
      fileName: learningFileIndex.fileName,
      normalizedFileName: learningFileIndex.normalizedFileName,
      summary: learningFileIndex.summary,
      createdAt: learningFileIndex.createdAt,
      updatedAt: learningFileIndex.updatedAt,
      deletedAt: learningFileIndex.deletedAt,
    })
    .from(learningFileIndex)
    .where(and(
      eq(learningFileIndex.projectId, projectId),
      eq(learningFileIndex.normalizedFileName, normalizedFileName)
    )));
}

async function ensureFileIndex(projectId: string, fileName: string, purpose: string | undefined): Promise<{ row: FileIndexRow; changed: boolean }> {
  const normalizedFileName = normalisePathForMatch(fileName);
  const existing = await findFileIndexRowByNormalizedPath(projectId, normalizedFileName);
  const { learningFileIndex } = tables();

  if (existing) {
    const nextPurpose = pickPurpose(existing.summary, purpose);
    const nextDeletedAt = null;
    const requiresUpdate = existing.fileName !== fileName
      || existing.summary !== nextPurpose
      || existing.deletedAt !== nextDeletedAt;

    if (!requiresUpdate) {
      return { row: existing, changed: false };
    }

    await execute(db()
      .update(learningFileIndex)
      .set({
        fileName,
        summary: nextPurpose,
        updatedAt: new Date(),
        deletedAt: nextDeletedAt,
      } as any)
      .where(eq(learningFileIndex.id, existing.id)));

    return {
      row: (await findFileIndexRowById(existing.id))!,
      changed: true,
    };
  }

  const now = new Date();
  const row: NewLearningFileIndex = {
    id: uuidv4(),
    projectId,
    fileName,
    normalizedFileName,
    summary: purpose?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  await execute(db().insert(learningFileIndex).values(row));

  return {
    row: (await findFileIndexRowById(row.id))!,
    changed: true,
  };
}

async function linkChunkToFile(fileId: string, chunkId: string): Promise<boolean> {
  const { learningFileChunks } = tables();
  const existing = await selectOne(db()
    .select()
    .from(learningFileChunks)
    .where(and(eq(learningFileChunks.fileId, fileId), eq(learningFileChunks.chunkId, chunkId))));

  if (existing) return false;

  const row: NewLearningFileChunk = {
    fileId,
    chunkId,
    createdAt: new Date(),
  };

  await execute(db().insert(learningFileChunks).values(row));
  return true;
}

async function insertSummaryLink(fileId: string, summaryId: string): Promise<boolean> {
  const { learningFileSummaries } = tables();
  const existing = await selectOne(db()
    .select()
    .from(learningFileSummaries)
    .where(and(eq(learningFileSummaries.fileId, fileId), eq(learningFileSummaries.summaryId, summaryId))));

  if (existing) return false;

  const row: NewLearningFileSummary = {
    fileId,
    summaryId,
    createdAt: new Date(),
  };

  await execute(db().insert(learningFileSummaries).values(row));
  return true;
}

async function getChunkFileIds(chunkId: string): Promise<string[]> {
  const { learningFileChunks, learningFileIndex } = tables();
  const rows = await selectAll(db()
    .select({ fileId: learningFileChunks.fileId })
    .from(learningFileChunks)
    .innerJoin(learningFileIndex, eq(learningFileIndex.id, learningFileChunks.fileId))
    .where(and(eq(learningFileChunks.chunkId, chunkId), isNull(learningFileIndex.deletedAt))));

  return [...new Set(rows.map((row) => row.fileId))];
}

async function cleanupFileIndexIds(fileIds: string[]): Promise<boolean> {
  if (fileIds.length === 0) return false;

  const uniqueIds = [...new Set(fileIds)];
  const { learningFileChunks, learningFileSummaries, learningFileIndex, summaries } = tables();
  const [chunkLinks, summaryLinks] = await Promise.all([
    selectAll(db()
      .select({ fileId: learningFileChunks.fileId })
      .from(learningFileChunks)
      .where(inArray(learningFileChunks.fileId, uniqueIds))),
    selectAll(db()
      .select({ fileId: learningFileSummaries.fileId })
      .from(learningFileSummaries)
      .innerJoin(summaries, eq(summaries.id, learningFileSummaries.summaryId))
      .where(and(inArray(learningFileSummaries.fileId, uniqueIds), isNull(summaries.deletedAt)))),
  ]);

  const linkedIds = new Set<string>();
  for (const row of chunkLinks) linkedIds.add(row.fileId);
  for (const row of summaryLinks) linkedIds.add(row.fileId);

  const orphanedIds = uniqueIds.filter((fileId) => !linkedIds.has(fileId));
  if (orphanedIds.length === 0) return false;

  await execute(db()
    .update(learningFileIndex)
    .set({ deletedAt: new Date().toISOString(), updatedAt: new Date() } as any)
    .where(inArray(learningFileIndex.id, orphanedIds)));

  return true;
}

async function linkSummariesForChunk(projectId: string, chunkId: string): Promise<boolean> {
  const fileIds = await getChunkFileIds(chunkId);
  if (fileIds.length === 0) return false;

  const { summaries } = tables();
  const projectSummaries = await selectAll(db()
    .select()
    .from(summaries)
    .where(and(eq(summaries.projectId, projectId), isNull(summaries.deletedAt))));

  let changed = false;
  for (const summary of projectSummaries) {
    const sourceChunkIds = parseStoredStringArray(summary.sourceChunkIds);
    if (!sourceChunkIds.includes(chunkId)) continue;
    for (const fileId of fileIds) {
      changed = (await insertSummaryLink(fileId, summary.id)) || changed;
    }
  }

  return changed;
}

export const filesRepo = {
  normalisePathForMatch,

  async findByChunkId(chunkId: string): Promise<LinkedLearningFile[]> {
    const result = await this.findByChunkIds([chunkId]);
    return result.get(chunkId) ?? [];
  },

  async findByChunkIds(chunkIds: string[]): Promise<Map<string, LinkedLearningFile[]>> {
    const result = new Map<string, LinkedLearningFile[]>();
    if (chunkIds.length === 0) return result;
    const { learningFileChunks, learningFileIndex } = tables();

    for (const id of chunkIds) result.set(id, []);

    const rows = await selectAll(db()
      .select({
        id: learningFileIndex.id,
        chunkId: learningFileChunks.chunkId,
        fileName: learningFileIndex.fileName,
        purpose: learningFileIndex.summary,
        createdAt: learningFileIndex.createdAt,
        deletedAt: learningFileIndex.deletedAt,
      })
      .from(learningFileChunks)
      .innerJoin(learningFileIndex, eq(learningFileIndex.id, learningFileChunks.fileId))
      .where(and(inArray(learningFileChunks.chunkId, chunkIds), isNull(learningFileIndex.deletedAt)))
      .orderBy(desc(learningFileIndex.updatedAt)));

    for (const row of rows) {
      const existing = result.get(row.chunkId);
      if (existing) existing.push(buildLinkedFile(row));
    }

    return result;
  },

  async findByProjectFileHints(projectId: string, fileHints: string[]): Promise<Map<string, LinkedLearningFile[]>> {
    const result = new Map<string, LinkedLearningFile[]>();
    if (fileHints.length === 0) return result;

    const matchedFiles = await this.findByProjectFileHintsList(projectId, fileHints);
    if (matchedFiles.length === 0) return result;

    const { learningFileChunks } = tables();
    const rows = await selectAll(db()
      .select({
        fileId: learningFileChunks.fileId,
        chunkId: learningFileChunks.chunkId,
      })
      .from(learningFileChunks)
      .where(inArray(learningFileChunks.fileId, matchedFiles.map((file) => file.id))));

    const byFileId = new Map(matchedFiles.map((file) => [file.id, file]));
    for (const row of rows) {
      const file = byFileId.get(row.fileId);
      if (!file) continue;
      const existing = result.get(row.chunkId) ?? [];
      existing.push({
        id: file.id,
        chunkId: row.chunkId,
        fileName: file.fileName,
        purpose: file.purpose,
        createdAt: file.createdAt,
        deletedAt: file.deletedAt,
      });
      result.set(row.chunkId, existing);
    }

    return result;
  },

  async findByProjectFileHintsList(projectId: string, fileHints: string[]): Promise<IndexedLearningFile[]> {
    const normalisedHints = [...new Set(fileHints.map(normalisePathForMatch).filter((hint) => hint.length > 0))];
    if (normalisedHints.length === 0) return [];

    const rows = await listActiveFileIndexRows(projectId);
    const matchedRows = rows.filter((row) => matchesFileHint(row.fileName, normalisedHints));
    return buildIndexedFiles(matchedRows);
  },

  async findChunksByFileId(fileId: string): Promise<LearningChunk[]> {
    const result = await this.findChunksByFileIds([fileId]);
    return result.get(fileId) ?? [];
  },

  async findChunksByFileIds(fileIds: string[]): Promise<Map<string, LearningChunk[]>> {
    const result = new Map<string, LearningChunk[]>();
    if (fileIds.length === 0) return result;
    for (const id of fileIds) result.set(id, []);

    const { learningFileChunks, learningChunks, learningFileIndex } = tables();
    const rows = await selectAll(db()
      .select({
        fileId: learningFileChunks.fileId,
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
      .from(learningFileChunks)
      .innerJoin(learningChunks, eq(learningChunks.id, learningFileChunks.chunkId))
      .innerJoin(learningFileIndex, eq(learningFileIndex.id, learningFileChunks.fileId))
      .where(and(
        inArray(learningFileChunks.fileId, fileIds),
        isNull(learningChunks.deletedAt),
        isNull(learningFileIndex.deletedAt)
      ))
      .orderBy(desc(learningChunks.createdAt)));

    for (const row of rows) {
      const existing = result.get(row.fileId) ?? [];
      existing.push({
        id: row.id,
        projectId: row.projectId,
        sessionId: row.sessionId,
        requestId: row.requestId,
        fact: row.fact,
        category: row.category,
        confidence: row.confidence,
        source: row.source,
        hash: row.hash,
        tokensUsed: row.tokensUsed,
        summarized: row.summarized,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
      });
      result.set(row.fileId, existing);
    }

    return result;
  },

  async findSummariesByFileId(fileId: string): Promise<Summary[]> {
    const result = await this.findSummariesByFileIds([fileId]);
    return result.get(fileId) ?? [];
  },

  async findSummariesByFileIds(fileIds: string[]): Promise<Map<string, Summary[]>> {
    const result = new Map<string, Summary[]>();
    if (fileIds.length === 0) return result;
    for (const id of fileIds) result.set(id, []);

    const { learningFileSummaries, summaries, learningFileIndex } = tables();
    const rows = await selectAll(db()
      .select({
        fileId: learningFileSummaries.fileId,
        id: summaries.id,
        projectId: summaries.projectId,
        title: summaries.title,
        content: summaries.content,
        oneLineSummary: summaries.oneLineSummary,
        categoriesList: summaries.categoriesList,
        sourceChunkIds: summaries.sourceChunkIds,
        toc: summaries.toc,
        version: summaries.version,
        createdAt: summaries.createdAt,
        updatedAt: summaries.updatedAt,
        deletedAt: summaries.deletedAt,
      })
      .from(learningFileSummaries)
      .innerJoin(summaries, eq(summaries.id, learningFileSummaries.summaryId))
      .innerJoin(learningFileIndex, eq(learningFileIndex.id, learningFileSummaries.fileId))
      .where(and(
        inArray(learningFileSummaries.fileId, fileIds),
        isNull(summaries.deletedAt),
        isNull(learningFileIndex.deletedAt)
      ))
      .orderBy(desc(summaries.updatedAt)));

    for (const row of rows) {
      const existing = result.get(row.fileId) ?? [];
      existing.push({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        content: row.content,
        oneLineSummary: row.oneLineSummary,
        categoriesList: row.categoriesList,
        sourceChunkIds: row.sourceChunkIds,
        toc: row.toc,
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
      });
      result.set(row.fileId, existing);
    }

    return result;
  },

  async insert(data: CreateFileData): Promise<LinkedLearningFile> {
    await this.insertMany([data]);
    const files = await this.findByChunkId(data.chunkId);
    const normalizedFileName = normalisePathForMatch(data.fileName);
    return files.find((file) => normalisePathForMatch(file.fileName) === normalizedFileName)!;
  },

  async insertMany(files: CreateFileData[]): Promise<void> {
    if (files.length === 0) return;

    const chunkIds = [...new Set(files.map((file) => file.chunkId))];
    const { learningChunks } = tables();
    const chunks = await selectAll(db()
      .select({ id: learningChunks.id, projectId: learningChunks.projectId })
      .from(learningChunks)
      .where(inArray(learningChunks.id, chunkIds)));
    const projectByChunkId = new Map(chunks.map((chunk) => [chunk.id, chunk.projectId]));

    let changed = false;
    const touchedChunkIds = new Set<string>();

    for (const file of files) {
      const projectId = projectByChunkId.get(file.chunkId);
      if (!projectId) continue;

      const indexed = await ensureFileIndex(projectId, file.fileName, file.purpose);
      changed = indexed.changed || changed;
      changed = (await linkChunkToFile(indexed.row.id, file.chunkId)) || changed;
      touchedChunkIds.add(file.chunkId);
    }

    for (const chunkId of touchedChunkIds) {
      const projectId = projectByChunkId.get(chunkId);
      if (!projectId) continue;
      changed = (await linkSummariesForChunk(projectId, chunkId)) || changed;
    }

    if (changed) markDirty();
  },

  async findById(id: string): Promise<IndexedLearningFile | undefined> {
    const row = await findFileIndexRowById(id);
    if (!row || row.deletedAt) return undefined;
    return (await buildIndexedFiles([row]))[0];
  },

  async findByIdForProject(
    projectId: string,
    id: string
  ): Promise<IndexedLearningFile | undefined> {
    const file = await this.findById(id);
    if (!file || file.projectId !== projectId) return undefined;
    return file;
  },

  async findByProject(
    projectId: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<IndexedLearningFile[]> {
    const rows = await listActiveFileIndexRows(projectId);
    const files = await buildIndexedFiles(rows);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    return files.slice(offset, offset + limit);
  },

  async countByProject(projectId: string): Promise<number> {
    const rows = await listActiveFileIndexRows(projectId);
    return rows.length;
  },

  async update(id: string, data: { fileName?: string; purpose?: string }): Promise<IndexedLearningFile | undefined> {
    const existing = await findFileIndexRowById(id);
    if (!existing || existing.deletedAt) return undefined;
    const { learningFileIndex } = tables();

    const nextFileName = data.fileName ?? existing.fileName;
    const nextNormalizedFileName = normalisePathForMatch(nextFileName);
    const nextPurpose = data.purpose !== undefined
      ? pickPurpose('', data.purpose)
      : existing.summary;

    if (nextNormalizedFileName !== existing.normalizedFileName) {
      const duplicate = await findFileIndexRowByNormalizedPath(existing.projectId, nextNormalizedFileName);
      if (duplicate && duplicate.id !== id) {
        throw new Error(`A file index entry for ${nextFileName} already exists.`);
      }
    }

    await execute(db()
      .update(learningFileIndex)
      .set({
        fileName: nextFileName,
        normalizedFileName: nextNormalizedFileName,
        summary: nextPurpose,
        updatedAt: new Date(),
      } as any)
      .where(eq(learningFileIndex.id, id))
    );

    markDirty();
    return this.findById(id);
  },

  async deleteById(id: string): Promise<void> {
    const { learningFileSummaries, learningFileChunks, learningFileIndex } = tables();
    await execute(db().delete(learningFileSummaries).where(eq(learningFileSummaries.fileId, id)));
    await execute(db().delete(learningFileChunks).where(eq(learningFileChunks.fileId, id)));
    await execute(db().delete(learningFileIndex).where(eq(learningFileIndex.id, id)));
    markDirty();
  },

  async deleteByChunkId(chunkId: string): Promise<void> {
    const { learningFileChunks } = tables();
    const linkedFileIds = await getChunkFileIds(chunkId);
    await execute(db().delete(learningFileChunks).where(eq(learningFileChunks.chunkId, chunkId)));
    const changed = await cleanupFileIndexIds(linkedFileIds);
    if (linkedFileIds.length > 0 || changed) markDirty();
  },

  async softDeleteById(id: string): Promise<void> {
    const { learningFileIndex } = tables();
    await execute(db()
      .update(learningFileIndex)
      .set({ deletedAt: new Date().toISOString(), updatedAt: new Date() } as any)
      .where(eq(learningFileIndex.id, id))
    );
    markDirty();
  },

  async softDeleteByChunkId(chunkId: string): Promise<void> {
    await this.deleteByChunkId(chunkId);
  },

  async findByFileName(projectId: string, fileName: string): Promise<IndexedLearningFile | undefined> {
    const row = await findFileIndexRowByNormalizedPath(projectId, normalisePathForMatch(fileName));
    if (!row || row.deletedAt) return undefined;
    return (await buildIndexedFiles([row]))[0];
  },

  async syncSummaryLinks(projectId: string, summaryId: string, sourceChunkIds: string[]): Promise<void> {
    const { learningFileChunks, learningFileSummaries, learningFileIndex } = tables();
    const uniqueChunkIds = [...new Set(sourceChunkIds)];
    const targetFileIds = uniqueChunkIds.length === 0
      ? []
      : [...new Set((await selectAll(db()
          .select({ fileId: learningFileChunks.fileId })
          .from(learningFileChunks)
          .innerJoin(learningFileIndex, eq(learningFileIndex.id, learningFileChunks.fileId))
          .where(and(
            inArray(learningFileChunks.chunkId, uniqueChunkIds),
            eq(learningFileIndex.projectId, projectId),
            isNull(learningFileIndex.deletedAt)
          )))).map((row) => row.fileId))];

    const existingLinks = await selectAll(db()
      .select({ fileId: learningFileSummaries.fileId })
      .from(learningFileSummaries)
      .where(eq(learningFileSummaries.summaryId, summaryId)));
    const existingFileIds = new Set(existingLinks.map((row) => row.fileId));
    const targetFileIdSet = new Set(targetFileIds);

    const fileIdsToDelete = [...existingFileIds].filter((fileId) => !targetFileIdSet.has(fileId));
    let changed = false;

    for (const fileId of fileIdsToDelete) {
      await execute(db()
        .delete(learningFileSummaries)
        .where(and(eq(learningFileSummaries.fileId, fileId), eq(learningFileSummaries.summaryId, summaryId))));
      changed = true;
    }

    for (const fileId of targetFileIds) {
      changed = (await insertSummaryLink(fileId, summaryId)) || changed;
    }

    if (changed) markDirty();
  },

  async removeSummaryLinks(summaryId: string): Promise<void> {
    const { learningFileSummaries } = tables();
    await execute(db().delete(learningFileSummaries).where(eq(learningFileSummaries.summaryId, summaryId)));
    markDirty();
  },

  async rebuildFileIndexFromLegacy(): Promise<void> {
    const startedAt = Date.now();
    const { learningFiles, learningFileIndex, learningChunks, summaries } = tables();

    // ── Skip marker ─────────────────────────────────────────────────────
    // This backfill converts the legacy `learning_files` table into
    // `learning_file_index`. Nothing writes to the legacy table anymore, so
    // the conversion only needs to run once. Re-running it unconditionally on
    // every startup re-scans every legacy row (several queries per row) and
    // can take ~90s on a large DB.
    //
    // Skip when:
    //   • the index already has rows — converted by a previous run, or
    //     maintained by normal runtime writes
    //   • there are no active legacy rows left to convert
    const existingIndexRow = await selectOne(db()
      .select({ id: learningFileIndex.id })
      .from(learningFileIndex)
      .limit(1));
    if (existingIndexRow) {
      logger.info('File index rebuild skipped — index already populated', {
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const legacyRow = await selectOne(db()
      .select({ id: learningFiles.id })
      .from(learningFiles)
      .where(isNull(learningFiles.deletedAt))
      .limit(1));
    if (!legacyRow) {
      logger.info('File index rebuild skipped — no legacy rows to convert', {
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    logger.info('File index rebuild starting — converting legacy rows');
    const legacyRows = await selectAll(db()
      .select({
        chunkId: learningFiles.chunkId,
        fileName: learningFiles.fileName,
        purpose: learningFiles.purpose,
        projectId: learningChunks.projectId,
      })
      .from(learningFiles)
      .innerJoin(learningChunks, eq(learningChunks.id, learningFiles.chunkId))
      .where(and(isNull(learningFiles.deletedAt), isNull(learningChunks.deletedAt))));

    let changed = false;
    const totalRows = legacyRows.length;
    for (let i = 0; i < totalRows; i++) {
      const row = legacyRows[i];
      const indexed = await ensureFileIndex(row.projectId, row.fileName, row.purpose);
      changed = indexed.changed || changed;
      changed = (await linkChunkToFile(indexed.row.id, row.chunkId)) || changed;

      if ((i + 1) % 250 === 0 || i + 1 === totalRows) {
        logger.info('File index rebuild progress', {
          processed: i + 1,
          total: totalRows,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    const activeSummaries = await selectAll(db()
      .select()
      .from(summaries)
      .where(isNull(summaries.deletedAt)));

    for (const summary of activeSummaries) {
      await this.syncSummaryLinks(summary.projectId, summary.id, parseStoredStringArray(summary.sourceChunkIds));
    }

    if (changed) markDirty();

    logger.info('File index rebuild stats', {
      legacyRows: legacyRows.length,
      activeSummaries: activeSummaries.length,
      changed,
      durationMs: Date.now() - startedAt,
    });
  },
};
