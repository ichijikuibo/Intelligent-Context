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

function buildSettingsPayload(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      requestContextMode: 'gatherer',
      contextSelector: 'OAI-gpt-4.1-mini',
      summarizer: 'OAI-gpt-4.1-mini',
      analyzer: 'OAI-gpt-4.1-mini',
      learning: 'DSK-deepseek-chat',
      gatherer: 'DSK-deepseek-chat',
      ...(overrides.models as Record<string, unknown> | undefined),
    },
    analyzer: {
      agentEnabled: true,
      agentMaxTurns: 7,
      ...(overrides.analyzer as Record<string, unknown> | undefined),
    },
    context: {
      tokenBudget: 4096,
      autoSummarizeThreshold: 5,
      embeddingModel: 'text-embedding-3-small',
      minConfidence: 0.6,
      bypassSelectorItemThreshold: 10,
      bypassSelectorTokenThreshold: 2000,
      reservedResponseTokens: 4000,
      contextOverheadTokens: 500,
      defaultModelMaxTokens: 16000,
      contextReplayTtlMinutes: 30,
      maxCachedContexts: 50,
      maxRecordLearnings: 200,
      ...(overrides.context as Record<string, unknown> | undefined),
    },
    workers: {
      summarizeIntervalMinutes: 15,
      analyzeIntervalHours: 6,
      idleThresholdMinutes: 20,
      ...(overrides.workers as Record<string, unknown> | undefined),
    },
    availableModels: ['OAI-gpt-4.1-mini', 'DSK-deepseek-chat'],
    availableModelOptions: [
      { value: 'OAI-gpt-4.1-mini', label: 'gpt-4.1-mini [OpenAI]', model: 'gpt-4.1-mini' },
      { value: 'DSK-deepseek-chat', label: 'deepseek-chat [DeepSeek]', model: 'deepseek-chat' },
    ],
    ...overrides,
  };
}

describe('ui/settings.js', () => {
  it('renders gatherer mode with the gatherer model select resolved from persisted legacy storage', async () => {
    const harness = await loadHarness();

    harness.window.localStorage.setItem('ic.settings.models', JSON.stringify({
      gathererModel: 'deepseek-chat',
      summarizerModel: 'gpt-4.1-mini',
    }));
    harness.fetchMock.mockResolvedValue(jsonResponse(buildSettingsPayload()));

    await harness.call<Promise<void>>('renderSettings');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/settings', {
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });

    const selectedMode = harness.document.querySelector<HTMLInputElement>('#tab-settings input[name="requestContextMode"]:checked');
    expect(selectedMode?.value).toBe('gatherer');

    const activeModeSelect = harness.document.querySelector<HTMLSelectElement>('#tab-settings label.choice-card.is-selected select');
    expect(activeModeSelect?.value).toBe('DSK-deepseek-chat');

    const allSelects = Array.from(harness.document.querySelectorAll<HTMLSelectElement>('#tab-settings select'));
    expect(allSelects.map((select) => select.value)).toContain('OAI-gpt-4.1-mini');

    const analyzerAgentCheckbox = harness.document.querySelector<HTMLInputElement>('#tab-settings input[type="checkbox"]');
    expect(analyzerAgentCheckbox?.checked).toBe(true);
  });

  it('renders basic mode without a request-context model selector', async () => {
    const harness = await loadHarness();

    harness.fetchMock.mockResolvedValue(jsonResponse(buildSettingsPayload({
      models: {
        requestContextMode: 'basic',
        gatherer: '',
      },
      availableModels: [],
      availableModelOptions: [],
    })));

    await harness.call<Promise<void>>('renderSettings');

    const selectedMode = harness.document.querySelector<HTMLInputElement>('#tab-settings input[name="requestContextMode"]:checked');
    expect(selectedMode?.value).toBe('basic');
    expect(harness.document.querySelector('#tab-settings label.choice-card.is-selected select')).toBeNull();
    expect(harness.document.getElementById('tab-settings')?.textContent).toContain('ui.settings.requestContextModeBasicNoModel');
    expect(harness.document.getElementById('tab-settings')?.textContent).toContain('ui.settings.noModels');
  });

  it('maps display keys to API keys in saveSetting and shows a success toast', async () => {
    const harness = await loadHarness();
    const toastSpy = vi.fn();

    (harness.window as Window & { __toastSpy?: typeof toastSpy }).__toastSpy = toastSpy;
    harness.evaluate('toast = window.__toastSpy');
    harness.fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await harness.call<Promise<void>>('saveSetting', 'ui.settings.contextReplayTtlMinutes', 45);

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ contextReplayTtlMinutes: 45 }),
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(toastSpy).toHaveBeenCalledWith('ui.settings.saved');
  });

  it('persists model selections before saving them to the API', async () => {
    const harness = await loadHarness();

    harness.fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await harness.call<Promise<void>>('saveModelSetting', 'gathererModel', 'DSK-deepseek-chat');

    expect(JSON.parse(harness.window.localStorage.getItem('ic.settings.models') || '{}')).toEqual({
      gathererModel: 'DSK-deepseek-chat',
    });
    expect(harness.fetchMock).toHaveBeenCalledWith('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ gathererModel: 'DSK-deepseek-chat' }),
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
  });

  it('re-renders settings after saving a request-context mode change', async () => {
    const harness = await loadHarness();
    const renderSettingsSpy = vi.fn(() => Promise.resolve());

    (harness.window as Window & { __renderSettingsSpy?: typeof renderSettingsSpy }).__renderSettingsSpy = renderSettingsSpy;
    harness.evaluate('renderSettings = window.__renderSettingsSpy');
    harness.fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await harness.call<Promise<void>>('saveRequestContextMode', 'selector');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ requestContextMode: 'selector' }),
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(renderSettingsSpy).toHaveBeenCalledTimes(1);
  });
});