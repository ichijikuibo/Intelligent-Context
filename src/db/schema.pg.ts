import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  customType,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom bytea<->Float32Array column type (mirrors SQLite BLOB for vectors).
// Postgres bytea stores raw bytes; we serialise/deserialise Float32Array the
// same way the SQLite path does via Buffer.
// ---------------------------------------------------------------------------
const float32ArrayType = customType<{
  data: Buffer;
  driverData: Buffer;
}>({
  dataType() {
    return 'bytea';
  },
  toDriver(val: Buffer): Buffer {
    return val;
  },
  fromDriver(val: Buffer): Buffer {
    return val;
  },
});

// ---------------------------------------------------------------------------
// Tables — names and columns must match the SQLite schema exactly so that
// repositories work with either dialect.
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull().unique(),
    pathPattern: text('path_pattern'),
    isDefault: boolean('is_default').notNull().default(false),
    settings: text('settings').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    analyzerLastRun: text('analyzer_last_run'),
    summarizationLastRun: text('summarization_last_run'),
  },
);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  isApproved: boolean('is_approved').notNull().default(false),
  isDisabled: boolean('is_disabled').notNull().default(false),
  accessAllProjects: boolean('access_all_projects').notNull().default(false),
  accessAllModels: boolean('access_all_models').notNull().default(false),
  allowedModels: text('allowed_models').notNull().default('[]'),
  /** Voluntary visibility preference: models to keep out of the IDE picker. */
  hiddenModels: text('hidden_models').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const userApiKeys = pgTable(
  'user_api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull().unique(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    idxUserApiKeysUser: index('idx_user_api_keys_user').on(table.userId),
  }),
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.userId] }),
    idxProjectMembersUser: index('idx_project_members_user').on(table.userId),
  }),
);

export const learningChunks = pgTable(
  'learning_chunks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    requestId: text('request_id'),
    fact: text('fact').notNull(),
    category: text('category').notNull().default('general'),
    confidence: doublePrecision('confidence').notNull().default(0),
    source: text('source').notNull().default('extraction'),
    hash: text('hash').notNull(),
    tokensUsed: integer('tokens_used').default(0),
    summarized: boolean('summarized').notNull().default(false),
    createdAt: text('created_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => ({
    idxChunksProject: index('idx_chunks_project').on(table.projectId),
    idxChunksHash: index('idx_chunks_hash').on(table.projectId, table.hash),
    idxChunksUnsummarized: index('idx_chunks_unsummarized').on(table.projectId, table.summarized),
  }),
);

export const summaries = pgTable(
  'summaries',
  {
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
  },
  (table) => ({
    idxSummariesProject: index('idx_summaries_project').on(table.projectId),
  }),
);

export const learningFiles = pgTable(
  'learning_files',
  {
    id: text('id').primaryKey(),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => learningChunks.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    purpose: text('purpose').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => ({
    idxFilesChunk: index('idx_files_chunk').on(table.chunkId),
  }),
);

export const learningFileIndex = pgTable(
  'learning_file_index',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    normalizedFileName: text('normalized_file_name').notNull(),
    summary: text('summary').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => ({
    idxLearningFileIndexProject: index('idx_learning_file_index_project').on(table.projectId),
    idxLearningFileIndexProjectPath: uniqueIndex('idx_learning_file_index_project_path').on(table.projectId, table.normalizedFileName),
  }),
);

export const learningFileChunks = pgTable(
  'learning_file_chunks',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => learningFileIndex.id, { onDelete: 'cascade' }),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => learningChunks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fileId, table.chunkId] }),
    idxLearningFileChunksChunk: index('idx_learning_file_chunks_chunk').on(table.chunkId),
  }),
);

export const learningFileSummaries = pgTable(
  'learning_file_summaries',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => learningFileIndex.id, { onDelete: 'cascade' }),
    summaryId: text('summary_id')
      .notNull()
      .references(() => summaries.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fileId, table.summaryId] }),
    idxLearningFileSummariesSummary: index('idx_learning_file_summaries_summary').on(table.summaryId),
  }),
);

export const learningCodeExtracts = pgTable(
  'learning_code_extracts',
  {
    id: text('id').primaryKey(),
    chunkId: text('chunk_id')
      .notNull()
      .references(() => learningChunks.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull().default(''),
    language: text('language').notNull().default(''),
    symbolsJson: text('symbols_json').notNull().default('[]'),
    code: text('code').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => ({
    idxCodeExtractsChunk: index('idx_code_extracts_chunk').on(table.chunkId),
  }),
);

export const categories = pgTable('categories', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  color: text('color'),
});

export const chunkCategories = pgTable(
  'chunk_categories',
  {
    chunkId: text('chunk_id')
      .notNull()
      .references(() => learningChunks.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    assignedBy: text('assigned_by').notNull().default('auto'),
    confidence: doublePrecision('confidence').default(1.0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chunkId, table.categoryId] }),
  }),
);

