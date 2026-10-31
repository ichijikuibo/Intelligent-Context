import { afterEach, describe, expect, it } from 'vitest';
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

describe('ui harness', () => {
  it('loads the management shell and classic scripts without running init by default', async () => {
    const harness = await loadHarness();

    expect(harness.loadedScripts).toContain('js/state.js');
    expect(harness.loadedScripts).toContain('js/settings.js');
    expect(harness.loadedScripts).not.toContain('js/init.js');
    expect(harness.fetchMock).not.toHaveBeenCalled();

    expect(harness.document.getElementById('nav-overview')).not.toBeNull();
    expect(harness.evaluate<string>('typeof showTab')).toBe('function');
    expect(harness.evaluate<string>('typeof renderAuthScreen')).toBe('function');
    expect(harness.evaluate<{ locale: string }>('state')).toMatchObject({ locale: 'en' });
  });

  it('lets tests invoke UI globals and inspect DOM mutations', async () => {
    const harness = await loadHarness();

    harness.call('renderAuthScreen', false, 'Session expired');

    const authScreen = harness.document.getElementById('authScreen');
    expect(authScreen?.textContent).toContain('Sign In');
    expect(authScreen?.textContent).toContain('Session expired');
    expect(authScreen?.querySelector('[data-submit-button]')).not.toBeNull();
  });
});