import type { SummarizerOptions } from './summarizer';
import { runCategorizer } from './categorizer';
import { runCategoryDeduper } from './categoryDeduper';
import { runSummarizer } from './summarizer';
import { logger } from '../utils/logger';

export async function runCategorizedSummarizer(opts: SummarizerOptions): Promise<void> {
  await runCategorizer(opts.projectId);
  try {
    await runCategoryDeduper(opts);
  } catch (err) {
    // The deduper is best-effort — it must never block summarization.
    logger.warn('Category dedup stage failed; continuing to summarizer', {
      projectId: opts.projectId,
      error: String(err),
    });
  }
  await runSummarizer(opts);
}