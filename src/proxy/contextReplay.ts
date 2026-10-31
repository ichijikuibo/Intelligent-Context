import { getEffectiveContextConfig } from '../config/configOverrides';

export interface ToolResultReplayEntry {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

interface CachedContextEntry {
  contextBlock?: string;
  toolResults?: ToolResultReplayEntry[];
  updatedAt: number;
}

const contextReplayCache = new Map<string, CachedContextEntry>();

const MAX_TOOL_RESULT_REPLAY_ENTRIES = 12;
const MAX_TOOL_RESULT_REPLAY_JSON_CHARS = 24_000;

function contextReplayTtlMs(): number {
  return Math.max(0, getEffectiveContextConfig().contextReplayTtlMinutes) * 60 * 1000;
}

function maxCachedContexts(): number {
  return Math.max(0, getEffectiveContextConfig().maxCachedContexts);
}

function pruneContextReplayCache(): void {
  const ttl = contextReplayTtlMs();
  if (ttl <= 0) {
    contextReplayCache.clear();
    return;
  }

  const now = Date.now();
  for (const [key, entry] of contextReplayCache) {
    if (now - entry.updatedAt > ttl) {
      contextReplayCache.delete(key);
    }
  }
}

export function buildContextReplayKey(
  projectId: string | undefined,
  sessionId: string | undefined,
): string | null {
  if (!projectId || !sessionId) return null;
  return `${projectId}:${sessionId}`;
}

export function readContextReplayForSession(
  projectId: string | undefined,
  sessionId: string | undefined,
): string | null {
  const key = buildContextReplayKey(projectId, sessionId);
  const ttl = contextReplayTtlMs();
  if (!key || ttl <= 0) return null;

  pruneContextReplayCache();
  const entry = contextReplayCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.updatedAt > ttl) {
    contextReplayCache.delete(key);
    return null;
  }

  entry.updatedAt = Date.now();
  return mergeReplayBlocks(entry);
}

export function writeContextReplayForSession(
  projectId: string | undefined,
  sessionId: string | undefined,
  contextBlock: string,
): void {
  const key = buildContextReplayKey(projectId, sessionId);
  const ttl = contextReplayTtlMs();
  if (!key || ttl <= 0) return;

  pruneContextReplayCache();
  const cap = maxCachedContexts();

  if (!contextReplayCache.has(key) && contextReplayCache.size >= cap) {
    const oldestKey = contextReplayCache.keys().next().value;
    if (oldestKey) {
      contextReplayCache.delete(oldestKey);
    }
  }

  const existing = contextReplayCache.get(key);
  contextReplayCache.set(key, {
    ...existing,
    contextBlock,
    updatedAt: Date.now(),
  });
}

export function appendToolResultReplayEntriesForSession(
  projectId: string | undefined,
  sessionId: string | undefined,
  entries: ToolResultReplayEntry[],
): void {
  const key = buildContextReplayKey(projectId, sessionId);
  const ttl = contextReplayTtlMs();
  if (!key || ttl <= 0 || entries.length === 0) return;

  pruneContextReplayCache();
  const cap = maxCachedContexts();

  if (!contextReplayCache.has(key) && contextReplayCache.size >= cap) {
    const oldestKey = contextReplayCache.keys().next().value;
    if (oldestKey) {
      contextReplayCache.delete(oldestKey);
    }
  }

  const existing = contextReplayCache.get(key);
  const toolResults = clampToolResultReplayEntries([
    ...(existing?.toolResults ?? []),
    ...entries,
  ]);

  contextReplayCache.set(key, {
    ...existing,
    toolResults,
    updatedAt: Date.now(),
  });
}

export function clearContextReplayForSession(
  projectId: string | undefined,
  sessionId: string | undefined,
): void {
  const key = buildContextReplayKey(projectId, sessionId);
  if (!key) return;
  contextReplayCache.delete(key);
}

function clampToolResultReplayEntries(entries: ToolResultReplayEntry[]): ToolResultReplayEntry[] {
  const trimmed = entries.slice(-MAX_TOOL_RESULT_REPLAY_ENTRIES);

  while (trimmed.length > 1 && serializeToolResultsPayload(trimmed).length > MAX_TOOL_RESULT_REPLAY_JSON_CHARS) {
    trimmed.shift();
  }

  return trimmed;
}

function mergeReplayBlocks(entry: CachedContextEntry): string | null {
  const blocks = [
    entry.contextBlock,
    buildToolResultsContextBlock(entry.toolResults ?? []),
  ].filter((block): block is string => typeof block === 'string' && block.trim().length > 0);

  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

function buildToolResultsContextBlock(entries: ToolResultReplayEntry[]): string | null {
  if (entries.length === 0) return null;

  return [
    '## Internal IC Tool Results',
    '',
    'This block contains results from server-executed internal knowledge tools earlier in the current request chain.',
    'It is background state, not a separate user request.',
    'Use the IDs and result fields here if you need to update chunks, summaries, findings, or files referenced by those internal tools.',
    '',
    '<ic_tool_results>',
    serializeToolResultsPayload(entries, 2),
    '</ic_tool_results>',
    '',
    '---',
  ].join('\n');
}

function serializeToolResultsPayload(entries: ToolResultReplayEntry[], spacing?: number): string {
  try {
    return JSON.stringify({ toolResults: entries }, null, spacing);
  } catch {
    return JSON.stringify({
      toolResults: entries.map((entry) => ({
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        arguments: entry.arguments,
        result: '[unserializable result]',
      })),
    }, null, spacing);
  }
}

// ── Injection role cache ─────────────────────────────────────────────────────
// Tracks whether the context block was injected as a 'system' or 'user' message
// so that tool continuations replay it with the same role.

const contextInjectionRoleCache = new Map<string, 'system' | 'user'>();

export function writeContextInjectionRoleForSession(
  projectId: string | undefined,
  sessionId: string | undefined,
  role: 'system' | 'user',
): void {
  const key = buildContextReplayKey(projectId, sessionId);
  if (!key) return;
  contextInjectionRoleCache.set(key, role);
}

export function readContextInjectionRoleForSession(
  projectId: string | undefined,
  sessionId: string | undefined,
): 'system' | 'user' {
  const key = buildContextReplayKey(projectId, sessionId);
  if (!key) return 'system';
  return contextInjectionRoleCache.get(key) ?? 'system';
}