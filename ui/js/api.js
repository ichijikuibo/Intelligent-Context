// ── API layer ─────────────────────────────────────────────────────────────

/**
 * Return the proxy base URL using the proxy port from /health data
 * (e.g. "http://localhost:1234/v1" when the proxy runs on that port).
 * Uses the proxy port from the /health response; falls back to `window.location.origin`
 * if the health data is not yet loaded.
 */
function proxyUrl(path = '/v1') {
  if (state.health && state.health.proxyPort) {
    const origin = window.location.protocol + '//' + window.location.hostname + ':' + state.health.proxyPort;
    return origin + (path.startsWith('/') ? path : '/' + path);
  }
  // Fallback: assume proxy is on the same origin (true in single-machine dev/test)
  return window.location.origin + (path.startsWith('/') ? path : '/' + path);
}

/**
 * Return the MCP server endpoint. The MCP server is mounted on the management
 * API, which is what serves this UI, so the current origin is always correct.
 */
function mcpUrl() {
  return window.location.origin + '/mcp';
}

async function api(path, opts = {}) {
  const unauthenticatedSafePaths = new Set([
    '/setup',
    '/auth/me',
    '/auth/login',
    '/auth/logout',
    '/auth/bootstrap',
  ]);
  const headers = {
    'Content-Type': 'application/json',
    'X-IC-Locale': state.locale || DEFAULT_LOCALE,
    ...(opts.headers || {}),
  };
  const res = await fetch(API + '/api' + path, {
    ...opts,
    headers,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: res.statusText }));
    const message =
      typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.error?.message === 'string'
          ? payload.error.message
          : res.statusText;
    const error = new Error(message);
    error.status = res.status;
    error.payload = payload;
    if (res.status === 401 && !unauthenticatedSafePaths.has(path)) {
      state.currentUser = null;
      setShellAuthenticated(false);
      renderAuthScreen(false, 'Your session expired. Please sign in again.');
    }
    throw error;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadSetupStatus() {
  const res = await fetch(API + '/api/setup/status', {
    headers: { 'X-IC-Locale': state.locale || DEFAULT_LOCALE },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(res.statusText || 'Failed to load setup status');
  }
  return res.json();
}

async function loadBootstrapStatus() {
  const res = await fetch(API + '/api/auth/bootstrap-status', {
    headers: { 'X-IC-Locale': state.locale || DEFAULT_LOCALE },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error(res.statusText || 'Failed to load bootstrap status');
  }
  return res.json();
}
