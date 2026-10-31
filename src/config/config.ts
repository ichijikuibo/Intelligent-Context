import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from './defaults';
import { readSetupState, setupStateToConfigOverride } from './setupState';

export interface ProxyConfig {
  host: string;
  port: number;
  apiKey?: string;
  /**
   * Allowed proxy requests per minute per key (user, API key or IP).
   * Defaults to 600 (see `DEFAULT_CONFIG`). Override in the YAML `proxy`
   * section or with `IC_RATE_LIMIT_PER_MINUTE`.
   */
  rateLimitPerMinute?: number;
}

export interface ManagementConfig {
  host: string;
  port: number;
}

export interface DatabaseConfig {
  type: 'sqlite' | 'postgres';
  sqlitePath?: string;
  postgresUrl?: string;
  /** Number of rolling backups to retain (sqlite only). Default 10. */
  backupRetention?: number;
}

export interface ModelsConfig {
  contextSelector: string;
  summarizer: string;
  analyzer: string;
  /**
   * Dedicated model for the explicit `ic_select_context` tool. Kept separate
   * so the tool can always run context selection regardless of the configured
   * request-context mode, without silently reusing the (possibly disabled)
   * context-selector model.
   */
  icTools: string;
}

export interface ContextConfig {
  tokenBudget: number;
  autoSummarizeThreshold: number;
  fallbackExtraction: boolean;
  embeddingModel: string;
  maxCandidates: number;
  minConfidence: number;
  semanticDuplicateThreshold: number;
  /** When true, learning block markers are NOT stripped from the response — useful for debugging extraction issues */
  debugLearningBlocks: boolean;
  /**
   * Skip the LLM rerank and attach ALL chunks+summaries for the project
   * when their combined count is at or below this number. Avoids paying
   * for a model call on small projects where everything fits anyway.
   */
  bypassSelectorItemThreshold: number;
  /**
   * Skip the LLM rerank and attach ALL chunks+summaries for the project
   * when their estimated total token size is at or below this value.
   * Acts as a safety net for the item threshold on very long facts.
   */
  bypassSelectorTokenThreshold: number;
  /**
   * TTL in minutes for the cached context bundle replayed on tool
   * continuations. Set to 0 to disable replay caching.
   */
  contextReplayTtlMinutes: number;
  /** Hard cap on the number of replay-cache entries held in memory. */
  maxCachedContexts: number;
  /** Tokens reserved for the model response in the budget calculation. */
  reservedResponseTokens: number;
  /** Per-request overhead (priming, framing, role labels) added to the budget. */
  contextOverheadTokens: number;
  /** Conservative default for model context windows not in the known-list. */
  defaultModelMaxTokens: number;
  /** When true, skip the gatherer stage on tool-continuation turns. */
  gathererSkipOnToolContinuation: boolean;
  /**
   * Maximum number of learnings (facts) accepted in a single
   * `ic record` / `record_learning` call. Batches larger than this are
   * truncated gracefully: the first N entries are processed and the tool
   * result tells the model to send the remainder in a follow-up call.
   */
  maxRecordLearnings: number;
}

export interface WorkersConfig {
  summarizeIntervalMinutes: number;
  analyzeIntervalHours: number;
  idleThresholdMinutes: number;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
}

export interface AppConfig {
  mode: 'local' | 'server';
  proxy: ProxyConfig;
  management: ManagementConfig;
  database: DatabaseConfig;
  models: ModelsConfig;
  providers: Record<string, ProviderConfig>;
  context: ContextConfig;
  workers: WorkersConfig;
  logging: LoggingConfig;
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const val = (source as Record<string, unknown>)[key];
    if (
      val !== undefined &&
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val)
    ) {
      result[key] = deepMerge(
        ((result[key] as Record<string, unknown>) || {}),
        val as Record<string, unknown>
      );
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as T;
}

