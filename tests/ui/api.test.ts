import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUiHarness, type UiHarness } from './harness';

const harnesses: UiHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

async function loadHarness() {
  const harness = await createUiHarness();
  harnesses.push(harness);
  return harness;
}

function jsonResponse(body: unknown, overrides: Partial<Response> & { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    ...overrides,
  } as Response;
}

describe('ui/api.js', () => {
  it('builds the proxy URL from health.proxyPort when available', async () => {
    const harness = await loadHarness();

    harness.evaluate('state.health = { proxyPort: 4321 }');

    expect(harness.call('proxyUrl', '/v1/messages')).toBe('http://localhost:4321/v1/messages');
    expect(harness.call('proxyUrl', 'status')).toBe('http://localhost:4321/status');
  });

  it('uses locale-aware headers and returns parsed JSON for successful API requests', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.locale = 'fr'");
    harness.fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    const result = await harness.call<Promise<{ ok: boolean }>>('api', '/providers', {
      method: 'POST',
      headers: { 'X-Test-Header': 'yes' },
      body: JSON.stringify({ id: 'provider-1' }),
    });

    expect(result).toEqual({ ok: true });
    expect(harness.fetchMock).toHaveBeenCalledWith('/api/providers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'fr',
        'X-Test-Header': 'yes',
      },
      body: JSON.stringify({ id: 'provider-1' }),
      credentials: 'same-origin',
    });
  });

  it('clears the shell and renders the auth screen on non-safe 401 responses', async () => {
    const harness = await loadHarness();
    const setShellAuthenticatedSpy = vi.fn();
    const renderAuthScreenSpy = vi.fn();

    (harness.window as Window & { __setShellAuthenticatedSpy?: typeof setShellAuthenticatedSpy }).__setShellAuthenticatedSpy = setShellAuthenticatedSpy;
    (harness.window as Window & { __renderAuthScreenSpy?: typeof renderAuthScreenSpy }).__renderAuthScreenSpy = renderAuthScreenSpy;
    harness.evaluate('setShellAuthenticated = window.__setShellAuthenticatedSpy');
    harness.evaluate('renderAuthScreen = window.__renderAuthScreenSpy');
    harness.evaluate("state.currentUser = { email: 'user@example.com', role: 'user' }");
    harness.fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Session expired upstream.' } }, {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    await expect(harness.call<Promise<unknown>>('api', '/providers')).rejects.toMatchObject({
      message: 'Session expired upstream.',
      status: 401,
      payload: { error: { message: 'Session expired upstream.' } },
    });

    expect(harness.evaluate('state.currentUser')).toBeNull();
    expect(setShellAuthenticatedSpy).toHaveBeenCalledWith(false);
    expect(renderAuthScreenSpy).toHaveBeenCalledWith(false, 'Your session expired. Please sign in again.');
  });

  it('does not force logout when a safe auth path returns 401', async () => {
    const harness = await loadHarness();
    const setShellAuthenticatedSpy = vi.fn();
    const renderAuthScreenSpy = vi.fn();

    (harness.window as Window & { __setShellAuthenticatedSpy?: typeof setShellAuthenticatedSpy }).__setShellAuthenticatedSpy = setShellAuthenticatedSpy;
    (harness.window as Window & { __renderAuthScreenSpy?: typeof renderAuthScreenSpy }).__renderAuthScreenSpy = renderAuthScreenSpy;
    harness.evaluate('setShellAuthenticated = window.__setShellAuthenticatedSpy');
    harness.evaluate('renderAuthScreen = window.__renderAuthScreenSpy');
    harness.evaluate("state.currentUser = { email: 'user@example.com', role: 'user' }");
    harness.fetchMock.mockResolvedValue(jsonResponse({ error: 'Invalid login or password.' }, {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    await expect(harness.call<Promise<unknown>>('api', '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.com', password: 'wrong' }),
    })).rejects.toMatchObject({
      message: 'Invalid login or password.',
      status: 401,
    });

    expect(harness.evaluate('state.currentUser')).toEqual({ email: 'user@example.com', role: 'user' });
    expect(setShellAuthenticatedSpy).not.toHaveBeenCalled();
    expect(renderAuthScreenSpy).not.toHaveBeenCalled();
  });
});