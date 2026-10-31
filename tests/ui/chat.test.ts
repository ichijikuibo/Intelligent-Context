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

/** Build a fake SSE Response whose body streams the given `data:` events. */
function sseResponse(events: Array<Record<string, unknown> | '[DONE]'>) {
  const chunks = events.map((event) => `data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`);
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader() {
        return {
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = encoder.encode(chunks[index]);
            index += 1;
            return { done: false, value };
          },
        };
      },
    },
    json: async () => ({}),
  } as unknown as Response;
}

describe('ui/chat.js', () => {
  it('shows the select-project placeholder when no project is selected', async () => {
    const harness = await loadHarness();

    harness.evaluate('state.selectedProject = null');

    await harness.call<Promise<void>>('renderChat');

    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.document.getElementById('tab-chat')?.textContent).toContain('ui.chat.selectProjectFirst');
  });

  it('renders the chat shell and reports the configured model status', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' }], defaultModel: 'OAI-gpt-4.1' }));

    await harness.call<Promise<void>>('renderChat');

    const tab = harness.document.getElementById('tab-chat');
    expect(tab?.querySelector('#chatMessages')).not.toBeNull();
    expect(tab?.querySelector('#chatInput')).not.toBeNull();
    expect(tab?.querySelector('#chatSendBtn')).not.toBeNull();
    expect(tab?.querySelector('#chatKnowledgeBtn')).not.toBeNull();
    expect(tab?.querySelector('#chatModelSelect')).not.toBeNull();
    expect(tab?.textContent).toContain('ui.chat.title');
  });

  it('warns when no chat model is configured', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: false, model: '' }))
      .mockResolvedValueOnce(jsonResponse({ models: [], defaultModel: '' }));

    await harness.call<Promise<void>>('renderChat');

    expect(harness.document.getElementById('chatStatus')?.textContent).toContain('ui.chat.noModel');
  });

  it('lists only the models the user may chat with', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [
          { value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' },
          { value: 'DSK-deepseek-v4', label: 'deepseek-v4 [DeepSeek]' },
        ],
        defaultModel: 'OAI-gpt-4.1',
      }));

    await harness.call<Promise<void>>('renderChat');

    const select = harness.document.getElementById('chatModelSelect') as HTMLSelectElement | null;
    const optionValues = Array.from(select?.options ?? []).map((option) => option.value);
    // Empty value = "use default"; the rest are the accessible models.
    expect(optionValues).toEqual(['', 'OAI-gpt-4.1', 'DSK-deepseek-v4']);
  });

  it('disables the picker and explains when the user has no models', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [], defaultModel: '' }));

    await harness.call<Promise<void>>('renderChat');

    const select = harness.document.getElementById('chatModelSelect') as HTMLSelectElement | null;
    expect(select?.disabled).toBe(true);
    expect(select?.textContent).toContain('ui.chat.noModels');
  });

  it('escapes HTML in user messages and renders assistant markdown safely', async () => {
    const harness = await loadHarness();

    const userHtml = harness.call<string>('renderChatMessage', { role: 'user', content: '<img src=x onerror=alert(1)>' });
    expect(userHtml).not.toContain('<img');
    expect(userHtml).toContain('&lt;img');

    const assistantHtml = harness.call<string>('renderChatMessage', { role: 'assistant', content: '**bold** and `code`' });
    expect(assistantHtml).toContain('<strong>bold</strong>');
    expect(assistantHtml).toContain('<code>code</code>');
  });

  it('streams a turn from the /stream endpoint and appends deltas', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' }], defaultModel: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(sseResponse([
        { type: 'delta', content: 'Auth uses ' },
        { type: 'delta', content: 'signed tokens.' },
        { type: 'done', model: 'OAI-gpt-4.1', providerName: 'Example', internalTurnCount: 0 },
        '[DONE]',
      ]));

    await harness.call<Promise<void>>('renderChat');
    harness.evaluate("document.getElementById('chatInput').value = 'How does auth work?'");
    await harness.call<Promise<void>>('sendChatMessage');
    await harness.settle();

    const transcript = harness.document.getElementById('chatMessages')?.textContent || '';
    expect(transcript).toContain('How does auth work?');
    expect(transcript).toContain('Auth uses signed tokens.');

    const lastCall = harness.fetchMock.mock.calls[harness.fetchMock.mock.calls.length - 1];
    expect(String(lastCall?.[0])).toContain('/api/projects/project-1/chat/stream');
  });

  it('shows a tool note when the stream reports a knowledge-tool turn', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' }], defaultModel: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(sseResponse([
        { type: 'status', status: 'tool', tool: 'ic' },
        { type: 'delta', content: 'Merged the two summaries.' },
        { type: 'done', model: 'OAI-gpt-4.1', providerName: 'Example', internalTurnCount: 2 },
        '[DONE]',
      ]));

    await harness.call<Promise<void>>('renderChat');
    harness.evaluate("document.getElementById('chatInput').value = 'Merge summaries'");
    await harness.call<Promise<void>>('sendChatMessage');
    await harness.settle();

    const transcript = harness.document.getElementById('chatMessages')?.textContent || '';
    expect(transcript).toContain('Merged the two summaries.');
    expect(transcript).toContain('ui.chat.usedTools');
  });

  it('surfaces a stream error event without dropping the user turn', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' }], defaultModel: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(sseResponse([
        { type: 'error', error: 'The chat request failed.' },
        '[DONE]',
      ]));

    await harness.call<Promise<void>>('renderChat');
    harness.evaluate("document.getElementById('chatInput').value = 'hello'");
    await harness.call<Promise<void>>('sendChatMessage');
    await harness.settle();

    const transcript = harness.document.getElementById('chatMessages')?.textContent || '';
    expect(transcript).toContain('hello');
    expect(transcript).toContain('The chat request failed.');
  });

  it('surfaces a non-OK stream response as an error', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' }], defaultModel: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'The chat request failed.' }, { ok: false, status: 502, statusText: 'Bad Gateway' }));

    await harness.call<Promise<void>>('renderChat');
    harness.evaluate("document.getElementById('chatInput').value = 'hello'");
    await harness.call<Promise<void>>('sendChatMessage');
    await harness.settle();

    const transcript = harness.document.getElementById('chatMessages')?.textContent || '';
    expect(transcript).toContain('The chat request failed.');
  });

  it('loads knowledge options and attaches a summary to the next message', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' })) // status
      .mockResolvedValueOnce(jsonResponse({ models: [{ value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' }], defaultModel: 'OAI-gpt-4.1' })) // models
      .mockResolvedValueOnce(jsonResponse({ // context-options
        summaries: [{ id: 'sum-1', title: 'Auth summary', oneLineSummary: 'Tokens', updatedAt: '2026-01-01' }],
        findings: [],
        files: [],
      }))
      .mockResolvedValueOnce(sseResponse([
        { type: 'delta', content: 'Done.' },
        { type: 'done', model: 'OAI-gpt-4.1', providerName: 'Example', internalTurnCount: 0 },
        '[DONE]',
      ]));

    await harness.call<Promise<void>>('renderChat');
    await harness.call<Promise<void>>('openChatKnowledgeDialog');

    const body = harness.document.getElementById('chatKnowledgeBody');
    expect(body?.textContent).toContain('Auth summary');

    // Simulate checking the summary checkbox.
    harness.call('toggleChatKnowledge', 'summary', 'sum-1', { checked: true });

    expect(harness.evaluate<Array<{ id: string }>>('chatState.knowledge')).toEqual([
      expect.objectContaining({ type: 'summary', id: 'sum-1' }),
    ]);

    harness.evaluate("document.getElementById('chatInput').value = 'Explain this'");
    await harness.call<Promise<void>>('sendChatMessage');
    await harness.settle();

    const lastCall = harness.fetchMock.mock.calls[harness.fetchMock.mock.calls.length - 1];
    const payload = JSON.parse(String(lastCall?.[1]?.body));
    expect(payload.messages[0].knowledge).toEqual([{ type: 'summary', id: 'sum-1' }]);
  });

  it('clears the transcript and persists it per project', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.evaluate("chatState.messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]");

    harness.call('clearChat');

    expect(harness.evaluate<unknown[]>('chatState.messages')).toEqual([]);
    const stored = harness.window.localStorage.getItem('ic.chat.project-1');
    expect(stored).toBe('[]');
  });

  it('filters knowledge options by type and by free-text search', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' })) // status
      .mockResolvedValueOnce(jsonResponse({ models: [], defaultModel: '' })) // models
      .mockResolvedValueOnce(jsonResponse({ // context-options
        summaries: [
          { id: 'sum-1', title: 'Auth summary', oneLineSummary: 'Tokens' },
          { id: 'sum-2', title: 'Billing summary', oneLineSummary: 'Invoices' },
        ],
        findings: [{ id: 'find-1', title: 'Dup summaries', type: 'refactor', severity: 'medium', status: 'open' }],
        files: [{ id: 'file-1', fileName: 'src/auth.ts', purpose: 'Auth', chunkCount: 1, summaryCount: 1 }],
      }));

    await harness.call<Promise<void>>('renderChat');
    await harness.call<Promise<void>>('openChatKnowledgeDialog');

    const body = harness.document.getElementById('chatKnowledgeBody');
    // All three sections show by default.
    expect(body?.textContent).toContain('Auth summary');
    expect(body?.textContent).toContain('Billing summary');
    expect(body?.textContent).toContain('Dup summaries');
    expect(body?.textContent).toContain('src/auth.ts');

    // Unchecking a type hides that whole section.
    harness.call('onChatKnowledgeTypeToggle', 'finding', false);
    expect(body?.textContent).not.toContain('Dup summaries');
    expect(body?.textContent).toContain('Auth summary');

    // Re-check, then search: only matching entities remain.
    harness.call('onChatKnowledgeTypeToggle', 'finding', true);
    harness.call('onChatKnowledgeSearch', 'billing');
    expect(body?.textContent).toContain('Billing summary');
    expect(body?.textContent).not.toContain('Auth summary');
    expect(body?.textContent).not.toContain('Dup summaries');

    // A search with no matches shows the empty message.
    harness.call('onChatKnowledgeSearch', 'zzzzz');
    expect(body?.textContent).toContain('ui.chat.knowledgeNoMatches');
  });

  it('keeps a selected entity attached when it is filtered out of view', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [], defaultModel: '' }))
      .mockResolvedValueOnce(jsonResponse({
        summaries: [{ id: 'sum-1', title: 'Auth summary', oneLineSummary: 'Tokens' }],
        findings: [],
        files: [],
      }));

    await harness.call<Promise<void>>('renderChat');
    await harness.call<Promise<void>>('openChatKnowledgeDialog');

    harness.call('toggleChatKnowledge', 'summary', 'sum-1', { checked: true });
    harness.call('onChatKnowledgeTypeToggle', 'summary', false);

    // The selection survives the filter change.
    expect(harness.evaluate<Array<{ id: string }>>('chatState.knowledge')).toEqual([
      expect.objectContaining({ type: 'summary', id: 'sum-1' }),
    ]);
  });

  it('sends the selected model with the turn and persists the choice', async () => {
    const harness = await loadHarness();

    harness.evaluate("state.selectedProject = 'project-1'");
    harness.fetchMock
      .mockResolvedValueOnce(jsonResponse({ configured: true, model: 'OAI-gpt-4.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [
          { value: 'OAI-gpt-4.1', label: 'gpt-4.1 [OpenAI]' },
          { value: 'DSK-deepseek-v4', label: 'deepseek-v4 [DeepSeek]' },
        ],
        defaultModel: 'OAI-gpt-4.1',
      }))
      .mockResolvedValueOnce(sseResponse([
        { type: 'delta', content: 'ok' },
        { type: 'done', model: 'DSK-deepseek-v4', providerName: 'DeepSeek', internalTurnCount: 0 },
        '[DONE]',
      ]));

    await harness.call<Promise<void>>('renderChat');
    harness.call('onChatModelChange', 'DSK-deepseek-v4');
    harness.evaluate("document.getElementById('chatInput').value = 'hello'");
    await harness.call<Promise<void>>('sendChatMessage');
    await harness.settle();

    const lastCall = harness.fetchMock.mock.calls[harness.fetchMock.mock.calls.length - 1];
    const payload = JSON.parse(String(lastCall?.[1]?.body));
    expect(payload.model).toBe('DSK-deepseek-v4');
    expect(harness.window.localStorage.getItem('ic.chat.model.project-1')).toBe('DSK-deepseek-v4');
  });
});
