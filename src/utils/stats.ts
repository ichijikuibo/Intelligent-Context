import { statsRepo, type InsertStatData } from '../db/repositories/stats';
import { logger } from './logger';
import { estimateTokens } from './tokens';

// ── Env-var gate ───────────────────────────────────────────────────────────
// Set IC_STATS_ENABLED=true to record *all* telemetry to the stats table.
// This is intended for temporary debugging/tuning and is not documented.
//
// A small set of high-value types are ALWAYS recorded regardless of the env
// var so they can be surfaced in the management UI (Statistics tab).  The
// verbose per-model input/output bodies for analyzer/summarizer/gatherer
// stay behind the env-var gate.

export const ALWAYS_RECORDED_STAT_TYPES = new Set<string>([
  // Assembled context block injected into the main model.
  'context_injection',
  // Learnings persisted through the inline/legacy learning pipeline.
  'learning',
  // Knowledge retrieval through the `ic` / `ic_get_*` / `ic_list_*` tools.
  'ic_retrieval',
  // Learnings recorded through the `record_learning` tool / `ic record` op.
  'ic_record_learning',
  // Knowledge mutations (create/update/delete) through IC tools.
  'ic_write',
  // Any other IC tool call that could not be classified above.
  'ic_tool',
]);

function isStatsEnabled(): boolean {
  return process.env.IC_STATS_ENABLED === 'true';
}

/** True when the given stat type should be recorded even without the env var. */
export function isAlwaysRecordedStatType(type: string): boolean {
  return ALWAYS_RECORDED_STAT_TYPES.has(type);
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface StatRecordInput {
  projectId: string;
  sessionId?: string;
  requestId?: string;
  model: string;
  runId: string;
  type: string;
  direction: 'input' | 'output';
  meta?: Record<string, unknown>;
  body?: string;
  /** Real token count from the API response. If omitted, estimated from body. */
  tokens?: number;
}

/**
 * Record a stats row if IC_STATS_ENABLED is true, or if the type is one of
 * the always-recorded types surfaced in the management UI.
 * Fire-and-forget — errors are logged but never thrown.
 */
export function recordStat(data: StatRecordInput): void {
  if (!isStatsEnabled() && !isAlwaysRecordedStatType(data.type)) return;

  const resolvedTokens =
    data.tokens ??
    (data.body ? estimateTokens(data.body) : 0);

  const insertData: InsertStatData = {
    projectId: data.projectId,
    sessionId: data.sessionId,
    requestId: data.requestId,
    model: data.model,
    runId: data.runId,
    type: data.type,
    direction: data.direction,
    meta: data.meta,
    tokens: resolvedTokens,
    body: data.body,
  };

  statsRepo.insert(insertData).catch((err) => {
    logger.warn('Failed to record stats row', {
      type: data.type,
      direction: data.direction,
      error: String(err),
    });
  });
}

/**
 * Record an input/output pair in one call.
 */
export function recordStatPair(input: Omit<StatRecordInput, 'direction'>, output: Omit<StatRecordInput, 'direction'>): void {
  recordStat({ ...input, direction: 'input' });
  recordStat({ ...output, direction: 'output' });
}

/**
 * Generate a unique run ID for grouping input/output pairs.
 */
export function generateRunId(): string {
  return `stats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
