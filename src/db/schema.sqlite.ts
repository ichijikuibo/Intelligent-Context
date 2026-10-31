import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  primaryKey,
  index,
} from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull().unique(),
  pathPattern: text('path_pattern'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  settings: text('settings').notNull().default('{}'),
  summarizationLastRun: text('summarization_last_run'),
  analyzerLastRun: text('analyzer_last_run'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  isApproved: integer('is_approved', { mode: 'boolean' }).notNull().default(false),
  isDisabled: integer('is_disabled', { mode: 'boolean' }).notNull().default(false),
  accessAllProjects: integer('access_all_projects', { mode: 'boolean' }).notNull().default(false),
  accessAllModels: integer('access_all_models', { mode: 'boolean' }).notNull().default(false),
  /**
   * Access grants: provider-scoped model IDs, optionally with `*` wildcards
   * (`*-*`, `OCA-*`, `OCA-deepseek-v4`). Empty means "no models".
   */
  allowedModels: text('allowed_models').notNull().default('[]'),
  /**
   * Voluntary visibility preference: scoped model IDs the user does not want to
   * see in their IDE's model picker. Purely cosmetic — a hidden model is still
   * routable, so this can never lock anyone out. Same wildcard syntax as
   * {@link allowedModels}.
   */
  hiddenModels: text('hidden_models').notNull().default('[]'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
});

export const userApiKeys = sqliteTable('user_api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull().unique(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
});

export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.projectId, table.userId] }) })
);

export const learningChunks = sqliteTable('learning_chunks', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'),
  requestId: text('request_id'),
  fact: text('fact').notNull(),
  category: text('category').notNull().default('general'),
  confidence: real('confidence').notNull().default(0),
  source: text('source').notNull().default('extraction'),
  hash: text('hash').notNull(),
  tokensUsed: integer('tokens_used').default(0),
  summarized: integer('summarized', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const summaries = sqliteTable('summaries', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  content: text('content').notNull(),
  oneLineSummary: text('one_line_summary').notNull().default(''),
  categoriesList: text('categories_list').notNull().default('[]'),
  sourceChunkIds: text('source_chunk_ids').notNull().default('[]'),
  toc: text('toc').notNull().default('[]'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const learningFiles = sqliteTable('learning_files', {
  id: text('id').primaryKey(),
  chunkId: text('chunk_id')
    .notNull()
    .references(() => learningChunks.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  purpose: text('purpose').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  deletedAt: text('deleted_at'),
});

export const learningFileIndex = sqliteTable('learning_file_index', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  normalizedFileName: text('normalized_file_name').notNull(),
  summary: text('summary').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  deletedAt: text('deleted_at'),
});

export const learningFileChunks = sqliteTable(
  'learning_file_chunks',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => learningFileIndex.id, { onDelete: 'cascade' }),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => learningChunks.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.fileId, table.chunkId] }) })
);

export const learningFileSummaries = sqliteTable(
  'learning_file_summaries',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => learningFileIndex.id, { onDelete: 'cascade' }),
    summaryId: text('summary_id')
      .notNull()
      .references(() => summaries.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.fileId, table.summaryId] }) })
);

export const learningCodeExtracts = sqliteTable('learning_code_extracts', {
  id: text('id').primaryKey(),
  chunkId: text('chunk_id')
    .notNull()
    .references(() => learningChunks.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull().default(''),
  language: text('language').notNull().default(''),
  symbolsJson: text('symbols_json').notNull().default('[]'),
  code: text('code').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  deletedAt: text('deleted_at'),
});

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  color: text('color'),
});

