import { loadConfig } from './config/config';
import { setLogLevel } from './utils/logger';
import { logger } from './utils/logger';
import { initDatabase } from './db/connection';
import { runMigrations } from './db/migrate';
import { startProxyServer } from './proxy/server';
import { startManagementServer } from './api/management';
import { startScheduler } from './workers/scheduler';
import { warmupEmbeddings } from './context/embeddings';
import { providersRepo } from './db/repositories/providers';
import { projectsRepo } from './db/repositories/projects';
import { usersRepo } from './db/repositories/users';
import { providerModelMetadataRepo } from './db/repositories/providerModelMetadata';
import { modelOverridesRepo } from './db/repositories/modelOverrides';
import { modelReferenceRepo } from './db/repositories/modelReference';
import { primeSystemConfigCache } from './config/systemConfigCache';
import { readSetupState } from './config/setupState';
import { registerProcessErrorHandlers } from './utils/processErrors';
import { serializeError } from './utils/appErrors';
import { timeStartupStep } from './utils/startupTiming';

registerProcessErrorHandlers();

/**
 * If the user has API keys in environment variables but no providers in the DB,
 * auto-seed the DB so that existing Docker / env-var setups still work without
 * requiring a UI visit. This runs exactly once — after providers exist in the DB,
 * env vars are ignored for routing.
 */
async function seedProvidersFromEnv(): Promise<void> {
  if (await providersRepo.count() > 0) return; // already configured via UI

  const seeds: Array<{ name: string; type: 'openai' | 'anthropic'; baseUrl: string; models: string; envKey: string }> = [
    { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: 'gpt-4o-mini', envKey: 'OPENAI_API_KEY' },
    { name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', models: 'claude-sonnet-4-20250514', envKey: 'ANTHROPIC_API_KEY' },
    { name: 'OpenCode', type: 'openai', baseUrl: 'https://opencode.ai/zen/go', models: 'gpt-4o-mini', envKey: 'OPENCODE_API_KEY' },
  ];

  let seeded = 0;
  for (const seed of seeds) {
    const key = process.env[seed.envKey];
    if (key) {
      await providersRepo.insert({ name: seed.name, type: seed.type, baseUrl: seed.baseUrl, apiKey: key, models: seed.models });
      logger.info('Auto-seeded provider from environment variable', { name: seed.name, envKey: seed.envKey });
      seeded++;
    }
  }

  if (seeded === 0) {
    logger.info(
      `No providers configured. Open the management UI to add one.`,
      { url: 'http://localhost:9090/ui' }
    );
  }
}

async function ensureConfiguredLocalAdminAccount(): Promise<void> {
  const config = loadConfig();
  if (config.mode !== 'local') return;
  if ((await usersRepo.count()) > 0) return;

  const setupState = readSetupState().state;
  const localAdmin = setupState?.mode === 'local' ? setupState.localAdmin : undefined;
  if (!localAdmin) {
    logger.info('Local mode is waiting for the initial setup to create the first admin account.');
    return;
  }

  await usersRepo.create({
    email: localAdmin.email,
    passwordHash: localAdmin.passwordHash,
    role: 'admin',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: true,
    accessAllModels: true,
    allowedModels: [],
  });

  logger.info('Created local admin account from setup state', {
    login: localAdmin.email,
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logging.level);

  const startupStartedAt = Date.now();

  logger.info('Starting Intelligent Context', {
    version: '0.1.0',
    mode: config.mode,
    nodeVersion: process.version,
  });

  // Initialise DB and run migrations
  await timeStartupStep('initDatabase', () => initDatabase());
  await timeStartupStep('runMigrations', () => runMigrations());
  await timeStartupStep('ensureDefaultProject', () => projectsRepo.ensureDefaultProject());
  await timeStartupStep('ensureConfiguredLocalAdminAccount', () => ensureConfiguredLocalAdminAccount());
  await timeStartupStep('primeSystemConfigCache', () => primeSystemConfigCache());
  await timeStartupStep('primeModelMetadataCache', () => providerModelMetadataRepo.primeCache());
  await timeStartupStep('primeModelOverridesCache', () => modelOverridesRepo.primeCache());
  await timeStartupStep('primeModelReferenceCache', () => modelReferenceRepo.primeCache());

  // Seed providers from env vars if no providers exist yet (optional convenience)
  await timeStartupStep('seedProvidersFromEnv', () => seedProvidersFromEnv());

  // Start proxy
  await timeStartupStep('startProxyServer', () => startProxyServer(config.proxy.host, config.proxy.port));

  // Start management API
  await timeStartupStep('startManagementServer', () => startManagementServer(config.management.host, config.management.port));

  // Kick off embedding model loading in background (non-blocking)
  warmupEmbeddings();
  logger.info('Embedding model warm-up kicked off in background', {
    model: config.context.embeddingModel,
  });

  // Start background workers
  await timeStartupStep('startScheduler', () => startScheduler());

  logger.info('Intelligent Context ready', {
    proxy: `http://${config.proxy.host}:${config.proxy.port}/v1`,
    management: `http://${config.management.host}:${config.management.port}`,
    ui: `http://${config.management.host}:${config.management.port}/ui`,
    totalStartupMs: Date.now() - startupStartedAt,
  });

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down…');
  try {
    const { closeDatabase } = require('./db/connection');
    await closeDatabase();
  } catch {
    // Ignore
  }
  process.exit(0);
}

main().catch((err: Error) => {
  logger.error('Fatal error during startup', serializeError(err));
  process.exit(1);
});
