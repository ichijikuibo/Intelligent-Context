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

describe('ui/projects.js', () => {
  it('renders project cards for power users and syncs the selected project header', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.currentUser = { email: 'power@example.com', role: 'power_user' }");
    harness.call('storeSelectedProject', 'project-2');
    harness.fetchMock.mockResolvedValue(jsonResponse([
      { id: 'project-1', name: 'Alpha', rootPath: '/repo/alpha', pathPattern: '' },
      { id: 'project-2', name: 'Beta', rootPath: '/repo/beta', pathPattern: 'src/**' },
    ]));

    await harness.call<Promise<void>>('renderProjects');

    const tabText = harness.document.getElementById('tab-projects')?.textContent || '';
    expect(tabText).toContain('Alpha');
    expect(tabText).toContain('Beta');
    expect(tabText).toContain('ui.projects.addButton');
    expect((harness.document.getElementById('headerProjectSelect') as HTMLSelectElement | null)?.value).toBe('project-2');
    expect(harness.document.getElementById('headerProjectName')?.textContent).toBe('Beta');
  });

  it('creates a project with a nullable pathPattern and rerenders on success', async () => {
    const harness = await loadHarness();
    const renderProjectsSpy = vi.fn(() => Promise.resolve());
    const toastSpy = vi.fn();

    harness.evaluate("state.currentUser = { email: 'admin@example.com', role: 'admin' }");
    harness.fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await harness.call<Promise<void>>('renderProjects');

    (harness.window as Window & { __renderProjectsSpy?: typeof renderProjectsSpy }).__renderProjectsSpy = renderProjectsSpy;
    (harness.window as Window & { __toastSpy?: typeof toastSpy }).__toastSpy = toastSpy;
    harness.evaluate('renderProjects = window.__renderProjectsSpy');
    harness.evaluate('toast = window.__toastSpy');

    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    (harness.document.getElementById('newProjName') as HTMLInputElement).value = 'Gamma';
    (harness.document.getElementById('newProjPath') as HTMLInputElement).value = '/repo/gamma';
    (harness.document.getElementById('newProjPattern') as HTMLInputElement).value = '';

    await harness.call<Promise<void>>('addProject');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Gamma', rootPath: '/repo/gamma', pathPattern: null }),
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(toastSpy).toHaveBeenCalledWith('ui.projects.created');
    expect(renderProjectsSpy).toHaveBeenCalledTimes(1);
  });

  it('deletes a project, updates local state, and rerenders after confirmation', async () => {
    const harness = await loadHarness();
    const renderProjectsSpy = vi.fn(() => Promise.resolve());
    const toastSpy = vi.fn();

    harness.evaluate("state.currentUser = { email: 'admin@example.com', role: 'admin' }");
    harness.fetchMock.mockResolvedValueOnce(jsonResponse([
      { id: 'project-1', name: 'Alpha', rootPath: '/repo/alpha', pathPattern: '' },
      { id: 'project-2', name: 'Beta', rootPath: '/repo/beta', pathPattern: '' },
    ]));
    await harness.call<Promise<void>>('renderProjects');

    (harness.window as Window & { __renderProjectsSpy?: typeof renderProjectsSpy }).__renderProjectsSpy = renderProjectsSpy;
    (harness.window as Window & { __toastSpy?: typeof toastSpy }).__toastSpy = toastSpy;
    harness.evaluate('renderProjects = window.__renderProjectsSpy');
    harness.evaluate('toast = window.__toastSpy');

    harness.confirmMock.mockReturnValue(true);
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse(null, { status: 204 }));

    await harness.call<Promise<void>>('deleteProject', 'project-1');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/projects/project-1', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(harness.evaluate('state.projects')).toEqual([
      { id: 'project-2', name: 'Beta', rootPath: '/repo/beta', pathPattern: '' },
    ]);
    expect(harness.evaluate('state.selectedProject')).toBe('project-2');
    expect((harness.document.getElementById('headerProjectSelect') as HTMLSelectElement | null)?.value).toBe('project-2');
    expect(toastSpy).toHaveBeenCalledWith('ui.projects.deleted');
    expect(renderProjectsSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ui/projects.js — API keys tab', () => {
  it('shows the MCP endpoint and a client config with the placeholder key', async () => {
    const harness = await loadHarness();
    harness.evaluate("state.messages = { 'ui.apiKeys.mcpTitle': 'Use with MCP clients', 'ui.apiKeys.placeholderKey': '<your-api-key>' }");
    harness.evaluate('state.generatedApiKey = null');
    harness.fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await harness.call<Promise<void>>('renderApiKeys');

    const text = harness.document.getElementById('tab-api-keys')?.textContent || '';
    expect(text).toContain('Use with MCP clients');
    expect(text).toContain('http://localhost/mcp');
    expect(text).toContain('Bearer <your-api-key>');
  });

  it('embeds the freshly generated key in the client config', async () => {
    const harness = await loadHarness();
    harness.evaluate("state.generatedApiKey = 'secret-key-123'");
    harness.fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await harness.call<Promise<void>>('renderApiKeys');

    const snippet = harness.document.getElementById('mcpConfigSnippet')?.textContent || '';
    expect(snippet).toContain('"url": "http://localhost/mcp"');
    expect(snippet).toContain('Bearer secret-key-123');
  });

  it('copies the client config to the clipboard', async () => {
    const harness = await loadHarness();
    harness.evaluate("state.generatedApiKey = 'secret-key-123'");
    harness.fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await harness.call<Promise<void>>('renderApiKeys');

    const button = { textContent: 'Copy' };
    harness.call('copyMcpConfig', button);
    await harness.settle();

    expect(harness.clipboardWriteTextMock).toHaveBeenCalledTimes(1);
    expect(harness.clipboardWriteTextMock.mock.calls[0][0]).toContain('Bearer secret-key-123');
  });

  it('renders the proxy base URLs and the VS Code extension note', async () => {
    const harness = await loadHarness();
    harness.evaluate("state.health = { proxyPort: 1234 }");
    harness.fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await harness.call<Promise<void>>('renderApiKeys');

    const text = harness.document.getElementById('tab-api-keys')?.textContent || '';
    expect(text).toContain('ui.apiKeys.proxyTitle');
    expect(text).toContain('ui.apiKeys.vscodeTitle');
    expect(harness.document.getElementById('apiKeysProxyUrl')?.textContent).toBe('http://localhost:1234/v1');
    expect(harness.document.getElementById('apiKeysProxyMessagesUrl')?.textContent).toBe('http://localhost:1234/v1/messages');
  });
});

