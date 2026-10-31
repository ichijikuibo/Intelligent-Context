import cron from 'node-cron';
import { projectsRepo } from '../db/repositories/projects';
import { runAnalyzer } from './analyzer';
import { runCategorizedSummarizer } from './summaryPipeline';
import { getConfig } from '../config/config';
import { logger } from '../utils/logger';
import { resolveProviderAndModelForJob } from '../proxy/upstream';
import { getSystemModelConfig } from '../config/systemModels';
import { syncAllExternalProviders } from '../api/routes/externalProviders';
import { syncModelReferenceIfEnabled } from '../externalProviders/modelReference';

let lastRequestTime: Date = new Date();

export function touchLastRequest(): void {
  lastRequestTime = new Date();
}

async function runSummaryJobs(): Promise<void> {
  const models = getSystemModelConfig();
  if (!models.summarizer) {
    logger.warn('Summarizer model not configured — skipping. Set it in Settings.');
    return;
  }
  const execution = await resolveProviderAndModelForJob(models.summarizer, 'openai');
  if (!execution) {
    logger.warn('No provider configured for background jobs — skipping summarization');
    return;
  }

  const projects = await projectsRepo.findAll();
  for (const project of projects) {
    await runCategorizedSummarizer({
      projectId: project.id,
      model: execution.model,
      provider: execution,
      trigger: 'scheduled',
    }).catch((err) =>
      logger.error('Summary pipeline error', { project: project.name, error: String(err) })
    );
  }
}

async function runAnalysisJobs(): Promise<void> {
  const models = getSystemModelConfig();
  if (!models.analyzer) return;

  const config = getConfig();
  const minutesSinceLastRequest =
    (Date.now() - lastRequestTime.getTime()) / 1000 / 60;

  if (minutesSinceLastRequest < config.workers.idleThresholdMinutes) {
    return;
  }

  const execution = await resolveProviderAndModelForJob(models.analyzer, 'openai');
  if (!execution) return;

  const projects = await projectsRepo.findAll();
  for (const project of projects) {
    await runAnalyzer({
      projectId: project.id,
      model: execution.model,
      provider: execution,
    }).catch((err) =>
      logger.error('Analyzer error', { project: project.name, error: String(err) })
    );
  }
}

export function startScheduler(): void {
  const config = getConfig();

  // Summarization job — runs every N minutes
  const summarizeMinutes = config.workers.summarizeIntervalMinutes;
  cron.schedule(`*/${summarizeMinutes} * * * *`, () => {
    runSummaryJobs().catch((err) =>
      logger.error('Summary job error', { error: String(err) })
    );
  });

  logger.info('Summarizer scheduled', { intervalMinutes: summarizeMinutes });

  // Deep analysis job — runs every N hours (at minute 0)
  const analyzeHours = config.workers.analyzeIntervalHours;
  cron.schedule(`0 */${analyzeHours} * * *`, () => {
    runAnalysisJobs().catch((err) =>
      logger.error('Analysis job error', { error: String(err) })
    );
  });

  logger.info('Analyzer scheduled', { intervalHours: analyzeHours });

  // External provider model sync — runs every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    syncAllExternalProviders().catch((err) =>
      logger.error('External provider sync error', { error: String(err) })
    );
  });

  logger.info('External provider sync scheduled', { intervalMinutes: 30 });

  // Shared model reference catalog (OpenRouter) — models change slowly, so a
  // twice-daily refresh is plenty and keeps the default context windows fresh.
  cron.schedule('0 */12 * * *', () => {
    syncModelReferenceIfEnabled().catch((err) =>
      logger.error('Model reference sync error', { error: String(err) })
    );
  });

  logger.info('Model reference sync scheduled', { intervalHours: 12 });

  // Run an initial sync for external providers on startup (after a short delay)
  setTimeout(() => {
    syncAllExternalProviders().catch((err) =>
      logger.error('Initial external provider sync error', { error: String(err) })
    );

    syncModelReferenceIfEnabled().catch((err) =>
      logger.error('Initial model reference sync error', { error: String(err) })
    );
  }, 10_000);
}
