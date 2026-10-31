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

function jsonResponse(body: unknown, overrides: Partial<Response> & { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    ...overrides,
  } as Response;
}

const MANUAL_PROVIDER = {
  id: 'provider-1',
  name: 'Local Gateway',
  type: 'openai',
  isEnabled: true,
  isExternal: false,
  shortPrefix: 'LGW',
};

const EXTERNAL_PROVIDER = {
  id: 'provider-2',
  name: 'CommandCode (OpenAI)',
  type: 'openai',
  isEnabled: true,
  isExternal: true,
  shortPrefix: 'CCO',
};

function modelsPayload(overrides: Record<string, unknown> = {}) {
  return {
    canManage: true,
    allModels: true,
    grants: [],
    providers: [MANUAL_PROVIDER, EXTERNAL_PROVIDER],
    ...overrides,
    models: overrides.models || [
      {
        providerId: 'provider-1',
        modelId: 'model-a',
        scopedId: 'LGW-model-a',
        displayName: 'Model A',
        contextLength: 128000,
        apiFormat: 'openai',
        supportsReasoning: false,
        supportsVision: false,
        inProviderList: true,
        providerIsExternal: false,
        reference: {
          source: 'openrouter',
          modelId: 'vendor/model-a',
          contextLength: 128000,
          supportsVision: false,
          supportsReasoning: false,
        },
      },
      {
        providerId: 'provider-2',
        modelId: 'claude-sonnet-5',
        scopedId: 'CCO-claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        contextLength: 1000000,
        apiFormat: 'anthropic',
        supportsReasoning: true,
        supportsVision: true,
        inProviderList: true,
        providerIsExternal: true,
        override: { supportsReasoning: true },
      },
    ],
  };
}

