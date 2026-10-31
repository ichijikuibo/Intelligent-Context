/**
 * Tests for the VS Code extension's proxy client.
 *
 * These live in the main repo's suite because `proxyClient.ts` deliberately has
 * no `vscode` import, so it can be exercised without the extension host. The
 * tests pin the wire contract the proxy serves to IDE extensions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// modelRegistry reads configuration through the VS Code API; stub the slice it
// touches so the pure resolution helpers can be tested outside the extension host.
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  EventEmitter: class {
    private readonly listeners = new Set<() => void>();
    event = (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire = () => {
      for (const listener of this.listeners) listener();
    };
    dispose = () => this.listeners.clear();
  },
}));

import {
  buildChatUrl,
  buildModelsUrl,
  listModels,
  ProxyClientError,
  streamChat,
} from '../../vscode-extension/src/proxyClient';
import {
  findModelEntry,
  resolveWireModel,
} from '../../vscode-extension/src/modelRegistry';
import type { ChatRequest, ProxyModelEntry, StreamChunk } from '../../vscode-extension/src/types';

describe('buildModelsUrl', () => {
  it('appends /v1/models to a bare base URL', () => {
    expect(buildModelsUrl('http://localhost:1234')).toBe('http://localhost:1234/v1/models');
  });

  it('does not duplicate /v1 when the base URL already ends with it', () => {
    expect(buildModelsUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1/models');
    expect(buildModelsUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/models');
  });
});

describe('buildChatUrl', () => {
  it('targets /v1/chat/completions for OpenAI-format models', () => {
    expect(buildChatUrl('http://localhost:1234', 'openai')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
  });

  it('targets /v1/messages for Anthropic-format models', () => {
    expect(buildChatUrl('http://localhost:1234', 'anthropic')).toBe(
      'http://localhost:1234/v1/messages',
    );
  });

  it('tolerates a base URL that already includes /v1', () => {
    expect(buildChatUrl('http://localhost:1234/v1', 'openai')).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
    expect(buildChatUrl('http://localhost:1234/v1', 'anthropic')).toBe(
      'http://localhost:1234/v1/messages',
    );
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: string[]): Response {
  return new Response(sseStream(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Model resolution helpers ───────────────────────────────────────────────

describe('resolveWireModel', () => {
  it('prefers the provider-scoped id over the display label', () => {
    const entry: ProxyModelEntry = {
      id: 'CCO-deepseek-v4',
      model_id: 'deepseek-v4',
      display_name: 'CommandCode (OpenAI) \u00b7 deepseek-v4',
    };

    expect(resolveWireModel(entry)).toBe('CCO-deepseek-v4');
  });

  it('falls back to the raw model id, then to empty', () => {
    expect(resolveWireModel({ id: '', model_id: 'deepseek-v4' })).toBe('deepseek-v4');
    expect(resolveWireModel({ id: '' })).toBe('');
  });
});

describe('findModelEntry', () => {
  const models: ProxyModelEntry[] = [
    {
      id: 'OCO-deepseek-v4',
      model_id: 'deepseek-v4',
      display_name: 'opencode Go \u00b7 deepseek-v4',
    },
    {
      id: 'CCO-deepseek-v4',
      model_id: 'deepseek-v4',
      display_name: 'CommandCode (OpenAI) \u00b7 deepseek-v4',
    },
  ];

  it('resolves an exact scoped id to the right provider\'s entry', () => {
    // This is the property that makes duplicate model IDs work: the same raw
    // model from two providers must resolve to distinct entries.
    expect(findModelEntry(models, 'CCO-deepseek-v4')?.display_name).toBe(
      'CommandCode (OpenAI) \u00b7 deepseek-v4',
    );
    expect(findModelEntry(models, 'OCO-deepseek-v4')?.display_name).toBe(
      'opencode Go \u00b7 deepseek-v4',
    );
  });

  it('falls back to the raw model id when the scoped id changed', () => {
    // Simulates a re-sync that altered the provider prefix.
    expect(findModelEntry(models, 'deepseek-v4')?.model_id).toBe('deepseek-v4');
  });

  it('falls back to the display label for a stale selection', () => {
    expect(findModelEntry(models, 'opencode Go \u00b7 deepseek-v4')?.id).toBe(
      'OCO-deepseek-v4',
    );
  });

  it('returns undefined for an unknown model', () => {
    expect(findModelEntry(models, 'nonexistent')).toBeUndefined();
  });
});

// ── listModels ─────────────────────────────────────────────────────────────

describe('listModels', () => {
  it('parses the enriched proxy catalog', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'DSK-deepseek-chat',
            object: 'model',
            owned_by: 'DeepSeek',
            provider_type: 'openai',
            provider_name: 'DeepSeek',
            provider_id: 'p1',
            base_url: 'https://api.deepseek.com/v1',
            api_format: 'openai',
            context_window: 128000,
            max_input_tokens: 123500,
            max_output_tokens: 4000,
            display_name: 'deepseek-chat',
          },
          {
            id: 'ANTH-claude-3-5-sonnet',
            api_format: 'anthropic',
            provider_name: 'Anthropic',
            display_name: 'claude-3-5-sonnet',
            context_window: 200000,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const models = await listModels('http://localhost:1234', 'secret-key');

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'DSK-deepseek-chat',
      api_format: 'openai',
      max_input_tokens: 123500,
    });
    expect(models[1]).toMatchObject({ api_format: 'anthropic' });
  });

  it('parses the provider-prefixed display name and raw model ID', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'OCO-deepseek-v4',
            provider_name: 'opencode Go',
            display_name: 'opencode Go \u00b7 deepseek-v4',
            model_id: 'deepseek-v4',
          },
          {
            id: 'CCO-deepseek-v4',
            provider_name: 'CommandCode (OpenAI)',
            display_name: 'CommandCode (OpenAI) \u00b7 deepseek-v4',
            model_id: 'deepseek-v4',
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const models = await listModels('http://localhost:1234', 'secret-key');

    // Identically-named models stay distinguishable by their labels.
    expect(models.map((m) => m.display_name)).toEqual([
      'opencode Go \u00b7 deepseek-v4',
      'CommandCode (OpenAI) \u00b7 deepseek-v4',
    ]);
    // Both still report the same raw upstream model.
    expect(models.map((m) => m.model_id)).toEqual(['deepseek-v4', 'deepseek-v4']);
  });

  it('sends the API key as a bearer token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ object: 'list', data: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await listModels('http://localhost:1234', 'secret-key');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:1234/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    );
  });

  it('omits the Authorization header when no key is configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ object: 'list', data: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await listModels('http://localhost:1234', undefined);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('surfaces a helpful error and never leaks the API key', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: 'Invalid API key.' } }, 401),
    ) as unknown as typeof fetch;

    await expect(listModels('http://localhost:1234', 'super-secret-key')).rejects.toThrow(
      /Invalid API key/,
    );

    try {
      await listModels('http://localhost:1234', 'super-secret-key');
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-key');
    }
  });

  it('rejects an unexpected payload shape with an actionable message', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ models: [] })) as unknown as typeof fetch;

    await expect(listModels('http://localhost:1234', undefined)).rejects.toBeInstanceOf(
      ProxyClientError,
    );
  });

  it('explains an unreachable proxy', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(listModels('http://localhost:9999', undefined)).rejects.toThrow(
      /Could not reach the Intelligent Context proxy/,
    );
  });
});

// ── streamChat ─────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'deepseek-chat',
    apiFormat: 'openai',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    toolMode: 'auto',
    headers: {},
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('streamChat (OpenAI format)', () => {
  it('emits text deltas and assembles streamed tool calls', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ic_list_chunks","arguments":"{\\"lim"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"it\\":5}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat('http://localhost:1234', undefined, makeRequest(), (chunk) => chunks.push(chunk));

    const text = chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.value).join('');
    expect(text).toBe('Hi there');

    const toolCall = chunks.find((chunk) => chunk.type === 'toolCall');
    expect(toolCall).toMatchObject({
      id: 'call_1',
      name: 'ic_list_chunks',
      arguments: '{"limit":5}',
    });
  });

  it('handles SSE events split across transport chunks', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split a single event mid-JSON across two reads.
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"con'));
        controller.enqueue(encoder.encode('tent":"split"}}]}\n\n'));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat('http://localhost:1234', undefined, makeRequest(), (chunk) => chunks.push(chunk));

    expect(chunks).toContainEqual({ type: 'text', value: 'split' });
  });

  it('sends workspace headers and an OpenAI-shaped body', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await streamChat(
      'http://localhost:1234',
      'secret-key',
      makeRequest({
        headers: {
          'X-Project-Root': 'C:\\repo',
          'X-IC-Project-Name': 'repo',
          'X-IC-Branch': 'main',
        },
      }),
      () => undefined,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret-key',
      'X-Project-Root': 'C:\\repo',
      'X-IC-Project-Name': 'repo',
      'X-IC-Branch': 'main',
    });

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'deepseek-chat', stream: true });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('sends the provider-scoped model and never the display label as the wire model', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const entry = {
      id: 'CCO-deepseek-v4',
      model_id: 'deepseek-v4',
      display_name: 'CommandCode (OpenAI) \u00b7 deepseek-v4',
    };

    await streamChat(
      'http://localhost:1234',
      undefined,
      makeRequest({ model: resolveWireModel(entry) }),
      () => undefined,
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // The scoped ID carries the provider hint; the label must never be sent.
    expect(body.model).toBe('CCO-deepseek-v4');
    expect(body.model).not.toBe(entry.display_name);
  });

  it('propagates an upstream error embedded in the SSE stream', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse(['data: {"error":{"message":"Upstream 429"}}\n\n']),
    ) as unknown as typeof fetch;

    await expect(
      streamChat('http://localhost:1234', undefined, makeRequest(), () => undefined),
    ).rejects.toThrow(/Upstream 429/);
  });

  it('reports a non-OK HTTP status with the server detail', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: 'No AI providers configured.' } }, 502),
    ) as unknown as typeof fetch;

    await expect(
      streamChat('http://localhost:1234', undefined, makeRequest(), () => undefined),
    ).rejects.toThrow(/No AI providers configured/);
  });
});

describe('streamChat (Anthropic format)', () => {
  it('posts to /v1/messages and reassembles tool_use input fragments', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Looking"}}\n\n',
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"ic_get_chunk"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"id\\":"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"abc\\"}"}}\n\n',
        'data: {"type":"content_block_stop"}\n\n',
      ]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat(
      'http://localhost:1234',
      undefined,
      makeRequest({ apiFormat: 'anthropic' }),
      (chunk) => chunks.push(chunk),
    );

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'http://localhost:1234/v1/messages',
    );
    expect(chunks).toContainEqual({ type: 'text', value: 'Looking' });
    expect(chunks).toContainEqual({
      type: 'toolCall',
      id: 'toolu_1',
      name: 'ic_get_chunk',
      arguments: '{"id":"abc"}',
    });
  });

  it('hoists system messages out of the message list', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: {"type":"message_stop"}\n\n']));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await streamChat(
      'http://localhost:1234',
      undefined,
      makeRequest({
        apiFormat: 'anthropic',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'hello' },
        ],
      }),
      () => undefined,
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toBe('Be concise.');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

// ── reasoning isolation ────────────────────────────────────────────────────
//
// Reasoning must arrive as its own `reasoning` chunk. Emitting it as `text`
// pushes the model's chain of thought into the main chat feed, because the
// provider maps every `text` chunk to a `LanguageModelTextPart`.

describe('streamChat reasoning isolation', () => {
  it('reports OpenAI reasoning_content as reasoning, never as text', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"Let me "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"think."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat('http://localhost:1234', undefined, makeRequest(), (chunk) => chunks.push(chunk));

    expect(chunks.filter((chunk) => chunk.type === 'reasoning')).toEqual([
      { type: 'reasoning', value: 'Let me ' },
      { type: 'reasoning', value: 'think.' },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([
      { type: 'text', value: 'Answer' },
    ]);
  });

  it('also reads the `reasoning` delta field', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat('http://localhost:1234', undefined, makeRequest(), (chunk) => chunks.push(chunk));

    expect(chunks).toContainEqual({ type: 'reasoning', value: 'pondering' });
  });

  it('maps Anthropic thinking_delta blocks to reasoning', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"weighing options"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    ) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat(
      'http://localhost:1234',
      undefined,
      makeRequest({ apiFormat: 'anthropic' }),
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toContainEqual({ type: 'reasoning', value: 'weighing options' });
    expect(chunks).toContainEqual({ type: 'text', value: 'Done' });
  });
});

// ── late reasoning deferral ────────────────────────────────────────────────
//
// Reasoning that arrives *after* the answer has started streaming must not be
// interleaved with the visible text. VS Code only merges consecutive text parts
// while nothing sits between them, so a thinking part landing mid-answer splits
// the reply into two markdown parts; the completed-response renderer then keeps
// only the last part visible and folds the beginning into the collapsed
// "Completed N steps" disclosure (microsoft/vscode#338143).

describe('streamChat late-reasoning deferral', () => {
  it('replays OpenAI reasoning that arrives after the answer has started', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"The answer "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"late thought"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"continues."}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat('http://localhost:1234', undefined, makeRequest(), (chunk) => chunks.push(chunk));

    // Text stays contiguous; the late reasoning is replayed at the end of the turn.
    expect(chunks).toEqual([
      { type: 'text', value: 'The answer ' },
      { type: 'text', value: 'continues.' },
      { type: 'reasoning', value: 'late thought' },
    ]);
  });

  it('replays held-back reasoning before a trailing OpenAI tool call', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Checking."}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"mid-turn thought"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ic_list_chunks","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat('http://localhost:1234', undefined, makeRequest(), (chunk) => chunks.push(chunk));

    expect(chunks.map((chunk) => chunk.type)).toEqual(['text', 'reasoning', 'toolCall']);
  });

  it('defers Anthropic thinking that arrives after the answer has started', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yes, connected "}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"late thought"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"and working."}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    ) as unknown as typeof fetch;

    const chunks: StreamChunk[] = [];
    await streamChat(
      'http://localhost:1234',
      undefined,
      makeRequest({ apiFormat: 'anthropic' }),
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual([
      { type: 'text', value: 'Yes, connected ' },
      { type: 'text', value: 'and working.' },
      { type: 'reasoning', value: 'late thought' },
    ]);
  });
});
