import { eq, desc, sql, and, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type Summary, type NewSummary } from '../schema';
import { generateSummaryToc } from '../../context/toc';
import { filesRepo } from './files';

function tables() {
  return getSchema();
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

export interface CreateSummaryData {
  projectId: string;
  title: string;
  content: string;
  sourceChunkIds: string[];
  oneLineSummary?: string;
  categoriesList?: string;
}

export const summariesRepo = {
  async findById(id: string): Promise<Summary | undefined> {
    const { summaries } = tables();
    return selectOne(db()
      .select()
      .from(summaries)
      .where(and(eq(summaries.id, id), isNull(summaries.deletedAt))));
  },

  async findByProject(projectId: string): Promise<Summary[]> {
    const { summaries } = tables();
    return selectAll(db()
      .select()
      .from(summaries)
      .where(and(eq(summaries.projectId, projectId), isNull(summaries.deletedAt)))
      .orderBy(desc(summaries.updatedAt))
    );
  },

  async countByProject(projectId: string): Promise<number> {
    const { summaries } = tables();
    const result = await selectOne<{ count: number | string }>(db()
      .select({ count: sql<number>`count(*)` })
      .from(summaries)
      .where(and(eq(summaries.projectId, projectId), isNull(summaries.deletedAt))));
    return Number(result?.count ?? 0);
  },

  async insert(data: CreateSummaryData): Promise<Summary> {
    const now = new Date().toISOString();
    const { summaries } = tables();
    const row: NewSummary = {
      id: uuidv4(),
      projectId: data.projectId,
      title: data.title,
      content: data.content,
      oneLineSummary: data.oneLineSummary ?? '',
      categoriesList: data.categoriesList ?? '[]',
      sourceChunkIds: JSON.stringify(data.sourceChunkIds),
      toc: generateSummaryToc(data.content),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await execute(db().insert(summaries).values(row));
    await filesRepo.syncSummaryLinks(data.projectId, row.id, data.sourceChunkIds);
    markDirty();
    return (await this.findById(row.id))!;
  },

  async update(id: string, data: { title?: string; content?: string; oneLineSummary?: string; categoriesList?: string; sourceChunkIds?: string[] }): Promise<Summary | undefined> {
    const existing = await this.findById(id);
    if (!existing) return undefined;
    const { summaries } = tables();

    const setData: Record<string, unknown> = { version: existing.version + 1, updatedAt: new Date().toISOString() };
    if (data.title !== undefined) setData.title = data.title;
    if (data.content !== undefined) setData.content = data.content;
    if (data.oneLineSummary !== undefined) setData.oneLineSummary = data.oneLineSummary;
    if (data.categoriesList !== undefined) setData.categoriesList = data.categoriesList;
    if (data.sourceChunkIds !== undefined) setData.sourceChunkIds = JSON.stringify(data.sourceChunkIds);

    // Regenerate TOC whenever content changes
    if (data.content !== undefined) {
      setData.toc = generateSummaryToc(data.content);
    }

    await execute(db()
      .update(summaries)
      .set(setData as any)
      .where(eq(summaries.id, id))
    );
    if (data.sourceChunkIds !== undefined) {
      await filesRepo.syncSummaryLinks(existing.projectId, id, data.sourceChunkIds);
    }
    markDirty();
    return this.findById(id);
  },

  /** Find summaries whose categoriesList JSON array contains a specific category slug. */
  async findByCategory(projectId: string, category: string): Promise<Summary | undefined> {
    // categoriesList stores JSON like ["architecture","api-design"]
    // We search for the category slug inside the JSON string
    const { summaries } = tables();
    return (await selectAll(db()
      .select()
      .from(summaries)
      .where(and(eq(summaries.projectId, projectId), isNull(summaries.deletedAt)))
      .orderBy(desc(summaries.updatedAt))
    ))
      .find((s: Summary) => {
        try {
          const cats: string[] = JSON.parse(s.categoriesList || '[]');
          return cats.includes(category);
        } catch {
          return false;
        }
      });
  },

  async delete(id: string): Promise<void> {
    const { summaries } = tables();
    await filesRepo.removeSummaryLinks(id);
    await execute(db().delete(summaries).where(eq(summaries.id, id)));
    markDirty();
  },

  async softDelete(id: string): Promise<void> {
    const { summaries } = tables();
    const existing = await this.findById(id);
    if (!existing) return;
    await filesRepo.removeSummaryLinks(id);
    await execute(db()
      .update(summaries)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(summaries.id, id)));
    markDirty();
  },
};
