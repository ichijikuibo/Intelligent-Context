/**
 * In-memory record of the most recently seen IDE client.
 *
 * IDE extensions (starting with the Intelligent Context VS Code extension) send
 * identifying headers on every request:
 *
 *   - `X-Project-Root`      — absolute workspace path (already used for detection)
 *   - `X-IC-Project-Name`   — workspace name, kept separate from the path
 *   - `X-IC-File`           — the file the user is currently editing
 *   - `X-IC-Branch`         — the active git branch
 *   - `User-Agent`          — the client's self-reported identity
 *
 * The management UI's Overview tab surfaces this so operators can confirm which
 * IDE + project is actually talking to the proxy.
 */
import type { Request } from 'express';

export interface ClientInfo {
  /** Self-reported client identity from the User-Agent header. */
  userAgent: string | null;
  /** Detected IDE label, e.g. "VS Code" or "Cursor". */
  ide: string | null;
  /** Workspace name as reported by the client. */
  projectName: string | null;
  /** Workspace root path as reported by the client. */
  projectRoot: string | null;
  /** Project the proxy actually routed the request to. */
  resolvedProjectName: string | null;
  /** Currently edited file, when the client sends it. */
  file: string | null;
  /** Active git branch, when the client sends it. */
  branch: string | null;
  /** ISO timestamp of the last request seen from this client. */
  lastSeenAt: string;
}

let lastClient: ClientInfo | null = null;

/** Identify well-known IDE User-Agent strings. Returns null when unrecognised. */
export function detectIde(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();

  if (ua.includes('cursor')) return 'Cursor';
  if (ua.includes('windsurf')) return 'Windsurf';
  if (ua.includes('vscode') || ua.includes('visual studio code')) return 'VS Code';
  if (ua.includes('intelligent-context')) return 'Intelligent Context';

  return null;
}

function readStringHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Record the client identity for this request. Called from project detection so
 * the Overview tab can report the latest IDE + project without a DB round-trip.
 */
export function recordClientInfo(req: Request, resolvedProjectName: string | null): void {
  const userAgent = readStringHeader(req, 'user-agent');

  lastClient = {
    userAgent,
    ide: detectIde(userAgent),
    projectName: readStringHeader(req, 'x-ic-project-name'),
    projectRoot:
      readStringHeader(req, 'x-project-root') ?? readStringHeader(req, 'x-workspace-root'),
    resolvedProjectName,
    file: readStringHeader(req, 'x-ic-file'),
    branch: readStringHeader(req, 'x-ic-branch'),
    lastSeenAt: new Date().toISOString(),
  };
}

/** Return a copy of the most recently recorded client info (null if none yet). */
export function getLastClientInfo(): ClientInfo | null {
  return lastClient ? { ...lastClient } : null;
}

/** Test helper — reset the recorded client info. */
export function resetClientInfo(): void {
  lastClient = null;
}
