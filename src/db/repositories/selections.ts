import { eq, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, execute } from '../connection';
import { getSchema, type ContextSelection, type NewContextSelection } from '../schema';

function tables() {
  return getSchema();
}

export interface CreateSelectionData {
  projectId: string;
  userId?: string;
  requestId: string;
  selectedChunkIds: string[];
  selectedSummaryIds: string[];
  totalTokensInjected: number;
  selectionMethod: string;
  selectionLatencyMs: number;
}

export const selectionsRepo = {
  async insert(data: CreateSelectionData): Promise<void> {
    const { contextSelections } = tables();
    const row: NewContextSelection = {
      id: uuidv4(),
      projectId: data.projectId,
      userId: data.userId ?? null,
      requestId: data.requestId,
      selectedChunkIds: JSON.stringify(data.selectedChunkIds),
      selectedSummaryIds: JSON.stringify(data.selectedSummaryIds),
      totalTokensInjected: data.totalTokensInjected,
      selectionMethod: data.selectionMethod,
      selectionLatencyMs: data.selectionLatencyMs,
      createdAt: new Date(),
    };
    await execute(db().insert(contextSelections).values(row));
    markDirty();
  },

  async findByProject(
    projectId: string,
    limit = 50
  ): Promise<ContextSelection[]> {
    const { contextSelections } = tables();
    return selectAll(db()
      .select()
      .from(contextSelections)
      .where(eq(contextSelections.projectId, projectId))
      .orderBy(desc(contextSelections.createdAt))
      .limit(limit)
    );
  },
};
