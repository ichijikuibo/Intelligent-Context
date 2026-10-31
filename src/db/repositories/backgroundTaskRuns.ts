import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, execute, selectAll } from '../connection';
import { getSchema, type NewBackgroundTaskRunEntry, type BackgroundTaskRunEntry } from '../schema';
import { eq, and, desc, sql, type InferSelectModel } from 'drizzle-orm';

function tables() {
  return getSchema();
}

export interface InsertTaskRunData {
  projectId?: string | null;
  taskType: string;
  model: string;
  providerName: string;
  providerType: string;
  status: 'success' | 'error' | 'skipped';
  summary: string;
  errorMessage?: string;
  willNotifyUser: boolean;
}

type TaskRunRow = InferSelectModel<ReturnType<typeof getSchema>['backgroundTaskRuns']>;

export const backgroundTaskRunsRepo = {
  async insert(data: InsertTaskRunData): Promise<BackgroundTaskRunEntry> {
    const { backgroundTaskRuns } = tables();
    const now = new Date();
    const row = {
      id: uuidv4(),
      projectId: data.projectId ?? null,
      taskType: data.taskType,
      model: data.model,
      providerName: data.providerName,
      providerType: data.providerType,
      status: data.status,
      summary: data.summary,
      errorMessage: data.errorMessage ?? '',
      willNotifyUser: data.willNotifyUser,
      read: false,
      startedAt: now,
      completedAt: now,
    } as NewBackgroundTaskRunEntry;
    await execute(db().insert(backgroundTaskRuns).values(row as TaskRunRow));
    markDirty();
    return row as unknown as BackgroundTaskRunEntry;
  },

  async findUnread(): Promise<BackgroundTaskRunEntry[]> {
    const { backgroundTaskRuns } = tables();
    return selectAll(
      db()
        .select()
        .from(backgroundTaskRuns)
        .where(
          and(
            eq(backgroundTaskRuns.willNotifyUser, true),
            eq(backgroundTaskRuns.read, false),
          ),
        )
        .orderBy(desc(backgroundTaskRuns.completedAt)),
    );
  },

  async countUnread(): Promise<number> {
    const { backgroundTaskRuns } = tables();
    const rows = await selectAll(
      db()
        .select({ count: sql<number>`count(*)` })
        .from(backgroundTaskRuns)
        .where(
          and(
            eq(backgroundTaskRuns.willNotifyUser, true),
            eq(backgroundTaskRuns.read, false),
          ),
        ),
    );
    return rows?.[0]?.count ?? 0;
  },

  async markRead(id: string): Promise<void> {
    const { backgroundTaskRuns } = tables();
    await execute(
      db().update(backgroundTaskRuns).set({ read: true } as Partial<TaskRunRow>).where(eq(backgroundTaskRuns.id, id)),
    );
    markDirty();
  },

  async markAllRead(): Promise<void> {
    const { backgroundTaskRuns } = tables();
    await execute(
      db()
        .update(backgroundTaskRuns)
        .set({ read: true } as Partial<TaskRunRow>)
        .where(
          and(
            eq(backgroundTaskRuns.willNotifyUser, true),
            eq(backgroundTaskRuns.read, false),
          ),
        ),
    );
    markDirty();
  },

  async findRecent(limit = 50): Promise<BackgroundTaskRunEntry[]> {
    const { backgroundTaskRuns } = tables();
    return selectAll(
      db()
        .select()
        .from(backgroundTaskRuns)
        .orderBy(desc(backgroundTaskRuns.completedAt))
        .limit(limit),
    );
  },
};