function fromEnv(): Partial<AppConfig> {
  const env: Partial<AppConfig> = {};

  if (process.env.IC_MODE) {
    env.mode = process.env.IC_MODE as 'local' | 'server';
  }
  if (process.env.IC_PROXY_PORT || process.env.IC_API_KEY || process.env.IC_RATE_LIMIT_PER_MINUTE) {
    const parsedRateLimit = process.env.IC_RATE_LIMIT_PER_MINUTE
      ? parseInt(process.env.IC_RATE_LIMIT_PER_MINUTE, 10)
      : undefined;
    env.proxy = {
      host: process.env.IC_MODE === 'server' ? '0.0.0.0' : '127.0.0.1',
      port: process.env.IC_PROXY_PORT ? parseInt(process.env.IC_PROXY_PORT, 10) : 1234,
      apiKey: process.env.IC_API_KEY,
      ...(parsedRateLimit !== undefined && Number.isFinite(parsedRateLimit) && parsedRateLimit > 0
        ? { rateLimitPerMinute: parsedRateLimit }
        : {}),
    };
  }
  if (process.env.IC_MGMT_PORT) {
    env.management = {
      host: '127.0.0.1',
      port: parseInt(process.env.IC_MGMT_PORT, 10),
    };
  }
  if (process.env.DATABASE_URL) {
    env.database = { type: 'postgres', postgresUrl: process.env.DATABASE_URL };
  } else if (process.env.SQLITE_PATH) {
    env.database = { type: 'sqlite', sqlitePath: process.env.SQLITE_PATH };
  }
  if (process.env.IC_LOG_LEVEL) {
    env.logging = { level: process.env.IC_LOG_LEVEL as LoggingConfig['level'] };
  }

  const providers: Record<string, ProviderConfig> = {};
  if (process.env.OPENAI_API_KEY) {
    providers.openai = { apiKey: process.env.OPENAI_API_KEY, baseUrl: 'https://api.openai.com/v1' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: 'https://api.anthropic.com' };
  }
  if (process.env.OPENCODE_API_KEY) {
    providers.opencode = { apiKey: process.env.OPENCODE_API_KEY, baseUrl: 'https://opencode.ai/zen/go' };
  }
  if (Object.keys(providers).length > 0) env.providers = providers;

  return env;
}

let _config: AppConfig | null = null;

export function loadConfig(configFilePath?: string): AppConfig {
  if (_config) return _config;

  // Load .env-style values if .env exists
  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  }

  let config = { ...DEFAULT_CONFIG } as AppConfig;

  const searchPaths = [
    configFilePath,
    path.join(process.cwd(), 'intelligent-context.yaml'),
    path.join(process.cwd(), 'intelligent-context.yml'),
    path.join(os.homedir(), '.intelligent-context', 'config.yaml'),
  ].filter(Boolean) as string[];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      // Substitute env vars in YAML (${VAR} syntax)
      const substituted = raw.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
      const fileConfig = parseYaml(substituted) as Partial<AppConfig>;
      config = deepMerge(config as unknown as Record<string, unknown>, fileConfig as unknown as Record<string, unknown>) as unknown as AppConfig;
      break;
    }
  }

  // Env overrides
  config = deepMerge(config as unknown as Record<string, unknown>, fromEnv() as unknown as Record<string, unknown>) as unknown as AppConfig;

  const setupResult = readSetupState();
  if (setupResult.state) {
    const setupOverride = setupStateToConfigOverride(setupResult.state);
    config.mode = setupOverride.mode;
    config.database = {
      type: setupOverride.database.type,
      sqlitePath:
        setupOverride.database.type === 'sqlite'
          ? setupOverride.database.sqlitePath || config.database.sqlitePath
          : undefined,
      postgresUrl:
        setupOverride.database.type === 'postgres'
          ? setupOverride.database.postgresUrl || config.database.postgresUrl
          : undefined,
      backupRetention: setupOverride.database.backupRetention ?? config.database.backupRetention,
    };
  }

  // Expand home paths
  if (config.database.sqlitePath) {
    config.database.sqlitePath = expandHome(config.database.sqlitePath);
  }

  // Bind localhost for local mode and all interfaces for server mode.
  if (config.mode === 'server') {
    config.proxy.host = '0.0.0.0';
    config.management.host = '0.0.0.0';
  } else {
    config.proxy.host = '127.0.0.1';
    config.management.host = '127.0.0.1';
  }

  _config = config;
  return config;
}

export function getConfig(): AppConfig {
  return _config ?? loadConfig();
}

/** Reset cached config (useful for tests) */
export function resetConfig(): void {
  _config = null;
}
