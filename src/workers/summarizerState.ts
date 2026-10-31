import { eq } from 'drizzle-orm';
import { getSystemConfigCacheValue, setSystemConfigCacheValue } from '../config/systemConfigCache';
import { db, execute, markDirty, selectOne } from '../db/connection';
import { systemConfig } from '../db/schema';

export const MIN_NEW_CHUNKS_FOR_SCHEDULED_SUMMARIZER = 5;

function buildLastSuccessfulRunKey(projectId: string): string {
  return `workers.summarizer.lastSuccessfulRunAt.${projectId}`;
}

export function shouldRunScheduledSummarizer(newChunkCount: number): boolean {
  return newChunkCount >= MIN_NEW_CHUNKS_FOR_SCHEDULED_SUMMARIZER;
}

export function shouldPersistSuccessfulRun(
  hadFailure: boolean,
  remainingUnsummarized: number
): boolean {
  return !hadFailure && remainingUnsummarized === 0;
}

export async function getSummarizerLastSuccessfulRunAt(projectId: string): Promise<string | null> {
  const key = buildLastSuccessfulRunKey(projectId);
  const cached = getSystemConfigCacheValue(key);
  if (cached !== '') {
    return cached;
  }

  const row = await selectOne<{ value: string }>(db()
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, key)));

  const value = row?.value ?? '';
  setSystemConfigCacheValue(key, value);
  return value || null;
}

export async function setSummarizerLastSuccessfulRunAt(projectId: string, value: string): Promise<void> {
  const key = buildLastSuccessfulRunKey(projectId);
  const existing = await selectOne<{ key: string }>(db()
    .select({ key: systemConfig.key })
    .from(systemConfig)
    .where(eq(systemConfig.key, key)));

  if (existing) {
    await execute(db().update(systemConfig).set({ value }).where(eq(systemConfig.key, key)));
  } else {
    await execute(db().insert(systemConfig).values({ key, value }));
  }

  setSystemConfigCacheValue(key, value);
  markDirty();
}