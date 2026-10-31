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

describe('ui/render.js', () => {
  it('does not switch tabs when no user is authenticated', async () => {
    const harness = await loadHarness();
    const closeResponsiveChromeSpy = vi.fn();
    const renderTabSpy = vi.fn();

    (harness.window as Window & { __closeResponsiveChromeSpy?: typeof closeResponsiveChromeSpy }).__closeResponsiveChromeSpy = closeResponsiveChromeSpy;
    (harness.window as Window & { __renderTabSpy?: typeof renderTabSpy }).__renderTabSpy = renderTabSpy;
    harness.evaluate('closeResponsiveChrome = window.__closeResponsiveChromeSpy');
    harness.evaluate('renderTab = window.__renderTabSpy');
    harness.evaluate('state.currentUser = null');

    harness.call('showTab', 'settings');

    expect(closeResponsiveChromeSpy).not.toHaveBeenCalled();
    expect(renderTabSpy).not.toHaveBeenCalled();
    expect(harness.document.getElementById('nav-overview')?.classList.contains('active')).toBe(true);
    expect(harness.document.getElementById('tab-settings')?.style.display).toBe('none');
  });

  it('switches tabs, updates nav state, closes responsive chrome, and delegates rendering', async () => {
    const harness = await loadHarness();
    const closeResponsiveChromeSpy = vi.fn();
    const renderTabSpy = vi.fn();

    (harness.window as Window & { __closeResponsiveChromeSpy?: typeof closeResponsiveChromeSpy }).__closeResponsiveChromeSpy = closeResponsiveChromeSpy;
    (harness.window as Window & { __renderTabSpy?: typeof renderTabSpy }).__renderTabSpy = renderTabSpy;
    harness.evaluate('closeResponsiveChrome = window.__closeResponsiveChromeSpy');
    harness.evaluate('renderTab = window.__renderTabSpy');
    harness.evaluate("state.currentUser = { email: 'user@example.com', role: 'user' }");

    harness.call('showTab', 'settings');

    expect(closeResponsiveChromeSpy).toHaveBeenCalledTimes(1);
    expect(renderTabSpy).toHaveBeenCalledWith('settings');
    expect(harness.document.getElementById('tab-settings')?.style.display).toBe('block');
    expect(harness.document.getElementById('tab-overview')?.style.display).toBe('none');
    expect(harness.document.getElementById('nav-settings')?.classList.contains('active')).toBe(true);
    expect(harness.document.getElementById('nav-overview')?.classList.contains('active')).toBe(false);
  });

  it('renders and closes the summary dialog for an existing summary', async () => {
    const harness = await loadHarness();

    harness.evaluate(`state.summariesData = [{
      id: 'summary-1',
      title: 'Auth Summary',
      updatedAt: '2026-07-01T00:00:00.000Z',
      version: 2,
      content: 'Authentication summary details'
    }]`);

    harness.call('openSummaryDialog', 'summary-1');

    const backdrop = harness.document.getElementById('summaryDialogBackdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.textContent).toContain('Auth Summary');
    expect(backdrop?.textContent).toContain('Authentication summary details');
    expect(backdrop?.textContent).toContain('v2');

    backdrop?.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

    expect(harness.document.getElementById('summaryDialogBackdrop')).toBeNull();
  });

  it('renders the code extract dialog with parsed symbols and code content', async () => {
    const harness = await loadHarness();

    harness.evaluate(`state.codeExtractsData = [{
      id: 'extract-1',
      fileName: 'src/auth.ts',
      language: 'ts',
      symbolsJson: '["login","logout"]',
      chunkId: 'chunk-abcdef12',
      createdAt: '2026-07-02T00:00:00.000Z',
      code: 'export function login() {}'
    }]`);

    harness.call('openCodeExtractDialog', 'extract-1');

    const backdrop = harness.document.getElementById('codeExtractDialogBackdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.textContent).toContain('src/auth.ts');
    expect(backdrop?.textContent).toContain('login');
    expect(backdrop?.textContent).toContain('logout');
    expect(backdrop?.textContent).toContain('export function login() {}');

    harness.call('closeCodeExtractDialog');
    expect(harness.document.getElementById('codeExtractDialogBackdrop')).toBeNull();
  });

  it('loads file details and renders summaries before chunks when requested', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.evaluate(`state.filesData = [{
      id: 'file-1',
      fileName: 'src/auth.ts',
      purpose: 'Authentication helpers',
      chunkCount: 1,
      summaryCount: 1,
      createdAt: '2026-07-03T00:00:00.000Z'
    }]`);

    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          id: 'chunk-1',
          category: 'auth',
          createdAt: '2026-07-03T00:00:00.000Z',
          fact: 'Chunk fact text',
        }],
        total: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          id: 'summary-1',
          title: 'Summary title',
          updatedAt: '2026-07-03T00:00:00.000Z',
          oneLineSummary: 'Summary preview text',
        }],
        total: 1,
      }));

    await harness.call<Promise<void>>('openFileDetailsDialog', 'file-1', 'summaries');

    expect(harness.fetchMock).toHaveBeenNthCalledWith(1, '/api/projects/project-1/files/file-1/chunks', {
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(harness.fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/project-1/files/file-1/summaries', {
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });

    const backdrop = harness.document.getElementById('fileDetailsDialogBackdrop');
    expect(backdrop).not.toBeNull();
    const markup = backdrop?.innerHTML || '';
    expect(markup.indexOf('Summary title')).toBeGreaterThan(-1);
    expect(markup.indexOf('Chunk fact text')).toBeGreaterThan(-1);
    expect(markup.indexOf('Summary title')).toBeLessThan(markup.indexOf('Chunk fact text'));

    harness.call('closeFileDetailsDialog');
    expect(harness.document.getElementById('fileDetailsDialogBackdrop')).toBeNull();
  });
});