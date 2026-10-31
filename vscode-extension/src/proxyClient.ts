/**
 * HTTP client for the Intelligent Context proxy.
 *
 * Two responsibilities:
 *   1. Fetch the enriched model catalog from `/v1/models`.
 *   2. Stream a chat completion from `/v1/chat/completions` (OpenAI format) or
 *      `/v1/messages` (Anthropic format), normalising both into `StreamChunk`s.
 */
import type {
  CancellationTokenLike,
  ChatRequest,
  ChatRequestMessage,
  ProxyModelEntry,
  StreamChunk,
} from './types';
export class ProxyClientError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProxyClientError';
    this.status = status;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Build the model-list URL. `/v1/models` is the canonical proxy route. */
export function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  // Tolerate a base URL that already ends in /v1.
  return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

/** Build a chat URL for the given wire protocol. */
export function buildChatUrl(baseUrl: string, apiFormat: 'openai' | 'anthropic'): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const hasV1 = trimmed.endsWith('/v1');
  const root = hasV1 ? trimmed.slice(0, -3) : trimmed;
  return apiFormat === 'anthropic'
    ? joinUrl(root, '/v1/messages')
    : joinUrl(root, '/v1/chat/completions');
}

/**
 * Fetch the proxy's model catalog.
 * Throws `ProxyClientError` with a human-readable message on any failure.
 */
export async function listModels(
  baseUrl: string,
  apiKey: string | undefined,
  token?: CancellationTokenLike,
): Promise<ProxyModelEntry[]> {
  const url = buildModelsUrl(baseUrl);
  const controller = new AbortController();
  const subscription = token?.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(apiKey),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ProxyClientError(await describeFailure('model list', response), response.status);
    }

    const payload = (await response.json()) as { data?: ProxyModelEntry[] };
    if (!payload || !Array.isArray(payload.data)) {
      throw new ProxyClientError(
        'The proxy returned an unexpected model list. Expected an OpenAI-style { "data": [...] } payload.',
      );
    }

    return payload.data;
  } catch (error) {
    throw toClientError(error, url);
  } finally {
    subscription?.dispose();
  }
}

/**
 * Stream a chat request from the proxy, invoking `onChunk` for each incremental
 * piece of output. Resolves once the stream ends.
 */
export async function streamChat(
  baseUrl: string,
  apiKey: string | undefined,
  request: ChatRequest,
  onChunk: (chunk: StreamChunk) => void,
  token?: CancellationTokenLike,
): Promise<void> {
  const url = buildChatUrl(baseUrl, request.apiFormat);
  const controller = new AbortController();
  const subscription = token?.onCancellationRequested(() => controller.abort());
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

  const body =
    request.apiFormat === 'anthropic'
      ? buildAnthropicBody(request)
      : buildOpenAiBody(request);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(apiKey),
        ...request.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ProxyClientError(await describeFailure('chat request', response), response.status);
    }

    if (!response.body) {
      throw new ProxyClientError('The proxy returned an empty response body.');
    }

    if (request.apiFormat === 'anthropic') {
      await readAnthropicStream(response.body, onChunk);
    } else {
      await readOpenAiStream(response.body, onChunk);
    }
  } catch (error) {
    throw toClientError(error, url);
  } finally {
    clearTimeout(timeout);
    subscription?.dispose();
  }
}

// ── Request shaping ────────────────────────────────────────────────────────

/** The plain-text portion of a message's content. */
function textOf(content: ChatRequestMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function buildOpenAiBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    messages: request.messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.content,
        };
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }

      return { role: message.role, content: message.content };
    }),
  };

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    if (request.toolMode === 'required') {
      body.tool_choice = 'required';
    } else if (request.toolMode === 'auto') {
      body.tool_choice = 'auto';
    }
  }

  return body;
}

function buildAnthropicBody(request: ChatRequest): Record<string, unknown> {
  const systemParts = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .filter((content) => content.trim().length > 0);

  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: message.content,
            },
          ],
        };
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        const blocks: Array<Record<string, unknown>> = [];
        const text = textOf(message.content);
        if (text.trim()) {
          blocks.push({ type: 'text', text });
        }
        for (const call of message.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: safeParseJson(call.arguments),
          });
        }
        return { role: 'assistant', content: blocks };
      }

      return { role: message.role, content: message.content };
    });

  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    max_tokens: 4096,
    messages,
  };

  if (systemParts.length > 0) {
    body.system = systemParts.join('\n\n');
  }

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    if (request.toolMode === 'required') {
      body.tool_choice = { type: 'any' };
    } else if (request.toolMode === 'auto') {
      body.tool_choice = { type: 'auto' };
    }
  }

  return body;
}

function safeParseJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

// ── SSE parsing ────────────────────────────────────────────────────────────

/**
 * Read an SSE byte stream, yielding each `data:` payload as a string.
 * Handles chunk boundaries that split events mid-line.
 */
