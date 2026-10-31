import { desc, eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type AnalysisFinding, type NewAnalysisFinding } from '../schema';

function tables() {
  return getSchema();
}

export type FindingStatus = 'open' | 'accepted' | 'dismissed' | 'implemented' | 'actioned' | 'false';

export interface FindingAction {
  action: 'delete' | 'update' | 'done';
  targetType: 'chunk' | 'summary' | 'file' | 'finding';
  targetId: string;
  updateText?: string;
}

export interface RelatedIds {
  chunkIds: string[];
  summaryIds: string[];
  findingIds: string[];
}

export interface FindingRecord extends Omit<AnalysisFinding, 'actions' | 'relatedIds'> {
  actions: FindingAction[];
  relatedIds: RelatedIds;
}

export interface CreateFindingData {
  projectId: string;
  type: string;
  severity: string;
  title: string;
  description: string;
  relatedIds?: RelatedIds;
  actions?: FindingAction[];
  status?: FindingStatus;
  createdAt?: Date;
}

function parseActions(raw: string | null | undefined): FindingAction[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap<FindingAction>((item: unknown) => {
      if (!item || typeof item !== 'object') return [];

      const candidate = item as Record<string, unknown>;
      const action = candidate.action;
      const targetType = candidate.targetType;
      const targetId = candidate.targetId;
      const updateText = candidate.updateText ?? candidate['update-text'];

      if (action === 'done') {
        if (targetType !== 'finding' || typeof targetId !== 'string') {
          return [];
        }

        return [{
          action,
          targetType,
          targetId,
        } satisfies FindingAction];
      }

      if ((action !== 'delete' && action !== 'update') || typeof targetId !== 'string') {
        return [];
      }

      if (targetType !== 'chunk' && targetType !== 'summary' && targetType !== 'file') {
        return [];
      }

      return [{
        action,
        targetType,
        targetId,
        updateText: typeof updateText === 'string' ? updateText : undefined,
      } satisfies FindingAction];
    });
  } catch {
    return [];
  }
}

function parseRelatedIds(raw: string | null | undefined): RelatedIds {
  const empty: RelatedIds = { chunkIds: [], summaryIds: [], findingIds: [] };
  if (!raw) return empty;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Handle legacy format: array of chunk IDs
      if (Array.isArray(parsed)) {
        return { chunkIds: parsed.filter((id): id is string => typeof id === 'string'), summaryIds: [], findingIds: [] };
      }
      return empty;
    }

    return {
      chunkIds: Array.isArray(parsed.chunkIds) ? parsed.chunkIds.filter((id: unknown): id is string => typeof id === 'string') : [],
      summaryIds: Array.isArray(parsed.summaryIds) ? parsed.summaryIds.filter((id: unknown): id is string => typeof id === 'string') : [],
      findingIds: Array.isArray(parsed.findingIds) ? parsed.findingIds.filter((id: unknown): id is string => typeof id === 'string') : [],
    };
  } catch {
    return empty;
  }
}

function mapFinding(row: AnalysisFinding | undefined): FindingRecord | undefined {
  if (!row) return undefined;
  return {
    ...row,
    actions: parseActions(row.actions),
    relatedIds: parseRelatedIds(row.relatedIds),
  };
}

export const findingsRepo = {
  async findById(id: string): Promise<FindingRecord | undefined> {
    const { analysisFindings } = tables();
    const row = await selectOne(db()
      .select()
      .from(analysisFindings)
      .where(eq(analysisFindings.id, id)));
    return mapFinding(row);
  },

  async findByProject(projectId: string): Promise<FindingRecord[]> {
    const { analysisFindings } = tables();
    const rows = await selectAll(db()
      .select()
      .from(analysisFindings)
      .where(eq(analysisFindings.projectId, projectId))
      .orderBy(desc(analysisFindings.createdAt)));
    return rows.map((row) => mapFinding(row)!).filter(Boolean);
  },

  async findOpenGapsByProject(projectId: string): Promise<FindingRecord[]> {
    const { analysisFindings } = tables();
    const rows = await selectAll(db()
      .select()
      .from(analysisFindings)
      .where(and(
        eq(analysisFindings.projectId, projectId),
        eq(analysisFindings.type, 'gap'),
        eq(analysisFindings.status, 'open')
      ))
      .orderBy(desc(analysisFindings.createdAt)));
    return rows.map((row) => mapFinding(row)!).filter(Boolean);
  },

  async countOpenGapsByProject(projectId: string): Promise<number> {
    const gaps = await this.findOpenGapsByProject(projectId);
    return gaps.length;
  },

  async insert(data: CreateFindingData): Promise<FindingRecord> {
    const { analysisFindings } = tables();
    const row: NewAnalysisFinding = {
      id: uuidv4(),
      projectId: data.projectId,
      type: data.type,
      severity: data.severity,
      title: data.title,
      description: data.description,
      relatedIds: JSON.stringify(data.relatedIds ?? { chunkIds: [], summaryIds: [], findingIds: [] }),
      actions: JSON.stringify(data.actions ?? []),
      status: data.status ?? 'open',
      createdAt: data.createdAt ?? new Date(),
      reviewedAt: null,
      actionsAppliedAt: null,
    };

    await execute(db().insert(analysisFindings).values(row));
    markDirty();

    return (await this.findById(row.id))!;
  },

  async updateStatus(
    id: string,
    status: FindingStatus,
    opts: { reviewedAt?: Date; actionsAppliedAt?: Date | null } = {}
  ): Promise<FindingRecord | undefined> {
    const { analysisFindings } = tables();
    const updates: Partial<NewAnalysisFinding> = {
      status,
      reviewedAt: opts.reviewedAt ?? new Date(),
    };

    if (opts.actionsAppliedAt !== undefined) {
      updates.actionsAppliedAt = opts.actionsAppliedAt;
    }

    await execute(db()
      .update(analysisFindings)
      .set(updates)
      .where(eq(analysisFindings.id, id))
    );
    markDirty();
    return this.findById(id);
  },
};