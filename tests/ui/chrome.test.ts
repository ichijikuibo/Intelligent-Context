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

describe('ui/chrome.js', () => {
  it('toggles shell visibility and clears responsive chrome when unauthenticated', async () => {
    const harness = await loadHarness();

    harness.document.body.classList.add('nav-open', 'header-menu-open');

    harness.call('setShellAuthenticated', false);

    expect(harness.document.getElementById('authScreen')?.style.display).toBe('block');
    expect(harness.document.getElementById('appHeader')?.style.display).toBe('none');
    expect(harness.document.getElementById('appLayout')?.style.display).toBe('none');
    expect(harness.document.body.classList.contains('nav-open')).toBe(false);
    expect(harness.document.body.classList.contains('header-menu-open')).toBe(false);
    expect(harness.document.getElementById('mobileNavToggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(harness.document.getElementById('mobileHeaderToggle')?.getAttribute('aria-expanded')).toBe('false');
    // The document must scroll normally on the sign-in screen.
    expect(harness.document.body.classList.contains('ic-shell')).toBe(false);
  });

  it('pins the document to the viewport only while the authenticated shell is shown', async () => {
    const harness = await loadHarness();

    harness.call('setShellAuthenticated', true);
    // `ic-shell` is what lets the header and nav stay put while only `main`
    // scrolls; it must not apply to the setup/auth screens.
    expect(harness.document.body.classList.contains('ic-shell')).toBe(true);

    harness.call('setShellAuthenticated', false);
    expect(harness.document.body.classList.contains('ic-shell')).toBe(false);
  });

  it('shows admin chrome and polls unread notifications for admins', async () => {
    const harness = await loadHarness();
    const pollSpy = vi.fn();

    (harness.window as Window & { __pollSpy?: typeof pollSpy }).__pollSpy = pollSpy;
    harness.evaluate('pollUnreadNotifications = window.__pollSpy');
    (harness.window as Window & { __user?: { email: string; role: string } }).__user = {
      email: 'admin@example.com',
      role: 'admin',
    };
    harness.evaluate('state.currentUser = window.__user');

    harness.call('updateAuthChrome');

    expect(harness.document.getElementById('headerUser')?.textContent).toBe('admin@example.com (admin)');
    expect(harness.document.getElementById('headerUser')?.style.display).toBe('inline');
    expect(harness.document.getElementById('headerLogout')?.style.display).toBe('inline-flex');
    expect(harness.document.getElementById('nav-users')?.style.display).toBe('block');
    expect(harness.document.getElementById('nav-api-keys')?.style.display).toBe('block');
    expect(harness.document.getElementById('nav-providers')?.style.display).toBe('block');
    expect(harness.document.getElementById('nav-external-providers')?.style.display).toBe('block');
    expect(harness.document.getElementById('nav-settings')?.style.display).toBe('block');
    expect(harness.document.getElementById('nav-task-runs')?.style.display).toBe('block');
    expect(harness.document.getElementById('headerNotifications')?.style.display).toBe('inline-flex');
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it('syncs the project header select from stored selection and updates the indicator', async () => {
    const harness = await loadHarness();

    harness.call('storeSelectedProject', 'project-2');
    harness.evaluate('state.selectedProject = null');

    harness.call('syncProjectHeaderSelect', [
      { id: 'project-1', name: 'Alpha' },
      { id: 'project-2', name: 'Beta' },
    ]);

    expect(harness.evaluate<string>('state.selectedProject')).toBe('project-2');
    expect((harness.document.getElementById('headerProjectSelect') as HTMLSelectElement | null)?.value).toBe('project-2');
    expect(harness.document.getElementById('headerProjectName')?.textContent).toBe('Beta');
    expect(harness.document.getElementById('headerProjectName')?.style.display).toBe('inline');
    expect(harness.window.localStorage.getItem('ic.selectedProject')).toBe('project-2');
  });

  it('submits the enter-target container when Enter is pressed in a text input', async () => {
    const harness = await loadHarness();
    const container = harness.document.createElement('div');
    const input = harness.document.createElement('input');
    const button = harness.document.createElement('button');
    const preventDefault = vi.fn();
    const clickSpy = vi.fn();

    container.setAttribute('data-enter-submit', '');
    input.type = 'text';
    button.setAttribute('data-submit-button', '');
    button.addEventListener('click', clickSpy);
    container.append(input, button);
    harness.document.body.appendChild(container);

    harness.call('handleDocumentKeydown', {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault,
      target: input,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});