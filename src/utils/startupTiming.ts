import { logger } from './logger';

/**
 * Measure and log the duration of a startup step.
 *
 * Logs a "[startup] <name> — starting" line before running the step and a
 * "[startup] <name> — done" line (with `durationMs`) after it completes. On
 * failure it logs an error with the elapsed time and re-throws.
 *
 * Works for both sync and async steps.
 */
export async function timeStartupStep<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const startedAt = Date.now();
  logger.info(`[startup] ${name} — starting`);
  try {
    const result = await fn();
    logger.info(`[startup] ${name} — done`, { durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    logger.error(`[startup] ${name} — FAILED`, {
      durationMs: Date.now() - startedAt,
      error: String(err),
    });
    throw err;
  }
}
