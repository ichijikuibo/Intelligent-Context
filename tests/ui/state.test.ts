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

describe('ui/state.js', () => {
  it('normalizes structured model options and fills missing label/model values', async () => {
    const harness = await loadHarness();

    const result = harness.call<Array<{ value: string; label: string; model: string }>>(
      'normalizeAvailableModelOptions',
      ['unused-model'],
      [
        { value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]', model: 'gpt-4.1' },
        { value: 'ANTH-claude-3.7', label: '', model: '' },
        null,
        { label: 'missing value' },
      ],
    );

    expect(result).toEqual([
      { value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]', model: 'gpt-4.1' },
      { value: 'ANTH-claude-3.7', label: 'ANTH-claude-3.7', model: 'ANTH-claude-3.7' },
    ]);
  });

  it('falls back to raw model ids when explicit model options are unavailable', async () => {
    const harness = await loadHarness();

    const result = harness.call<Array<{ value: string; label: string; model: string }>>(
      'normalizeAvailableModelOptions',
      ['OAI-gpt-4.1', '', null, 'ANTH-claude-3.7'],
      undefined,
    );

    expect(result).toEqual([
      { value: 'OAI-gpt-4.1', label: 'OAI-gpt-4.1', model: 'OAI-gpt-4.1' },
      { value: 'ANTH-claude-3.7', label: 'ANTH-claude-3.7', model: 'ANTH-claude-3.7' },
    ]);
  });

  it('resolves persisted legacy model ids to provider-scoped model values', async () => {
    const harness = await loadHarness();

    harness.window.localStorage.setItem('ic.settings.models', JSON.stringify({
      gathererModel: 'deepseek-chat',
    }));

    const result = harness.call<string>(
      'getPersistedSettingsModel',
      'gathererModel',
      '',
      [
        { value: 'DSK-deepseek-chat', label: 'deepseek-chat [DeepSeek]', model: 'deepseek-chat' },
        { value: 'OAI-gpt-4.1-mini', label: 'gpt-4.1-mini [OpenAI]', model: 'gpt-4.1-mini' },
      ],
    );

    expect(result).toBe('DSK-deepseek-chat');
  });

  it('removes cleared settings values from persisted storage', async () => {
    const harness = await loadHarness();

    harness.window.localStorage.setItem('ic.settings.models', JSON.stringify({
      gathererModel: 'DSK-deepseek-chat',
      summarizerModel: 'OAI-gpt-4.1-mini',
    }));

    harness.call('storeSettingsModel', 'gathererModel', '');

    expect(JSON.parse(harness.window.localStorage.getItem('ic.settings.models') || '{}')).toEqual({
      summarizerModel: 'OAI-gpt-4.1-mini',
    });
  });
});