describe('ui/projects.js — users tab', () => {
  const ADMIN = {
    id: 'user-admin',
    email: 'admin@example.com',
    role: 'admin',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: true,
    accessAllModels: true,
    allowedModels: [],
    hiddenModels: [],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  };

  const RESTRICTED = {
    id: 'user-restricted',
    email: 'dev@example.com',
    role: 'user',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: false,
    accessAllModels: false,
    allowedModels: ['OCA-*'],
    hiddenModels: [],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  };

  async function renderUsersTab() {
    const harness = await loadHarness();
    harness.evaluate("state.currentUser = { email: 'admin@example.com', role: 'admin' }");
    harness.fetchMock.mockResolvedValue(jsonResponse([]));
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse([ADMIN, RESTRICTED]))
      .mockResolvedValueOnce(jsonResponse([]));

    await harness.call<Promise<void>>('renderUsers');
    return harness;
  }

  it('renders a model-access button for every user', async () => {
    const harness = await renderUsersTab();

    const text = harness.document.getElementById('tab-users')?.textContent || '';
    expect(text).toContain('accessDialogOpen');
    // The grant summary is shown inline rather than a raw JSON input.
    expect(text).toContain('OCA-*');
  });

  it('carries grants in a hidden field so the dialog can reopen', async () => {
    const harness = await renderUsersTab();

    const field = harness.document.getElementById('user_grants_user-restricted') as HTMLInputElement | null;
    expect(field).not.toBeNull();
    expect(JSON.parse(field!.value)).toEqual(['OCA-*']);

    // An admin always holds *-*, so their controls are hidden entirely.
    const adminRow = harness.document.getElementById('user_model_access_row_user-admin');
    expect(adminRow?.style.display).toBe('none');
    const adminAll = harness.document.getElementById('user_all_models_row_user-admin');
    expect(adminAll?.style.display).toBe('none');
  });

  it('round-trips grants through the dialog without touching the API', async () => {
    const harness = await renderUsersTab();
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValue(jsonResponse({
      providers: [{ id: 'provider-1', name: 'Gateway', type: 'openai', isEnabled: true, isExternal: false, shortPrefix: 'GW' }],
      models: [{
        providerId: 'provider-1',
        modelId: 'model-a',
        scopedId: 'GW-model-a',
        displayName: 'Model A',
        contextLength: 128000,
        apiFormat: 'openai',
        supportsReasoning: false,
        supportsVision: false,
        inProviderList: true,
        providerIsExternal: false,
        hidden: false,
      }],
      canManage: true,
      allModels: true,
      grants: [],
      hiddenModels: [],
    }));

    await harness.call<Promise<void>>('openModelAccessDialog', 'user-restricted', 'dev@example.com', ['GW-model-a']);

    const box = harness.document.querySelector('[data-list-model]') as HTMLInputElement;
    expect(box.checked).toBe(true);

    box.checked = false;
    harness.call('confirmModelAccessDialog');

    const field = harness.document.getElementById('user_grants_user-restricted') as HTMLInputElement;
    expect(JSON.parse(field.value)).toEqual([]);
    // Applying the dialog is local state only; Save Changes does the write.
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });
});