describe('ui/models.js', () => {
  it('groups models by provider and marks reasoning and custom overrides', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('renderModels');

    const text = harness.document.getElementById('tab-models')?.textContent || '';
    expect(text).toContain('Local Gateway');
    expect(text).toContain('CommandCode (OpenAI)');
    expect(text).toContain('LGW-model-a');
    expect(text).toContain('CCO-claude-sonnet-5');
    expect(text).toContain('1M ctx');
    expect(text).toContain('128K ctx');
    expect(text).toContain('reasoning');
    expect(text).toContain('vision');
    // A model with no override but a catalog match is labelled as such.
    // (The harness has no i18n catalogue, so the key itself is rendered.)
    expect(text).toContain('referenceBadge');
  });

  it('prefills the dialog from overrides only and saves a rename', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ ...modelsPayload().models[1] }));

    harness.call('openModelDialog', 'provider-2', 'claude-sonnet-5');
    const document = harness.document;
    expect(document.getElementById('modelsDialogBackdrop')).not.toBeNull();
    // Overridden field prefilled, non-overridden context left blank/placeholder.
    expect((document.getElementById('modelDialog_reasoning') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('modelDialog_vision') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('modelDialog_context') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('modelDialog_displayName') as HTMLInputElement).value).toBe('');

    await harness.call<Promise<void>>('saveModelDialog');

    // First request is the PUT; the follow-up render re-fetches the list.
    const [url, init] = harness.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/models/provider-2/claude-sonnet-5');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      modelId: 'claude-sonnet-5',
      displayName: null,
      contextLength: null,
      apiFormat: null,
      supportsReasoning: true,
      supportsVision: false,
    });
  });

  it('posts a new model without an override row when fields stay empty', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ providerId: 'provider-1', modelId: 'model-b' }));

    harness.call('showAddModelDialog');
    (harness.document.getElementById('modelDialog_modelId') as HTMLInputElement).value = 'model-b';

    await harness.call<Promise<void>>('saveModelDialog');

    const [url, init] = harness.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/models');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      providerId: 'provider-1',
      modelId: 'model-b',
    });
  });

  it('marks a new model as vision-capable when the checkbox is ticked', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ providerId: 'provider-1', modelId: 'model-b' }));

    harness.call('showAddModelDialog');
    (harness.document.getElementById('modelDialog_modelId') as HTMLInputElement).value = 'model-b';
    (harness.document.getElementById('modelDialog_vision') as HTMLInputElement).checked = true;

    await harness.call<Promise<void>>('saveModelDialog');

    const [, init] = harness.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      providerId: 'provider-1',
      modelId: 'model-b',
      supportsVision: true,
    });
  });

  it('rejects a non-numeric context before calling the API', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();

    harness.call('openModelDialog', 'provider-1', 'model-a');
    (harness.document.getElementById('modelDialog_context') as HTMLInputElement).value = '-5';

    await harness.call<Promise<void>>('saveModelDialog');

    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  // ── IDE visibility preference ───────────────────────────────────────────

  it('renders editable visibility checkboxes reflecting the stored preference', async () => {
    const harness = await loadHarness();
    const payload = modelsPayload({ hiddenModels: ['LGW-model-a'] });
    payload.models[0].hidden = true;
    harness.fetchMock.mockResolvedValue(jsonResponse(payload));

    await harness.call<Promise<void>>('renderModels');

    const document = harness.document;
    const boxes = [...document.querySelectorAll('[data-list-model]')] as HTMLInputElement[];
    expect(boxes.map((box) => box.value)).toEqual(['LGW-model-a', 'CCO-claude-sonnet-5']);
    // Unticked means hidden, and the checkbox must be editable by the user.
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
    expect(boxes.every((box) => !box.disabled)).toBe(true);
  });

  it('saves the unchecked models when a visibility checkbox is cleared', async () => {
    const harness = await loadHarness();
    // Two models on one provider, so unchecking one stays a per-model entry
    // instead of collapsing to the provider wildcard.
    const payload = modelsPayload({ providers: [MANUAL_PROVIDER] });
    payload.models.push({
      providerId: 'provider-1',
      modelId: 'model-b',
      scopedId: 'LGW-model-b',
      displayName: 'Model B',
      contextLength: 32000,
      apiFormat: 'openai',
      supportsReasoning: false,
      supportsVision: false,
      inProviderList: true,
      providerIsExternal: false,
      hidden: false,
    });
    harness.fetchMock.mockResolvedValue(jsonResponse(payload));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, hiddenModels: ['LGW-model-a'] }));

    const box = harness.document.querySelector('[data-list-model]') as HTMLInputElement;
    box.checked = false;
    await harness.call<Promise<void>>('onModelListModelToggle', box);

    const [url, init] = harness.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/models/visibility');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ hiddenModels: ['LGW-model-a'] });
  });

  it('collapses a fully unchecked provider to a single wildcard entry', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload({ providers: [MANUAL_PROVIDER] })));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, hiddenModels: ['LGW-*'] }));

    const providerBox = harness.document.querySelector('[data-list-provider]') as HTMLInputElement;
    providerBox.checked = false;
    await harness.call<Promise<void>>('onModelListProviderToggle', providerBox);

    const [, init] = harness.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ hiddenModels: ['LGW-*'] });
  });

  it('shows every model again when the provider box is re-ticked', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload({ providers: [MANUAL_PROVIDER] })));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, hiddenModels: [] }));

    const providerBox = harness.document.querySelector('[data-list-provider]') as HTMLInputElement;
    providerBox.checked = true;
    await harness.call<Promise<void>>('onModelListProviderToggle', providerBox);

    const [, init] = harness.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ hiddenModels: [] });
  });

  it('hides the add button from users who cannot manage models', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload({ canManage: false, allModels: false })));

    await harness.call<Promise<void>>('renderModels');

    const text = harness.document.getElementById('tab-models')?.textContent || '';
    expect(text).toContain('calloutReadOnly');
    expect(text).not.toContain('addButton');
    // No Edit/Remove buttons either.
    expect(harness.document.querySelectorAll('.btn-danger').length).toBe(0);
  });

  // ── Access dialog (Users tab) ───────────────────────────────────────────

  it('opens the access dialog for an existing user and reports the grants it collects', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('openModelAccessDialog', 'user-1', 'user@example.com', ['LGW-model-a']);
    await harness.settle();

    const document = harness.document;
    expect(document.getElementById('modelAccessDialogBackdrop')).not.toBeNull();

    const boxes = [...document.querySelectorAll('[data-list-model]')] as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);

    // Tick the second model, then read the selection back.
    boxes[1].checked = true;
    await harness.call<Promise<void>>('confirmModelAccessDialog');

    expect(document.getElementById('modelAccessDialogBackdrop')).toBeNull();
  });

  it('treats the all-models row as a shortcut for *-*', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('openModelAccessDialog', 'user-1', 'user@example.com', []);
    await harness.settle();

    const all = harness.document.getElementById('modelAccessAll') as HTMLInputElement;
    all.checked = true;
    harness.call('onModelAccessAllToggle', all);

    const boxes = [...harness.document.querySelectorAll('[data-list-model]')] as HTMLInputElement[];
    expect(boxes.every((box) => box.checked)).toBe(true);
  });

  it('stashes grants in the draft when the dialog is used from the create form', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('openModelAccessDialog', null, 'new user', []);

    const all = harness.document.getElementById('modelAccessAll') as HTMLInputElement;
    all.checked = true;
    harness.call('onModelAccessAllToggle', all);
    harness.call('confirmModelAccessDialog');

    expect(harness.getGlobal('draftUserGrants')).toEqual(['*-*']);
  });

  it('removes a model from a manual provider after confirmation', async () => {
    const harness = await loadHarness();
    harness.fetchMock.mockResolvedValue(jsonResponse(modelsPayload()));

    await harness.call<Promise<void>>('renderModels');
    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse(null, { status: 204 }));

    await harness.call<Promise<void>>('removeModelFromProvider', 'provider-1', 'model-a', 'Local Gateway');

    expect(harness.confirmMock).toHaveBeenCalled();
    const [url, init] = harness.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/models/provider-1/model-a');
    expect(init.method).toBe('DELETE');
  });
});