async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith('data:')) continue;
          yield trimmed.slice(5).trim();
        }
      }
    }

    // Flush any trailing event that arrived without a terminating blank line.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      yield tail.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Reasoning models sometimes flush chain-of-thought (`reasoning_content` for
 * OpenAI-format APIs, `thinking_delta` for Anthropic) *after* the visible
 * answer has started streaming.
 *
 * VS Code only merges consecutive text parts while nothing sits between them,
 * so a thinking part landing mid-answer splits the assistant's reply into two
 * separate markdown parts. The completed-response renderer then treats only the
 * last part as the "final response" and folds the rest into the collapsed
 * "Completed N steps" disclosure, which visibly cuts the answer in half
 * (microsoft/vscode#338143).
 *
 * Once visible text has been emitted, hold late reasoning back and replay it at
 * the end of the turn instead. Nothing is lost, and the answer stays one
 * contiguous markdown block that the disclosure keeps fully visible.
 */
function createReasoningGate(onChunk: (chunk: StreamChunk) => void): {
  markTextStarted(): void;
  push(value: string): void;
  flush(): void;
} {
  let textStarted = false;
  const deferred: string[] = [];

  return {
    markTextStarted(): void {
      textStarted = true;
    },
    push(value: string): void {
      if (textStarted) {
        deferred.push(value);
      } else {
        onChunk({ type: 'reasoning', value });
      }
    },
    flush(): void {
      if (deferred.length === 0) return;
      onChunk({ type: 'reasoning', value: deferred.join('') });
      deferred.length = 0;
    },
  };
}

async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  // Accumulate tool-call fragments by index; OpenAI streams them incrementally.
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const reasoningGate = createReasoningGate(onChunk);

  for await (const data of readSseData(body)) {
    if (!data || data === '[DONE]') continue;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    if (parsed?.error) {
      throw new ProxyClientError(String(parsed.error?.message ?? 'Upstream provider returned an error.'));
    }

    const choice = parsed?.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      reasoningGate.markTextStarted();
      onChunk({ type: 'text', value: delta.content });
    }

    // Reasoning models stream their chain of thought in a dedicated field
    // (`reasoning_content` for DeepSeek-style APIs, `reasoning` for others).
    // Keep it as a `reasoning` chunk so the provider can render it in the
    // collapsible thinking section instead of the main chat feed. Reasoning
    // that arrives after the answer has started is deferred by the gate so it
    // cannot split the answer into multiple markdown parts.
    for (const reasoningDelta of [delta.reasoning_content, delta.reasoning]) {
      if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
        reasoningGate.push(reasoningDelta);
      }
    }

    for (const call of delta.tool_calls ?? []) {
      const index = typeof call.index === 'number' ? call.index : 0;
      const existing = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.name = call.function.name;
      if (typeof call.function?.arguments === 'string') existing.arguments += call.function.arguments;
      toolCalls.set(index, existing);
    }

    if (parsed.usage) {
      onChunk({
        type: 'usage',
        inputTokens: parsed.usage.prompt_tokens,
        outputTokens: parsed.usage.completion_tokens,
      });
    }
  }

  // Replay any reasoning held back while the answer streamed. Emitting it here
  // keeps the visible text contiguous and leaves the tool call as the last item
  // of the turn, matching the upstream ordering.
  reasoningGate.flush();

  for (const call of toolCalls.values()) {
    if (!call.name) continue;
    onChunk({
      type: 'toolCall',
      id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: call.name,
      arguments: call.arguments || '{}',
    });
  }
}

async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  // Track the in-progress content block so tool_use inputs can be reassembled
  // from their JSON fragments.
  let currentTool: { id: string; name: string; json: string } | undefined;
  const reasoningGate = createReasoningGate(onChunk);

  for await (const data of readSseData(body)) {
    if (!data) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    switch (parsed?.type) {
      case 'content_block_delta': {
        const delta = parsed.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          reasoningGate.markTextStarted();
          onChunk({ type: 'text', value: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          reasoningGate.push(delta.thinking);
        } else if (delta.type === 'input_json_delta' && currentTool) {
          currentTool.json += delta.partial_json ?? '';
        }
        break;
      }
      case 'content_block_start': {
        const block = parsed.content_block ?? {};
        if (block.type === 'tool_use') {
          currentTool = { id: block.id ?? '', name: block.name ?? '', json: '' };
        }
        break;
      }
      case 'content_block_stop': {
        if (currentTool && currentTool.name) {
          // Replay held-back reasoning before the tool call so the answer text
          // stays contiguous and the tool call remains the last item.
          reasoningGate.flush();
          onChunk({
            type: 'toolCall',
            id: currentTool.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            name: currentTool.name,
            arguments: currentTool.json || '{}',
          });
        }
        currentTool = undefined;
        break;
      }
      case 'message_delta': {
        if (parsed.usage) {
          onChunk({
            type: 'usage',
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
          });
        }
        break;
      }
      case 'error': {
        throw new ProxyClientError(String(parsed.error?.message ?? 'Upstream provider returned an error.'));
      }
      default:
        break;
    }
  }

  // End of turn: replay any reasoning held back while the answer streamed.
  reasoningGate.flush();
}

// ── Error helpers ──────────────────────────────────────────────────────────

async function describeFailure(action: string, response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ?? parsed?.error ?? text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // Response body already consumed or unreadable; fall back to the status.
  }

  const suffix = detail ? ` — ${String(detail).slice(0, 500)}` : '';
  return `Intelligent Context ${action} failed with HTTP ${response.status}${suffix}`;
}

function toClientError(error: unknown, url: string): ProxyClientError {
  if (error instanceof ProxyClientError) return error;

  if (error instanceof Error && error.name === 'AbortError') {
    return new ProxyClientError('The request was cancelled or timed out.');
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ProxyClientError(
    `Could not reach the Intelligent Context proxy at ${url}. Confirm it is running and the base URL is correct. (${message})`,
  );
}
