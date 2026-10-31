import { getRawDb, getPgPool, getDialect, markDirty, saveDatabase, db } from './connection';
import { logger } from '../utils/logger';
import { filesRepo } from './repositories/files';

// ── SQLite Migrations ──────────────────────────────────────────────────────

const SQLITE_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        settings TEXT NOT NULL DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        analyzer_last_run TEXT,
        summarization_last_run TEXT
      );

      CREATE TABLE IF NOT EXISTS learning_chunks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT,
        request_id TEXT,
        fact TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'extraction',
        hash TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        summarized INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_project ON learning_chunks(project_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON learning_chunks(project_id, hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_unsummarized ON learning_chunks(project_id, summarized);

      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_chunk_ids TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project_id);

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS chunk_categories (
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        assigned_by TEXT NOT NULL DEFAULT 'auto',
        confidence REAL DEFAULT 1.0,
        PRIMARY KEY (chunk_id, category_id)
      );

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL UNIQUE REFERENCES learning_chunks(id) ON DELETE CASCADE,
        vector BLOB NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_selections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        selected_chunk_ids TEXT NOT NULL DEFAULT '[]',
        selected_summary_ids TEXT NOT NULL DEFAULT '[]',
        total_tokens_injected INTEGER DEFAULT 0,
        selection_method TEXT NOT NULL DEFAULT 'keyword',
        selection_latency_ms INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_selections_project ON context_selections(project_id);

      CREATE TABLE IF NOT EXISTS analysis_findings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        related_ids TEXT NOT NULL DEFAULT '{"chunkIds":[],"summaryIds":[],"findingIds":[]}',
        actions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        actions_applied_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_findings_project ON analysis_findings(project_id);

      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `,
  },
  {
    name: '002_provider_configs',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        short_prefix TEXT,
        models TEXT NOT NULL DEFAULT '',
        is_enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_providers_type ON provider_configs(type, is_enabled);
    `,
  },
  {
    name: '003_provider_models_column',
    sql: `
      ALTER TABLE provider_configs ADD COLUMN models TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    name: '004_system_config',
    sql: `
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `,
  },
  {
    name: '004b_stats_table',
    sql: `
      CREATE TABLE IF NOT EXISTS stats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        model TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        tokens INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_stats_project_created ON stats(project_id, created_at);
    `,
  },
  {
    name: '005_learning_files_and_summary_fields',
    sql: `
      CREATE TABLE IF NOT EXISTS learning_files (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_files_chunk ON learning_files(chunk_id);

      ALTER TABLE summaries ADD COLUMN one_line_summary TEXT NOT NULL DEFAULT '';
      ALTER TABLE summaries ADD COLUMN categories_list TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    name: '006_project_path_pattern',
    sql: `
      ALTER TABLE projects ADD COLUMN path_pattern TEXT;
    `,
  },
  {
    name: '007_date_format_text',
    sql: `
      -- Convert learning_chunks created_at from integer (seconds or ms) to text yyyy-MM-dd.
      -- Drizzle timestamp mode stores seconds; manually-inserted values may be ms.
      -- Detect format: values > 1e12 are milliseconds (post-2001), else seconds.
      UPDATE learning_chunks
        SET created_at = strftime('%Y-%m-%d',
          CASE WHEN CAST(created_at AS INTEGER) > 1000000000000
            THEN CAST(CAST(created_at AS INTEGER) / 1000 AS INTEGER)
            ELSE CAST(created_at AS INTEGER)
          END,
          'unixepoch')
        WHERE typeof(created_at) = 'integer';

      -- Convert summaries created_at from integer to text
      UPDATE summaries
        SET created_at = strftime('%Y-%m-%d',
          CASE WHEN CAST(created_at AS INTEGER) > 1000000000000
            THEN CAST(CAST(created_at AS INTEGER) / 1000 AS INTEGER)
            ELSE CAST(created_at AS INTEGER)
          END,
          'unixepoch')
        WHERE typeof(created_at) = 'integer';

      -- Convert summaries updated_at from integer to text
      UPDATE summaries
        SET updated_at = strftime('%Y-%m-%d',
          CASE WHEN CAST(updated_at AS INTEGER) > 1000000000000
            THEN CAST(CAST(updated_at AS INTEGER) / 1000 AS INTEGER)
            ELSE CAST(updated_at AS INTEGER)
          END,
          'unixepoch')
        WHERE typeof(updated_at) = 'integer';
    `,
  },
  {
    name: '008_fix_broken_dates',
    sql: `
      -- If migration 007 was previously applied with the wrong formula
      -- (divided seconds by 1000, producing dates in Jan 1970), recover
      -- the original dates by detecting text dates before 2020 and
      -- multiplying the corrupted value back by 1000.
      UPDATE learning_chunks
        SET created_at = strftime('%Y-%m-%d',
          CAST(strftime('%s', created_at || 'T00:00:00') AS INTEGER) * 1000,
          'unixepoch')
        WHERE typeof(created_at) = 'text'
          AND created_at < '2020-01-01';

      UPDATE summaries
        SET created_at = strftime('%Y-%m-%d',
          CAST(strftime('%s', created_at || 'T00:00:00') AS INTEGER) * 1000,
          'unixepoch')
        WHERE typeof(created_at) = 'text'
          AND created_at < '2020-01-01';

      UPDATE summaries
        SET updated_at = strftime('%Y-%m-%d',
          CAST(strftime('%s', updated_at || 'T00:00:00') AS INTEGER) * 1000,
          'unixepoch')
        WHERE typeof(updated_at) = 'text'
          AND updated_at < '2020-01-01';
    `,
  },
  {
    name: '009_project_default_flag',
    sql: `
      ALTER TABLE projects ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '010_seed_default_project',
    sql: `
      UPDATE projects
        SET is_default = 1
        WHERE root_path = 'default';

      INSERT OR IGNORE INTO projects (
        id,
        name,
        root_path,
        path_pattern,
        is_default,
        settings,
        created_at,
        updated_at
      ) VALUES (
        'default-project',
        'Default Project',
        'default',
        NULL,
        1,
        '{}',
        CAST(strftime('%s', 'now') AS INTEGER),
        CAST(strftime('%s', 'now') AS INTEGER)
      );
    `,
  },
  {
    name: '012_analyzer_and_summarizer_timestamps',
    sql: `
      ALTER TABLE projects ADD COLUMN analyzer_last_run TEXT;
      ALTER TABLE projects ADD COLUMN summarization_last_run TEXT;
    `,
  },
  {
    name: '011_soft_delete_and_finding_actions',
    sql: `
      ALTER TABLE learning_chunks ADD COLUMN deleted_at TEXT;
      ALTER TABLE summaries ADD COLUMN deleted_at TEXT;
      ALTER TABLE learning_files ADD COLUMN deleted_at TEXT;
      ALTER TABLE analysis_findings ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE analysis_findings ADD COLUMN actions_applied_at INTEGER;
    `,
  },
  {
    name: '012_project_last_run_timestamps',
    sql: `
      ALTER TABLE projects ADD COLUMN summarization_last_run INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN analyzer_last_run INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '013_multi_user_auth',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        is_approved INTEGER NOT NULL DEFAULT 0,
        is_disabled INTEGER NOT NULL DEFAULT 0,
        access_all_projects INTEGER NOT NULL DEFAULT 0,
        access_all_models INTEGER NOT NULL DEFAULT 0,
        allowed_models TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS user_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id);

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

      ALTER TABLE context_selections ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_selections_user ON context_selections(user_id);
    `,
  },
  {
    name: '014_stats_table',
    sql: `
      CREATE TABLE IF NOT EXISTS stats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        model TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        tokens INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_stats_project_created ON stats(project_id, created_at);
    `,
  },
  {
    name: '016_stats_session_request',
    sql: `
      ALTER TABLE stats ADD COLUMN session_id TEXT;
      ALTER TABLE stats ADD COLUMN request_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_stats_session ON stats(project_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_stats_request ON stats(project_id, request_id);
    `,
  },
  {
    name: '017_learning_code_extracts',
    sql: `
      CREATE TABLE IF NOT EXISTS learning_code_extracts (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        symbols_json TEXT NOT NULL DEFAULT '[]',
        code TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_code_extracts_chunk ON learning_code_extracts(chunk_id);
    `,
  },
  {
    name: '018_summaries_toc',
    sql: `
      ALTER TABLE summaries ADD COLUMN toc TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    name: '019_provider_short_prefix',
    sql: `
      ALTER TABLE provider_configs ADD COLUMN short_prefix TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_short_prefix_unique ON provider_configs(short_prefix) WHERE short_prefix IS NOT NULL;
    `,
  },
  {
    name: '020_rename_related_chunk_ids_to_related_ids',
    sql: `
      ALTER TABLE analysis_findings RENAME COLUMN related_chunk_ids TO related_ids;
      UPDATE analysis_findings SET related_ids = '{"chunkIds":[],"summaryIds":[],"findingIds":[]}';
    `,
  },
  {
    name: '021_external_providers',
    sql: `
      CREATE TABLE IF NOT EXISTS external_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_key TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at INTEGER,
        sync_status TEXT,
        sync_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_external_providers_key ON external_providers(provider_key);

      ALTER TABLE provider_configs ADD COLUMN external_provider_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_providers_external ON provider_configs(external_provider_id);
    `,
  },
  {
    name: '022_proxy_errors',
    sql: `
      CREATE TABLE IF NOT EXISTS proxy_errors (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT,
        request_id TEXT,
        model TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        provider_type TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        status_code INTEGER,
        error_message TEXT NOT NULL DEFAULT '',
        error_type TEXT NOT NULL DEFAULT 'http_error',
        request_headers TEXT NOT NULL DEFAULT '{}',
        request_body TEXT NOT NULL DEFAULT '',
        response_headers TEXT NOT NULL DEFAULT '{}',
        response_body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proxy_errors_project_created ON proxy_errors(project_id, created_at);
    `,
  },
  {
    name: '023_background_task_runs',
    sql: `
      CREATE TABLE IF NOT EXISTS background_task_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        provider_type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        will_notify_user INTEGER NOT NULL DEFAULT 0,
        read INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_background_task_runs_project ON background_task_runs(project_id, completed_at DESC);
    `,
  },
  {
    name: '024_learning_file_index',
    sql: `
      CREATE TABLE IF NOT EXISTS learning_file_index (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        normalized_file_name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_file_index_project_path
        ON learning_file_index(project_id, normalized_file_name);
      CREATE INDEX IF NOT EXISTS idx_learning_file_index_project
        ON learning_file_index(project_id);

      CREATE TABLE IF NOT EXISTS learning_file_chunks (
        file_id TEXT NOT NULL REFERENCES learning_file_index(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (file_id, chunk_id)
      );

      CREATE INDEX IF NOT EXISTS idx_learning_file_chunks_chunk
        ON learning_file_chunks(chunk_id);

      CREATE TABLE IF NOT EXISTS learning_file_summaries (
        file_id TEXT NOT NULL REFERENCES learning_file_index(id) ON DELETE CASCADE,
        summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (file_id, summary_id)
      );

      CREATE INDEX IF NOT EXISTS idx_learning_file_summaries_summary
        ON learning_file_summaries(summary_id);
    `,
  },
  {
    name: '025_provider_model_metadata',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_model_metadata (
        provider_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        context_length INTEGER,
        display_name TEXT,
        api_format TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_model_metadata_provider
        ON provider_model_metadata(provider_id);
    `,
  },
  {
    name: '026_provider_model_overrides',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_model_overrides (
        provider_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        display_name TEXT,
        context_length INTEGER,
        api_format TEXT,
        supports_reasoning INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_model_overrides_provider
        ON provider_model_overrides(provider_id);
    `,
  },
  {
    name: '027_model_vision_support',
    sql: `
      ALTER TABLE provider_model_overrides ADD COLUMN supports_vision INTEGER;
    `,
  },
  {
    name: '028_model_reference',
    sql: `
      CREATE TABLE IF NOT EXISTS model_reference (
        source TEXT NOT NULL,
        model_id TEXT NOT NULL,
        vendor TEXT,
        display_name TEXT,
        context_length INTEGER,
        max_output_tokens INTEGER,
        supports_vision INTEGER,
        supports_reasoning INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_model_reference_model
        ON model_reference(model_id);
    `,
  },
  {
    name: '029_user_hidden_models',
    sql: `
      ALTER TABLE users ADD COLUMN hidden_models TEXT NOT NULL DEFAULT '[]';
    `,
  }
];

// ── PostgreSQL Migrations ──────────────────────────────────────────────────
// PG databases start fresh — one initial migration creates the full schema.
// Uses IF NOT EXISTS so it's safe to run repeatedly.

const PG_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '001_initial_pg_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        path_pattern TEXT,
        is_default BOOLEAN NOT NULL DEFAULT false,
        settings TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        analyzer_last_run TEXT,
        summarization_last_run TEXT
      );

      CREATE TABLE IF NOT EXISTS learning_chunks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT,
        request_id TEXT,
        fact TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'extraction',
        hash TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        summarized BOOLEAN NOT NULL DEFAULT false,
        created_at TEXT NOT NULL DEFAULT '',
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_project ON learning_chunks(project_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON learning_chunks(project_id, hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_unsummarized ON learning_chunks(project_id, summarized);

      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        one_line_summary TEXT NOT NULL DEFAULT '',
        categories_list TEXT NOT NULL DEFAULT '[]',
        source_chunk_ids TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project_id);

      CREATE TABLE IF NOT EXISTS learning_files (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_chunk ON learning_files(chunk_id);

      CREATE TABLE IF NOT EXISTS learning_code_extracts (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        symbols_json TEXT NOT NULL DEFAULT '[]',
        code TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_code_extracts_chunk ON learning_code_extracts(chunk_id);

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS chunk_categories (
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        assigned_by TEXT NOT NULL DEFAULT 'auto',
        confidence DOUBLE PRECISION DEFAULT 1.0,
        PRIMARY KEY (chunk_id, category_id)
      );

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL UNIQUE REFERENCES learning_chunks(id) ON DELETE CASCADE,
        vector BYTEA NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS context_selections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        selected_chunk_ids TEXT NOT NULL DEFAULT '[]',
        selected_summary_ids TEXT NOT NULL DEFAULT '[]',
        total_tokens_injected INTEGER DEFAULT 0,
        selection_method TEXT NOT NULL DEFAULT 'keyword',
        selection_latency_ms INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_selections_project ON context_selections(project_id);

      CREATE TABLE IF NOT EXISTS analysis_findings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        related_ids TEXT NOT NULL DEFAULT '{"chunkIds":[],"summaryIds":[],"findingIds":[]}',
        actions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        actions_applied_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_findings_project ON analysis_findings(project_id);

      CREATE TABLE IF NOT EXISTS provider_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        short_prefix TEXT,
        models TEXT NOT NULL DEFAULT '',
        is_enabled BOOLEAN NOT NULL DEFAULT true,
        is_default BOOLEAN NOT NULL DEFAULT false,
        external_provider_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_providers_type ON provider_configs(type, is_enabled);
      CREATE INDEX IF NOT EXISTS idx_providers_external ON provider_configs(external_provider_id);

      CREATE TABLE IF NOT EXISTS external_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_key TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT true,
        last_sync_at TIMESTAMPTZ,
        sync_status TEXT,
        sync_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_external_providers_key ON external_providers(provider_key);

      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS stats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        model TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        tokens INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_stats_project_created ON stats(project_id, created_at);

      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
    `,
  },
  {
    name: '002_project_default_flag',
    sql: `
      ALTER TABLE projects ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
    `,
  },
  {
    name: '003_seed_default_project',
    sql: `
      UPDATE projects
        SET is_default = true
        WHERE root_path = 'default';

      INSERT INTO projects (
        id,
        name,
        root_path,
        path_pattern,
        is_default,
        settings,
        created_at,
        updated_at
      ) VALUES (
        'default-project',
        'Default Project',
        'default',
        NULL,
        true,
        '{}',
        NOW(),
        NOW()
      )
      ON CONFLICT (root_path) DO UPDATE
        SET is_default = true,
            updated_at = NOW();
    `,
  },
  {
    name: '005_analyzer_and_summarizer_timestamps',
    sql: `
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS analyzer_last_run TEXT;
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS summarization_last_run TEXT;
    `,
  },
  {
    name: '004_soft_delete_and_finding_actions',
    sql: `
      ALTER TABLE learning_chunks ADD COLUMN IF NOT EXISTS deleted_at TEXT;
      ALTER TABLE summaries ADD COLUMN IF NOT EXISTS deleted_at TEXT;
      ALTER TABLE learning_files ADD COLUMN IF NOT EXISTS deleted_at TEXT;
      ALTER TABLE analysis_findings ADD COLUMN IF NOT EXISTS actions TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE analysis_findings ADD COLUMN IF NOT EXISTS actions_applied_at TIMESTAMPTZ;
    `,
  },
  {
    name: '005_project_last_run_timestamps',
    sql: `
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS summarization_last_run BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS analyzer_last_run BIGINT NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '006_multi_user_auth',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        is_approved BOOLEAN NOT NULL DEFAULT false,
        is_disabled BOOLEAN NOT NULL DEFAULT false,
        access_all_projects BOOLEAN NOT NULL DEFAULT false,
        access_all_models BOOLEAN NOT NULL DEFAULT false,
        allowed_models TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS user_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id);

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

      ALTER TABLE context_selections ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_selections_user ON context_selections(user_id);
    `,
  },
  {
    name: '007_stats_table',
    sql: `
      CREATE TABLE IF NOT EXISTS stats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        model TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        tokens INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_stats_project_created ON stats(project_id, created_at);
    `,
  },
  {
    name: '008_stats_session_request',
    sql: `
      ALTER TABLE stats ADD COLUMN IF NOT EXISTS session_id TEXT;
      ALTER TABLE stats ADD COLUMN IF NOT EXISTS request_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_stats_session ON stats(project_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_stats_request ON stats(project_id, request_id);
    `,
  },
  {
    name: '009_learning_code_extracts',
    sql: `
      CREATE TABLE IF NOT EXISTS learning_code_extracts (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        symbols_json TEXT NOT NULL DEFAULT '[]',
        code TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_code_extracts_chunk ON learning_code_extracts(chunk_id);
    `,
  },
  {
    name: '010_summaries_toc',
    sql: `
      ALTER TABLE summaries ADD COLUMN IF NOT EXISTS toc TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    name: '011_provider_short_prefix',
    sql: `
      ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS short_prefix TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_short_prefix_unique ON provider_configs(short_prefix) WHERE short_prefix IS NOT NULL;
    `,
  },
  {
    name: '012_rename_related_chunk_ids_to_related_ids',
    sql: `
      ALTER TABLE analysis_findings RENAME COLUMN related_chunk_ids TO related_ids;
      UPDATE analysis_findings SET related_ids = '{"chunkIds":[],"summaryIds":[],"findingIds":[]}';
    `,
  },
  {
    name: '013_stats_meta_jsonb',
    sql: `
      ALTER TABLE stats ALTER COLUMN meta DROP DEFAULT;
      ALTER TABLE stats ALTER COLUMN meta TYPE JSONB USING meta::jsonb;
      ALTER TABLE stats ALTER COLUMN meta SET DEFAULT '{}'::jsonb;
    `,
  },
  {
    name: '014_external_providers',
    sql: `
      ALTER TABLE provider_configs ADD COLUMN IF NOT EXISTS external_provider_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_providers_external ON provider_configs(external_provider_id);

      CREATE TABLE IF NOT EXISTS external_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_key TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT true,
        last_sync_at TIMESTAMPTZ,
        sync_status TEXT,
        sync_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_external_providers_key ON external_providers(provider_key);
    `,
  },
  {
    name: '015_proxy_errors',
    sql: `
      CREATE TABLE IF NOT EXISTS proxy_errors (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT,
        request_id TEXT,
        model TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        provider_type TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        status_code INTEGER,
        error_message TEXT NOT NULL DEFAULT '',
        error_type TEXT NOT NULL DEFAULT 'http_error',
        request_headers TEXT NOT NULL DEFAULT '{}',
        request_body TEXT NOT NULL DEFAULT '',
        response_headers TEXT NOT NULL DEFAULT '{}',
        response_body TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_proxy_errors_project_created ON proxy_errors(project_id, created_at);
    `,
  },
  {
    name: '016_background_task_runs',
    sql: `
      CREATE TABLE IF NOT EXISTS background_task_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        provider_name TEXT NOT NULL DEFAULT '',
        provider_type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        will_notify_user BOOLEAN NOT NULL DEFAULT false,
        read BOOLEAN NOT NULL DEFAULT false,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_background_task_runs_project ON background_task_runs(project_id, completed_at DESC);
    `,
  },
  {
    name: '017_learning_file_index',
    sql: `
      CREATE TABLE IF NOT EXISTS learning_file_index (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        normalized_file_name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_file_index_project_path
        ON learning_file_index(project_id, normalized_file_name);
      CREATE INDEX IF NOT EXISTS idx_learning_file_index_project
        ON learning_file_index(project_id);

      CREATE TABLE IF NOT EXISTS learning_file_chunks (
        file_id TEXT NOT NULL REFERENCES learning_file_index(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES learning_chunks(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (file_id, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_learning_file_chunks_chunk ON learning_file_chunks(chunk_id);

      CREATE TABLE IF NOT EXISTS learning_file_summaries (
        file_id TEXT NOT NULL REFERENCES learning_file_index(id) ON DELETE CASCADE,
        summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (file_id, summary_id)
      );
      CREATE INDEX IF NOT EXISTS idx_learning_file_summaries_summary ON learning_file_summaries(summary_id);
    `,
  },
  {
    name: '018_provider_model_metadata',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_model_metadata (
        provider_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        context_length INTEGER,
        display_name TEXT,
        api_format TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider_id, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_model_metadata_provider
        ON provider_model_metadata(provider_id);
    `,
  },
  {
    name: '019_provider_model_overrides',
    sql: `
      CREATE TABLE IF NOT EXISTS provider_model_overrides (
        provider_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        display_name TEXT,
        context_length INTEGER,
        api_format TEXT,
        supports_reasoning BOOLEAN,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider_id, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_model_overrides_provider
        ON provider_model_overrides(provider_id);
    `,
  },
  {
    name: '020_model_vision_support',
    sql: `
      ALTER TABLE provider_model_overrides ADD COLUMN IF NOT EXISTS supports_vision BOOLEAN;
    `,
  },
  {
    name: '021_model_reference',
    sql: `
      CREATE TABLE IF NOT EXISTS model_reference (
        source TEXT NOT NULL,
        model_id TEXT NOT NULL,
        vendor TEXT,
        display_name TEXT,
        context_length INTEGER,
        max_output_tokens INTEGER,
        supports_vision BOOLEAN,
        supports_reasoning BOOLEAN,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_model_reference_model
        ON model_reference(model_id);
    `,
  },
  {
    name: '022_user_hidden_models',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_models TEXT NOT NULL DEFAULT '[]';
    `,
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  const startedAt = Date.now();
  const dialect = getDialect();

  if (dialect === 'postgres') {
    await runPgMigrations();
  } else {
    runSqliteMigrations();
  }

  const rebuildStartedAt = Date.now();
  await filesRepo.rebuildFileIndexFromLegacy();
  logger.info('File index rebuild finished', {
    durationMs: Date.now() - rebuildStartedAt,
  });

  logger.info('Migrations complete', {
    dialect,
    totalMs: Date.now() - startedAt,
  });
}

// ── SQLite runner ──────────────────────────────────────────────────────────

function runSqliteMigrations(): void {
  const rawDb = getRawDb();
  const migrationsStartedAt = Date.now();

  // Ensure migrations table exists
  rawDb.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  let appliedCount = 0;
  for (const migration of SQLITE_MIGRATIONS) {
    const result = rawDb.exec('SELECT name FROM _migrations WHERE name = ?', [migration.name]);
    const applied = result.length > 0 && result[0].values.length > 0;

    if (!applied) {
      const stepStartedAt = Date.now();
      logger.info('Applying migration', { name: migration.name });
      try {
        rawDb.run(migration.sql);
        rawDb.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [
          migration.name,
          Date.now(),
        ]);
        appliedCount++;
        logger.info('Migration applied', { name: migration.name, durationMs: Date.now() - stepStartedAt });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('duplicate column') || msg.includes('already exists') || msg.includes('duplicate column name')) {
          logger.info('Migration column already exists (created by ORM), marking applied', { name: migration.name, durationMs: Date.now() - stepStartedAt });
          rawDb.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [
            migration.name,
            Date.now(),
          ]);
          appliedCount++;
        } else {
          throw err;
        }
      }
    }
  }

  // The final save re-serialises the ENTIRE in-memory DB to disk (sql.js
  // export + writeFileSync) — on a large DB this can take seconds.
  const saveStartedAt = Date.now();
  markDirty();
  saveDatabase();
  const saveMs = Date.now() - saveStartedAt;

  logger.info('SQLite migrations finished', {
    appliedCount,
    migrationsMs: Date.now() - migrationsStartedAt - saveMs,
    saveMs,
    totalMs: Date.now() - migrationsStartedAt,
  });

  if (saveMs > 250) {
    logger.warn('SQLite migration save was slow (large DB or slow disk)', { saveMs });
  }
}

// ── PostgreSQL runner ──────────────────────────────────────────────────────

async function runPgMigrations(): Promise<void> {
  const pool = getPgPool();
  const migrationsStartedAt = Date.now();

  // Ensure migrations table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );
  `);

  let appliedCount = 0;
  for (const migration of PG_MIGRATIONS) {
    const res = await pool.query('SELECT name FROM _migrations WHERE name = $1', [migration.name]);
    const applied = (res.rowCount ?? 0) > 0;

    if (!applied) {
      const stepStartedAt = Date.now();
      logger.info('Applying PG migration', { name: migration.name });
      try {
        await pool.query(migration.sql);
        await pool.query('INSERT INTO _migrations (name, applied_at) VALUES ($1, $2)', [
          migration.name,
          Date.now(),
        ]);
        appliedCount++;
        logger.info('PG migration applied', { name: migration.name, durationMs: Date.now() - stepStartedAt });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('already exists') || msg.includes('duplicate')) {
          logger.info('PG migration object already exists, marking applied', { name: migration.name, durationMs: Date.now() - stepStartedAt });
          await pool.query('INSERT INTO _migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
            migration.name,
            Date.now(),
          ]);
          appliedCount++;
        } else {
          throw err;
        }
      }
    }
  }

  logger.info('PostgreSQL migrations finished', {
    appliedCount,
    totalMs: Date.now() - migrationsStartedAt,
  });
}

// Allow running standalone: tsx src/db/migrate.ts
// Suppressed in SEA/bundled mode — the bundle entry point is index.ts, not this file.
if (process.argv[1]?.includes('migrate') && require.main === module) {
  (async () => {
    const { getConfig, loadConfig } = require('../config/config');
    loadConfig();
    const { initDatabase } = require('./connection');
    await initDatabase();
    await runMigrations();
    console.log('Migrations complete.');
    process.exit(0);
  })().catch((err: Error) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
