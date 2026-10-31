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

describe('ui/auth.js', () => {
  it('renders bootstrap auth mode with the admin login prefilled', async () => {
    const harness = await loadHarness();

    harness.call('renderAuthScreen', true, 'Create the first admin');

    expect(harness.document.getElementById('authScreen')?.textContent).toContain('Create Admin Account');
    expect(harness.document.getElementById('authScreen')?.textContent).toContain('Create the first admin');
    expect((harness.document.getElementById('authEmail') as HTMLInputElement | null)?.value).toBe('admin');
    expect(harness.document.querySelector('[data-submit-button]')?.getAttribute('onclick')).toBe('bootstrapAccount()');
  });

  it('shows a validation toast and skips login when credentials are missing', async () => {
    const harness = await loadHarness();
    const toastSpy = vi.fn();
    const apiSpy = vi.fn();

    (harness.window as Window & { __toastSpy?: typeof toastSpy }).__toastSpy = toastSpy;
    (harness.window as Window & { __apiSpy?: typeof apiSpy }).__apiSpy = apiSpy;
    harness.evaluate('toast = window.__toastSpy');
    harness.evaluate('api = window.__apiSpy');
    harness.call('renderAuthScreen', false);
    (harness.document.getElementById('authEmail') as HTMLInputElement).value = 'user@example.com';
    (harness.document.getElementById('authPassword') as HTMLInputElement).value = '';

    await harness.call<Promise<void>>('login');

    expect(apiSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith('Login and password are required.', true);
  });

  it('applies a successful login session, enables the shell, and shows the overview tab', async () => {
    const harness = await loadHarness();
    const setShellAuthenticatedSpy = vi.fn();
    const showTabSpy = vi.fn();

    (harness.window as Window & { __setShellAuthenticatedSpy?: typeof setShellAuthenticatedSpy }).__setShellAuthenticatedSpy = setShellAuthenticatedSpy;
    (harness.window as Window & { __showTabSpy?: typeof showTabSpy }).__showTabSpy = showTabSpy;
    harness.evaluate('setShellAuthenticated = window.__setShellAuthenticatedSpy');
    harness.evaluate('showTab = window.__showTabSpy');
    harness.window.localStorage.setItem('ic.selectedProject', 'project-2');
    harness.call('renderAuthScreen', false);
    (harness.document.getElementById('authEmail') as HTMLInputElement).value = 'user@example.com';
    (harness.document.getElementById('authPassword') as HTMLInputElement).value = 'secret';

    const session = {
      user: { email: 'user@example.com', role: 'user' },
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
    };
    harness.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => session,
    } as Response);

    await harness.call<Promise<void>>('login');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.com', password: 'secret' }),
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(harness.evaluate('state.currentUser')).toEqual({ email: 'user@example.com', role: 'user' });
    expect(harness.evaluate('state.selectedProject')).toBe('project-2');
    expect((harness.document.getElementById('headerProjectSelect') as HTMLSelectElement | null)?.value).toBe('project-2');
    expect(setShellAuthenticatedSpy).toHaveBeenCalledWith(true);
    expect(showTabSpy).toHaveBeenCalledWith('overview');
  });

  it('clears shell state and renders sign-in again even if logout API fails', async () => {
    const harness = await loadHarness();
    const setShellAuthenticatedSpy = vi.fn();
    const updateAuthChromeSpy = vi.fn();
    const renderAuthScreenSpy = vi.fn();

    (harness.window as Window & { __setShellAuthenticatedSpy?: typeof setShellAuthenticatedSpy }).__setShellAuthenticatedSpy = setShellAuthenticatedSpy;
    (harness.window as Window & { __updateAuthChromeSpy?: typeof updateAuthChromeSpy }).__updateAuthChromeSpy = updateAuthChromeSpy;
    (harness.window as Window & { __renderAuthScreenSpy?: typeof renderAuthScreenSpy }).__renderAuthScreenSpy = renderAuthScreenSpy;
    harness.evaluate('setShellAuthenticated = window.__setShellAuthenticatedSpy');
    harness.evaluate('updateAuthChrome = window.__updateAuthChromeSpy');
    harness.evaluate('renderAuthScreen = window.__renderAuthScreenSpy');
    harness.evaluate("state.currentUser = { email: 'user@example.com', role: 'user' }");
    harness.evaluate("state.projects = [{ id: 'project-1', name: 'Alpha' }]");
    harness.evaluate("state.selectedProject = 'project-1'");
    harness.evaluate("state.generatedApiKey = 'secret-key'");
    harness.fetchMock.mockRejectedValue(new Error('network down'));

    await harness.call<Promise<void>>('logout');

    expect(harness.evaluate('state.currentUser')).toBeNull();
    expect(harness.evaluate('state.projects')).toEqual([]);
    expect(harness.evaluate('state.selectedProject')).toBeNull();
    expect(harness.evaluate('state.generatedApiKey')).toBeNull();
    expect(updateAuthChromeSpy).toHaveBeenCalledTimes(1);
    expect(setShellAuthenticatedSpy).toHaveBeenCalledWith(false);
    expect(renderAuthScreenSpy).toHaveBeenCalledWith(false);
  });
});