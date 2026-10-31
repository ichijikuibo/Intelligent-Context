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

describe('ui/providers.js', () => {
  it('renders local providers, filters external ones, and primes the default add-form URL', async () => {
    const harness = await loadHarness();

    harness.fetchMock.mockResolvedValue(jsonResponse([
      {
        id: 'provider-1',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        shortPrefix: 'OAI',
        models: 'gpt-4.1-mini',
        apiKey: 'configured',
        isEnabled: true,
        isDefault: true,
      },
      {
        id: 'provider-2',
        name: 'Managed Externally',
        type: 'openai',
        baseUrl: 'https://example.test/v1',
        shortPrefix: 'EXT',
        models: 'ext-model',
        apiKey: 'configured',
        isEnabled: true,
        isDefault: false,
        externalProviderId: 'external-1',
      },
    ]));

    await harness.call<Promise<void>>('renderProviders');

    const tabText = harness.document.getElementById('tab-providers')?.textContent || '';
    expect(tabText).toContain('OpenAI');
    expect(tabText).not.toContain('Managed Externally');
    expect((harness.document.getElementById('f_url') as HTMLInputElement | null)?.value).toBe('https://api.openai.com/v1');
  });

  it('creates a provider with the expected payload and rerenders on success', async () => {
    const harness = await loadHarness();
    const renderProvidersSpy = vi.fn(() => Promise.resolve());
    const toastSpy = vi.fn();

    harness.fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await harness.call<Promise<void>>('renderProviders');

    (harness.window as Window & { __renderProvidersSpy?: typeof renderProvidersSpy }).__renderProvidersSpy = renderProvidersSpy;
    (harness.window as Window & { __toastSpy?: typeof toastSpy }).__toastSpy = toastSpy;
    harness.evaluate('renderProviders = window.__renderProvidersSpy');
    harness.evaluate('toast = window.__toastSpy');

    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    (harness.document.getElementById('f_name') as HTMLInputElement).value = 'Anthropic';
    (harness.document.getElementById('f_type') as HTMLSelectElement).value = 'anthropic';
    (harness.document.getElementById('f_url') as HTMLInputElement).value = 'https://api.anthropic.com';
    (harness.document.getElementById('f_key') as HTMLInputElement).value = 'secret-key';
    (harness.document.getElementById('f_shortPrefix') as HTMLInputElement).value = 'ANTH';
    (harness.document.getElementById('f_model') as HTMLInputElement).value = 'claude-sonnet-4';

    await harness.call<Promise<void>>('addProvider');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/providers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Anthropic',
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'secret-key',
        shortPrefix: 'ANTH',
        models: 'claude-sonnet-4',
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(toastSpy).toHaveBeenCalledWith('ui.providers.added');
    expect(renderProvidersSpy).toHaveBeenCalledTimes(1);
  });

  it('omits a blank apiKey when saving an edited provider and rerenders on success', async () => {
    const harness = await loadHarness();
    const renderProvidersSpy = vi.fn(() => Promise.resolve());
    const toastSpy = vi.fn();

    harness.fetchMock.mockResolvedValueOnce(jsonResponse([
      {
        id: 'provider-1',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        shortPrefix: 'OAI',
        models: 'gpt-4.1-mini',
        apiKey: 'configured',
        isEnabled: true,
        isDefault: false,
      },
    ]));
    await harness.call<Promise<void>>('renderProviders');

    (harness.window as Window & { __renderProvidersSpy?: typeof renderProvidersSpy }).__renderProvidersSpy = renderProvidersSpy;
    (harness.window as Window & { __toastSpy?: typeof toastSpy }).__toastSpy = toastSpy;
    harness.evaluate('renderProviders = window.__renderProvidersSpy');
    harness.evaluate('toast = window.__toastSpy');

    harness.fetchMock.mockClear();
    harness.fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    harness.call('toggleEditPanel', 'ep_provider1');
    (harness.document.getElementById('ep_provider1_name') as HTMLInputElement).value = 'OpenAI Updated';
    (harness.document.getElementById('ep_provider1_url') as HTMLInputElement).value = 'https://api.openai.com/v1';
    (harness.document.getElementById('ep_provider1_shortPrefix') as HTMLInputElement).value = 'OAI';
    (harness.document.getElementById('ep_provider1_model') as HTMLInputElement).value = 'gpt-4.1-mini,gpt-4.1';
    (harness.document.getElementById('ep_provider1_key') as HTMLInputElement).value = '';

    await harness.call<Promise<void>>('saveEdit', 'provider-1', 'ep_provider1');

    expect(harness.fetchMock).toHaveBeenCalledWith('/api/providers/provider-1', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'OpenAI Updated',
        baseUrl: 'https://api.openai.com/v1',
        shortPrefix: 'OAI',
        models: 'gpt-4.1-mini,gpt-4.1',
      }),
      headers: {
        'Content-Type': 'application/json',
        'X-IC-Locale': 'en',
      },
      credentials: 'same-origin',
    });
    expect(toastSpy).toHaveBeenCalledWith('ui.providers.updated');
    expect(renderProvidersSpy).toHaveBeenCalledTimes(1);
  });
});