export const chunkCategories = sqliteTable(
  'chunk_categories',
  {
    chunkId: text('chunk_id')
      .notNull()
      .references(() => learningChunks.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    assignedBy: text('assigned_by').notNull().default('auto'),
    confidence: real('confidence').default(1.0),
  },
  (table) => ({ pk: primaryKey({ columns: [table.chunkId, table.categoryId] }) })
);

export const chunkEmbeddings = sqliteTable('chunk_embeddings', {
  id: text('id').primaryKey(),
  chunkId: text('chunk_id')
    .notNull()
    .unique()
    .references(() => learningChunks.id, { onDelete: 'cascade' }),
  vector: blob('vector').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const contextSelections = sqliteTable('context_selections', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  requestId: text('request_id').notNull(),
  selectedChunkIds: text('selected_chunk_ids').notNull().default('[]'),
  selectedSummaryIds: text('selected_summary_ids').notNull().default('[]'),
  totalTokensInjected: integer('total_tokens_injected').default(0),
  selectionMethod: text('selection_method').notNull().default('keyword'),
  selectionLatencyMs: integer('selection_latency_ms').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const analysisFindings = sqliteTable('analysis_findings', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  severity: text('severity').notNull().default('info'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  relatedIds: text('related_ids').notNull().default('{"chunkIds":[],"summaryIds":[],"findingIds":[]}'),
  actions: text('actions').notNull().default('[]'),
  status: text('status').notNull().default('open'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  actionsAppliedAt: integer('actions_applied_at', { mode: 'timestamp' }),
});

export const providerConfigs = sqliteTable('provider_configs', {
  id: text('id').primaryKey(),
  /** User-friendly name, e.g. "OpenAI Production", "Local Ollama" */
  name: text('name').notNull(),
  /** Adapter type: 'openai' = OpenAI-compatible, 'anthropic' = Anthropic Messages API */
  type: text('type').notNull().default('openai'),
  /** Full base URL including path, e.g. https://api.openai.com/v1 */
  baseUrl: text('base_url').notNull(),
  /** API key stored at rest — acceptable for local/self-hosted use */
  apiKey: text('api_key').notNull(),
  /** Optional short provider code used to scope model IDs, e.g. OAI or ANTH. */
  shortPrefix: text('short_prefix'),
  /** Comma-separated model IDs, e.g. "gpt-4o,gpt-4o-mini,o1". First is used for connection tests. */
  models: text('models').notNull().default(''),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
  /** One default per type; used when routing requests of that type */
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  /** If created by an external provider, reference back to it for sync management */
  externalProviderId: text('external_provider_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const externalProviders = sqliteTable('external_providers', {
  id: text('id').primaryKey(),
  /** User-visible name, e.g. "opencode Go" */
  name: text('name').notNull(),
  /** Key linking to the definition in the registry, e.g. "opencode-go" */
  providerKey: text('provider_key').notNull().unique(),
  /** User-provided API key for the external service */
  apiKey: text('api_key').notNull(),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
  /** Last time models were synced from the external API */
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  /** Status of the most recent sync: 'success', 'error', or null for never synced */
  syncStatus: text('sync_status'),
  /** Error message from the most recent failed sync */
  syncError: text('sync_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Per-model metadata sourced from a provider's /models endpoint.
 *
 * Providers increasingly report a real context window (and a display name and
 * wire format) per model. Storing that here lets the token-budget calculation
 * use the upstream value instead of the conservative built-in guess in
 * `context/budget.ts`.
 *
 * Rows are keyed by the pair (provider, model ID), where the model ID is the
 * same un-prefixed value stored in `provider_configs.models`.
 */
export const providerModelMetadata = sqliteTable(
  'provider_model_metadata',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providerConfigs.id, { onDelete: 'cascade' }),
    /** Raw model ID as returned upstream, without the provider short prefix. */
    modelId: text('model_id').notNull(),
    /** Context window reported by the provider, in tokens. */
    contextLength: integer('context_length'),
    /** Human-readable model name reported by the provider. */
    displayName: text('display_name'),
    /** Wire protocol the provider advertises for this model. */
    apiFormat: text('api_format'),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.providerId, table.modelId] }),
  })
);

/**
 * Per-model overrides written from the management UI's Models dialog.
 *
 * Kept separate from `provider_model_metadata` so a provider sync can replace
 * its reported values wholesale without ever discarding a user's edit. When a
 * model has both rows the override wins field-by-field; unspecified override
 * fields stay `null` so the reported value (or the built-in default) applies.
 *
 * Rows are keyed by the pair (provider, model ID), matching
 * `provider_configs.models` and `provider_model_metadata`.
 */
export const providerModelOverrides = sqliteTable(
  'provider_model_overrides',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providerConfigs.id, { onDelete: 'cascade' }),
    /** Raw model ID, without the provider short prefix. */
    modelId: text('model_id').notNull(),
    /** User-facing model name shown in pickers. */
    displayName: text('display_name'),
    /** Maximum context window in tokens. */
    contextLength: integer('context_length'),
    /** Wire protocol the model actually speaks. */
    apiFormat: text('api_format'),
    /** Whether the model accepts reasoning-effort levels. */
    supportsReasoning: integer('supports_reasoning', { mode: 'boolean' }),
    /** Whether the model can process image inputs itself. Off by default. */
    supportsVision: integer('supports_vision', { mode: 'boolean' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.providerId, table.modelId] }),
  })
);

