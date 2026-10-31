import { backgroundTaskRunsRepo } from '../db/repositories/backgroundTaskRuns';
import { logger } from './logger';

export interface TaskRunLogInput {
  projectId: string;
  taskType: string;
  model: string;
  providerName: string;
  providerType: string;
  status: 'success' | 'error' | 'skipped';
  summary: string;
  errorMessage?: string;
}

/**
 * Log a background task run to background_task_runs.
 *
 * - `willNotifyUser` is true when status is 'error'.
 * - `willNotifyUser` is false for success/skipped.
 *
 * Errors writing the log are swallowed — task-run logging is best-effort
 * and must never fail the parent operation.
 */
export async function logTaskRun(data: TaskRunLogInput): Promise<void> {
  try {
    await backgroundTaskRunsRepo.insert({
      projectId: data.projectId,
      taskType: data.taskType,
      model: data.model,
      providerName: data.providerName,
      providerType: data.providerType,
      status: data.status,
      summary: data.summary,
      errorMessage: data.errorMessage ?? '',
      willNotifyUser: data.status === 'error',
    });
  } catch (err) {
    logger.warn('Failed to write background task run log', {
      taskType: data.taskType,
      projectId: data.projectId,
      error: String(err),
    });
  }
}
