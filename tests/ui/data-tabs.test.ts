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

describe('ui/data-tabs.js', () => {
  it('parses code extract symbols from JSON and filters invalid entries', async () => {
    const harness = await loadHarness();

    expect(harness.call('parseCodeExtractSymbols', '["alpha","",42,null,"beta"]')).toEqual(['alpha', 'beta']);
    expect(harness.call('parseCodeExtractSymbols', 'not json')).toEqual([]);
    expect(harness.call('parseCodeExtractSymbols', '')).toEqual([]);
  });

  it('shows the select-project placeholder when rendering chunks without an active project', async () => {
    const harness = await loadHarness();

    harness.evaluate('state.selectedProject = null');

    await harness.call<Promise<void>>('renderChunks');

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.document.getElementById('tab-chunks')?.textContent).toContain('ui.chunks.selectProjectFirst');
  });

  it('renders chunks, stores them in state, and initializes the data table', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock.mockResolvedValue(jsonResponse({
      chunks: [
        {
          id: 'chunk-1',
          fact: 'Auth uses signed session tokens',
          category: 'auth',
          confidence: 0.82,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      total: 1,
    }));

    await harness.call<Promise<void>>('renderChunks');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/projects/project-1/context/chunks', {
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(harness.evaluate('state.chunksData')).toEqual([
      {
        id: 'chunk-1',
        fact: 'Auth uses signed session tokens',
        category: 'auth',
        confidence: 0.82,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
    expect(harness.document.getElementById('tab-chunks')?.textContent).toContain('Auth uses signed session tokens');
    expect(harness.dataTableMock).toHaveBeenCalledWith('#chunksTable', expect.objectContaining({
      searchable: true,
      perPage: 10,
      sortable: true,
    }));
  });

  it('deletes a chunk and rerenders the chunks tab', async () => {
    const harness = await loadHarness();
    const renderChunksSpy = vi.fn(() => Promise.resolve());
    const toastSpy = vi.fn();

    harness.evaluate("state.selectedProject = 'project-1'");
    (harness.window as Window & { __renderChunksSpy?: typeof renderChunksSpy }).__renderChunksSpy = renderChunksSpy;
    (harness.window as Window & { __toastSpy?: typeof toastSpy }).__toastSpy = toastSpy;
    harness.evaluate('renderChunks = window.__renderChunksSpy');
    harness.evaluate('toast = window.__toastSpy');
    harness.fetchMock.mockResolvedValue(jsonResponse(null, { status: 204 }));

    await harness.call<Promise<void>>('deleteChunk', 'chunk-1');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/projects/project-1/context/chunks/chunk-1', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(toastSpy).toHaveBeenCalledWith('ui.chunks.deleted');
    expect(renderChunksSpy).toHaveBeenCalledTimes(1);
  });
});