/**
 * Reference catalog of well-known models, synced from a public model list
 * (OpenRouter) and used as a *default source* for values a provider does not
 * report itself — context window, vision support and reasoning support.
 *
 * Kept separate from `provider_model_metadata` (provider-reported) and
 * `provider_model_overrides` (user-authored) so the three sources stay
 * independently refreshable. Resolution order is always:
 *   user override > provider-reported > reference > built-in heuristic
 *
 * Rows are keyed by the normalized upstream model ID (`vendor/model`, lower
 * case, without variant suffixes such as `:free`).
 */
export const modelReference = sqliteTable(
  'model_reference',
  {
    /** Catalog the row came from, e.g. `openrouter`. */
    source: text('source').notNull(),
    /** Normalized model ID used as the lookup key. */
    modelId: text('model_id').notNull(),
    /** Vendor / publisher, e.g. `deepseek`. */
    vendor: text('vendor'),
    /** Human-readable name reported by the catalog. */
    displayName: text('display_name'),
    /** Maximum context window in tokens. */
    contextLength: integer('context_length'),
    /** Provider ceiling for a single response, in tokens. */
    maxOutputTokens: integer('max_output_tokens'),
    /** Whether the catalog lists image as an input modality. */
    supportsVision: integer('supports_vision', { mode: 'boolean' }),
    /** Whether the catalog advertises reasoning-effort parameters. */
    supportsReasoning: integer('supports_reasoning', { mode: 'boolean' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source, table.modelId] }),
    idxModelReferenceModel: index('idx_model_reference_model').on(table.modelId),
  })
);

/** Parse a provider's comma-separated models field into an array of trimmed non-empty strings. */
export function parseModels(provider: ProviderConfig): string[] {
  return (provider.models || '')
    .split(',')
    .map((m: string) => m.trim())
    .filter((m: string) => m.length > 0);
}

/** Key-value config table for global system settings (model selections etc). */
export const systemConfig = sqliteTable('system_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
});

// ── Stats ─────────────────────────────────────────────────────────────────
// Verbose telemetry table gated behind IC_STATS_ENABLED env var.
// Each row is either an input (prompt) or output (response) for a
// background or proxy operation.  Input/output pairs share a run_id.
export const stats = sqliteTable('stats', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'),
  requestId: text('request_id'),
  model: text('model').notNull().default(''),
  runId: text('run_id').notNull(),
  type: text('type').notNull(),
  direction: text('direction').notNull(),
  meta: text('meta').notNull().default('{}'),
  tokens: integer('tokens').notNull().default(0),
  body: text('body').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// ── Proxy Errors ───────────────────────────────────────────────────────────
// Logs upstream errors (HTTP >=400 or connection exceptions) for diagnostics.
// Unlike stats, this is always-on — no env-var gate.
export const proxyErrors = sqliteTable('proxy_errors', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'),
  requestId: text('request_id'),
  model: text('model').notNull().default(''),
  providerName: text('provider_name').notNull().default(''),
  providerType: text('provider_type').notNull().default(''),
  url: text('url').notNull().default(''),
  statusCode: integer('status_code'),
  errorMessage: text('error_message').notNull().default(''),
  errorType: text('error_type').notNull().default('http_error'),
  requestHeaders: text('request_headers').notNull().default('{}'),
  requestBody: text('request_body').notNull().default(''),
  responseHeaders: text('response_headers').notNull().default('{}'),
  responseBody: text('response_body').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const backgroundTaskRuns = sqliteTable('background_task_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  taskType: text('task_type').notNull(),
  model: text('model').notNull().default(''),
  providerName: text('provider_name').notNull().default(''),
  providerType: text('provider_type').notNull().default(''),
  status: text('status').notNull(),
  summary: text('summary').notNull().default(''),
  errorMessage: text('error_message').notNull().default(''),
  willNotifyUser: integer('will_notify_user', { mode: 'boolean' }).notNull().default(false),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }).notNull(),
});

