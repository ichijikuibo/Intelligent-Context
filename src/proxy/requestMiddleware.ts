export interface UpstreamRequestContext {
  /**
   * Conversation/session id from the originating client request, when one
   * exists. This is the preferred value for providers that want a stable
   * per-chat id.
   */
  sessionId?: string;
  /**
   * Stable identity for upstream calls that are not tied to a client
   * conversation (background jobs, connection tests, provider model syncs).
   * Callers should make this deterministic per logical work stream, for
   * example `summarizer:<projectId>`, so repeated runs of the same job keep
   * the same upstream session affinity.
   */
  jobKey?: string;
  /**
   * Project the call belongs to. Used as a last-resort stable fallback when
   * neither a session id nor a job key is available.
   */
  projectId?: string;
}

export type UpstreamRequestMiddleware = (
  context: UpstreamRequestContext
) => Record<string, string>;

interface RegisteredMiddleware {
  urlPattern: RegExp;
  middleware: UpstreamRequestMiddleware;
}

const middlewareRegistry: RegisteredMiddleware[] = [];

export function registerUpstreamRequestMiddleware(
  urlPattern: RegExp,
  middleware: UpstreamRequestMiddleware
): () => void {
  const registration = { urlPattern, middleware };
  middlewareRegistry.push(registration);

  return () => {
    const index = middlewareRegistry.indexOf(registration);
    if (index >= 0) middlewareRegistry.splice(index, 1);
  };
}

export function applyUpstreamRequestMiddleware(
  url: string,
  headers: Record<string, string>,
  context: UpstreamRequestContext
): Record<string, string> {
  const result = { ...headers };

  for (const { urlPattern, middleware } of middlewareRegistry) {
    urlPattern.lastIndex = 0;
    if (urlPattern.test(url)) {
      Object.assign(result, middleware(context));
    }
  }

  return result;
}

/**
 * Resolve the `x-opencode-session` value for a request.
 *
 * OpenCode Go expects a stable session id on every request, including the
 * background traffic the proxy generates itself (summarizer, analyzer,
 * context selector, gatherer). Chat requests forward the client's session
 * id; everything else gets a deterministic synthetic id so repeated runs of
 * the same job keep a stable upstream session and unrelated traffic does
 * not collapse into a single bucket.
 */
export function resolveOpencodeSessionId(context: UpstreamRequestContext): string {
  const sessionId = sanitizeSessionId(context.sessionId);
  if (sessionId) return sessionId;

  const jobKey = sanitizeSessionId(context.jobKey);
  if (jobKey) return `ic-${jobKey}`;

  const projectId = sanitizeSessionId(context.projectId);
  if (projectId) return `ic-project-${projectId}`;

  return 'ic-unscoped';
}

/** Header values must stay printable ASCII and reasonably short. */
function sanitizeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
}

registerUpstreamRequestMiddleware(
  /^https?:\/\/opencode\.ai\/zen\/go(?:\/|$)/i,
  (context): Record<string, string> => ({
    'x-opencode-session': resolveOpencodeSessionId(context),
  })
);