export const chunkEmbeddings = pgTable('chunk_embeddings', {
  id: text('id').primaryKey(),
  chunkId: text('chunk_id')
    .notNull()
    .unique()
    .references(() => learningChunks.id, { onDelete: 'cascade' }),
  vector: float32ArrayType('vector').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const contextSelections = pgTable(
  'context_selections',
  {
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    idxSelectionsProject: index('idx_selections_project').on(table.projectId),
  }),
);

export const analysisFindings = pgTable(
  'analysis_findings',
  {
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    actionsAppliedAt: timestamp('actions_applied_at', { withTimezone: true }),
  },
  (table) => ({
    idxFindingsProject: index('idx_findings_project').on(table.projectId),
  }),
);

export const providerConfigs = pgTable(
  'provider_configs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().default('openai'),
    baseUrl: text('base_url').notNull(),
    apiKey: text('api_key').notNull(),
    shortPrefix: text('short_prefix'),
    models: text('models').notNull().default(''),
    isEnabled: boolean('is_enabled').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    externalProviderId: text('external_provider_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    idxProvidersType: index('idx_providers_type').on(table.type, table.isEnabled),
    idxProvidersExternal: index('idx_providers_external').on(table.externalProviderId),
  }),
);

export const externalProviders = pgTable(
  'external_providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    providerKey: text('provider_key').notNull().unique(),
    apiKey: text('api_key').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    syncStatus: text('sync_status'),
    syncError: text('sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    idxExternalProvidersKey: index('idx_external_providers_key').on(table.providerKey),
  }),
);

/**
 * Per-model metadata sourced from a provider's /models endpoint.
 * Mirrors the SQLite schema so the repository layer sees one logical shape.
 */
export const providerModelMetadata = pgTable(
  'provider_model_metadata',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providerConfigs.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    contextLength: integer('context_length'),
    displayName: text('display_name'),
    apiFormat: text('api_format'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.providerId, table.modelId] }),
  }),
);

/**
 * Per-model overrides written from the management UI's Models dialog.
 * Mirrors the SQLite schema so the repository layer sees one logical shape.
 */
export const providerModelOverrides = pgTable(
  'provider_model_overrides',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providerConfigs.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name'),
    contextLength: integer('context_length'),
    apiFormat: text('api_format'),
    supportsReasoning: boolean('supports_reasoning'),
    supportsVision: boolean('supports_vision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.providerId, table.modelId] }),
  }),
);

export const systemConfig = pgTable('system_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
});

/**
 * Reference catalog of well-known models, synced from a public model list
 * (OpenRouter). Mirrors the SQLite schema so the repository layer sees one
 * logical shape.
 */
export const modelReference = pgTable(
  'model_reference',
  {
    source: text('source').notNull(),
    modelId: text('model_id').notNull(),
    vendor: text('vendor'),
    displayName: text('display_name'),
    contextLength: integer('context_length'),
    maxOutputTokens: integer('max_output_tokens'),
    supportsVision: boolean('supports_vision'),
    supportsReasoning: boolean('supports_reasoning'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source, table.modelId] }),
    idxModelReferenceModel: index('idx_model_reference_model').on(table.modelId),
  }),
);

// ── Stats ─────────────────────────────────────────────────────────────────
// Verbose telemetry table gated behind IC_STATS_ENABLED env var.
// Each row is either an input (prompt) or output (response) for a
// background or proxy operation.  Input/output pairs share a run_id.
export const stats = pgTable('stats', {
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
  meta: jsonb('meta').notNull().default({}),
  tokens: integer('tokens').notNull().default(0),
  body: text('body').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// ── Proxy Errors ───────────────────────────────────────────────────────────
// Logs upstream errors (HTTP >=400 or connection exceptions) for diagnostics.
// Unlike stats, this is always-on — no env-var gate.
export const proxyErrors = pgTable('proxy_errors', {
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// ── Background Task Runs ──────────────────────────────────────────────────
// Logs every background task execution (analyzer, summarizer, learning extraction).
// status is 'success', 'error', or 'skipped'. willNotifyUser is true when an error occurs.
export const backgroundTaskRuns = pgTable('background_task_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  taskType: text('task_type').notNull(),
  model: text('model').notNull().default(''),
  providerName: text('provider_name').notNull().default(''),
  providerType: text('provider_type').notNull().default(''),
  status: text('status').notNull(),
  summary: text('summary').notNull().default(''),
  errorMessage: text('error_message').notNull().default(''),
  willNotifyUser: boolean('will_notify_user').notNull().default(false),
  read: boolean('read').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// Helpers (mirror the SQLite schema exports)
// ---------------------------------------------------------------------------

/** Parse a provider's comma-separated models field into an array of trimmed non-empty strings. */
export function parseModels(provider: { models: string | null }): string[] {
  return (provider.models || '')
    .split(',')
    .map((m: string) => m.trim())
    .filter((m: string) => m.length > 0);
}

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

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
export type Summary = typeof summaries.$inferSelect;
export type NewSummary = typeof summaries.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type ChunkEmbedding = typeof chunkEmbeddings.$inferSelect;
export type NewChunkEmbedding = typeof chunkEmbeddings.$inferInsert;
export type ContextSelection = typeof contextSelections.$inferSelect;
export type NewContextSelection = typeof contextSelections.$inferInsert;
export type AnalysisFinding = typeof analysisFindings.$inferSelect;
export type NewAnalysisFinding = typeof analysisFindings.$inferInsert;
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

export function parseAllowedModels(user: { allowedModels: string | null }): string[] {
  try {
    const parsed = JSON.parse(user.allowedModels || '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}