export type ProviderConfig = typeof providerConfigs.$inferSelect;
export type NewProviderConfig = typeof providerConfigs.$inferInsert;
export type ProviderModelMetadataRow = typeof providerModelMetadata.$inferSelect;
export type NewProviderModelMetadataRow = typeof providerModelMetadata.$inferInsert;
export type ProviderModelOverrideRow = typeof providerModelOverrides.$inferSelect;
export type NewProviderModelOverrideRow = typeof providerModelOverrides.$inferInsert;
export type ModelReferenceRow = typeof modelReference.$inferSelect;
export type NewModelReferenceRow = typeof modelReference.$inferInsert;
export type ExternalProvider = typeof externalProviders.$inferSelect;
export type NewExternalProvider = typeof externalProviders.$inferInsert;
export type StatEntry = typeof stats.$inferSelect;
export type NewStatEntry = typeof stats.$inferInsert;
export type ProxyErrorEntry = typeof proxyErrors.$inferSelect;
export type NewProxyErrorEntry = typeof proxyErrors.$inferInsert;
export type BackgroundTaskRunEntry = typeof backgroundTaskRuns.$inferSelect;
export type NewBackgroundTaskRunEntry = typeof backgroundTaskRuns.$inferInsert;

export type Project = typeof projects.$inferSelect & {
  analyzerLastRun?: string | null;
  summarizationLastRun?: string | null;
};
export type NewProject = typeof projects.$inferInsert & {
  analyzerLastRun?: string | null;
  summarizationLastRun?: string | null;
};
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserApiKey = typeof userApiKeys.$inferSelect;
export type NewUserApiKey = typeof userApiKeys.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
export type LearningChunk = typeof learningChunks.$inferSelect;
export type NewLearningChunk = typeof learningChunks.$inferInsert;
export type Summary = typeof summaries.$inferSelect;
export type NewSummary = typeof summaries.$inferInsert;
export type LearningFile = typeof learningFiles.$inferSelect;
export type NewLearningFile = typeof learningFiles.$inferInsert;
export type LearningFileIndex = typeof learningFileIndex.$inferSelect;
export type NewLearningFileIndex = typeof learningFileIndex.$inferInsert;
export type LearningFileChunk = typeof learningFileChunks.$inferSelect;
export type NewLearningFileChunk = typeof learningFileChunks.$inferInsert;
export type LearningFileSummary = typeof learningFileSummaries.$inferSelect;
export type NewLearningFileSummary = typeof learningFileSummaries.$inferInsert;
export type LearningCodeExtract = typeof learningCodeExtracts.$inferSelect;
export type NewLearningCodeExtract = typeof learningCodeExtracts.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type ChunkEmbedding = typeof chunkEmbeddings.$inferSelect;
export type NewChunkEmbedding = typeof chunkEmbeddings.$inferInsert;
export type ContextSelection = typeof contextSelections.$inferSelect;
export type NewContextSelection = typeof contextSelections.$inferInsert;
export type AnalysisFinding = typeof analysisFindings.$inferSelect;
export type NewAnalysisFinding = typeof analysisFindings.$inferInsert;

export function parseAllowedModels(user: { allowedModels: string | null }): string[] {
  try {
    const parsed = JSON.parse(user.allowedModels || '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}
