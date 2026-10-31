import { Transform } from 'stream';

interface OpenAiChunkEnvelope {
  id: string;
  model: string;
  created: number;
}

interface OpenAiToolCallState {
  id: string;
  index: number;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolUseState {
  id: string;
  name: string;
  index: number;
}

function mapFinishReason(reason: string): string {
  if (reason === 'max_tokens') {
    return 'length';
  }

  if (reason === 'end_turn' || reason === 'stop_sequence') {
    return 'stop';
  }

  if (reason === 'tool_use') {
    return 'tool_calls';
  }

  return reason;
}

function mapOpenAiFinishReason(reason: string | null): string | null {
  if (reason === 'tool_calls') {
    return 'tool_use';
  }

  if (reason === 'stop') {
    return 'end_turn';
  }

  if (reason === 'length') {
    return 'max_tokens';
  }

  return reason;
}

export class AnthropicToOpenAiStream extends Transform {
  private lineBuffer = '';
  private envelope: OpenAiChunkEnvelope = {
    id: `chatcmpl-${Date.now()}`,
    model: 'unknown',
    created: Math.floor(Date.now() / 1000),
  };
  private roleSent = false;
  private doneSent = false;
  private sawEvent = false;
  /** Tracks in-flight tool_use blocks so we can emit matching tool_calls chunks */
  private activeToolUses = new Map<number, ToolUseState>();
  private toolCallIndexCounter = 0;

  constructor() {
    super({ objectMode: false });
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: () => void
  ): void {
    const raw = this.lineBuffer + chunk.toString('utf8');
    const lines = raw.split('\n');
    this.lineBuffer = lines.pop() ?? '';
    const outputLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      outputLines.push(...this._processLine(line));
    }

    if (outputLines.length > 0) {
      this.push(Buffer.from(`${outputLines.join('\n')}\n`, 'utf8'));
    }

    callback();
  }

  _flush(callback: () => void): void {
    const outputLines: string[] = [];

    if (this.lineBuffer.length > 0) {
      const line = this.lineBuffer.endsWith('\r') ? this.lineBuffer.slice(0, -1) : this.lineBuffer;
      outputLines.push(...this._processLine(line));
      this.lineBuffer = '';
    }

    if (!this.doneSent && this.sawEvent) {
      outputLines.push('data: [DONE]', '');
      this.doneSent = true;
    }

    if (outputLines.length > 0) {
      this.push(Buffer.from(`${outputLines.join('\n')}\n`, 'utf8'));
    }

    callback();
  }

  private _processLine(line: string): string[] {
    if (!line.startsWith('data: ')) {
      // Pass through non-data lines (comments, etc.) so the stream stays intact
      return [line];
    }

    if (line === 'data: [DONE]') {
      this.doneSent = true;
      return [line, ''];
    }

    try {
      const json = JSON.parse(line.slice('data: '.length)) as {
        type?: string;
        message?: { id?: string; model?: string };
        delta?: { type?: string; text?: string; stop_reason?: string; partial_json?: string };
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
      };

      // ── message_start ──────────────────────────────────────────────
      if (json.type === 'message_start') {
        if (typeof json.message?.id === 'string' && json.message.id.length > 0) {
          this.envelope.id = json.message.id;
        }
        if (typeof json.message?.model === 'string' && json.message.model.length > 0) {
          this.envelope.model = json.message.model;
        }
        this.sawEvent = true;
        return [];
      }

      // ── content_block_start (tool_use) ─────────────────────────────
      if (
        json.type === 'content_block_start' &&
        json.content_block?.type === 'tool_use' &&
        typeof json.content_block.id === 'string' &&
        typeof json.content_block.name === 'string'
      ) {
        this.sawEvent = true;
        const index = typeof json.index === 'number' ? json.index : this.toolCallIndexCounter;
        const toolState: ToolUseState = {
          id: json.content_block.id,
          name: json.content_block.name,
          index: this.toolCallIndexCounter++,
        };
        this.activeToolUses.set(index, toolState);

        // Emit role chunk first if not yet sent
        const outputLines: string[] = [];
        if (!this.roleSent) {
          outputLines.push(this._buildChunk({ role: 'assistant' }, null), '');
          this.roleSent = true;
        }

        // Emit tool_calls delta with id + function name
        outputLines.push(
          this._buildChunk(
            {
              tool_calls: [
                {
                  index: toolState.index,
                  id: toolState.id,
                  type: 'function',
                  function: { name: toolState.name, arguments: '' },
                },
              ],
            },
            null
          ),
          ''
        );

        return outputLines;
      }

      // ── content_block_delta (input_json_delta for tool arguments) ──
      if (
        json.type === 'content_block_delta' &&
        json.delta?.type === 'input_json_delta' &&
        typeof json.delta.partial_json === 'string'
      ) {
        this.sawEvent = true;
        const index = typeof json.index === 'number' ? json.index : 0;
        const toolState = this.activeToolUses.get(index);

        // Emit tool_calls delta with partial arguments
        return [
          this._buildChunk(
            {
              tool_calls: [
                {
                  index: toolState?.index ?? 0,
                  function: { arguments: json.delta.partial_json },
                },
              ],
            },
            null
          ),
          '',
        ];
      }

      // ── content_block_delta (text_delta) ───────────────────────────
      if (
        json.type === 'content_block_delta' &&
        json.delta?.type === 'text_delta' &&
        typeof json.delta.text === 'string'
      ) {
        this.sawEvent = true;
        const outputLines: string[] = [];

        if (!this.roleSent) {
          outputLines.push(this._buildChunk({ role: 'assistant' }, null), '');
          this.roleSent = true;
        }

        if (json.delta.text.length > 0) {
          outputLines.push(this._buildChunk({ content: json.delta.text }, null), '');
        }

        return outputLines;
      }

      // ── message_delta (stop_reason) ────────────────────────────────
      if (json.type === 'message_delta' && typeof json.delta?.stop_reason === 'string') {
        this.sawEvent = true;
        return [this._buildChunk({}, mapFinishReason(json.delta.stop_reason)), ''];
      }

      // ── message_stop ───────────────────────────────────────────────
      if (json.type === 'message_stop') {
        this.sawEvent = true;
        this.doneSent = true;
        return ['data: [DONE]', ''];
      }

      // ── Unrecognised event — pass through so stream stays intact ───
      return [line];
    } catch {
      // Unparseable line — pass through to avoid corrupting the stream
      return [line];
    }
  }

  private _buildChunk(delta: Record<string, unknown>, finishReason: string | null): string {
    return `data: ${JSON.stringify({
      id: this.envelope.id,
      object: 'chat.completion.chunk',
      created: this.envelope.created,
      model: this.envelope.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    })}`;
  }
}

function parseOpenAiSse(rawSse: string): {
  id: string;
  model: string;
  created: number;
  content: string;
  finishReason: string | null;
  toolCalls: OpenAiToolCallState[];
} {
  const lines = rawSse.split('\n');
  let id = `msg_${Date.now()}`;
  let model = 'unknown';
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  let finishReason: string | null = null;
  const toolCallsByIndex = new Map<number, OpenAiToolCallState>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data: ')) continue;

    const jsonStr = line.slice('data: '.length).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;

    let chunk: Record<string, unknown> | undefined;
    try {
      chunk = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof chunk.id === 'string' && chunk.id.length > 0) id = chunk.id;
    if (typeof chunk.model === 'string' && chunk.model.length > 0) model = chunk.model;
    if (typeof chunk.created === 'number') created = chunk.created;

    const choice = Array.isArray(chunk.choices)
      ? chunk.choices[0] as Record<string, unknown> | undefined
      : undefined;
    if (!choice) continue;

    if (typeof choice.finish_reason === 'string') {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    if (typeof delta.content === 'string') {
      content += delta.content;
    }

    const rawToolCalls = Array.isArray(delta.tool_calls)
      ? delta.tool_calls as Array<Record<string, unknown>>
      : [];

    for (const rawToolCall of rawToolCalls) {
      const index = typeof rawToolCall.index === 'number' ? rawToolCall.index : 0;
      let toolCall = toolCallsByIndex.get(index);
      if (!toolCall) {
        toolCall = {
          id: '',
          index,
          type: 'function',
          function: {
            name: '',
            arguments: '',
          },
        };
        toolCallsByIndex.set(index, toolCall);
      }

      if (typeof rawToolCall.id === 'string') {
        toolCall.id = rawToolCall.id;
      }
      if (typeof rawToolCall.type === 'string') {
        toolCall.type = rawToolCall.type;
      }

      const fn = rawToolCall.function as Record<string, unknown> | undefined;
      if (!fn) continue;

      if (typeof fn.name === 'string') {
        toolCall.function.name += fn.name;
      }
      if (typeof fn.arguments === 'string') {
        toolCall.function.arguments += fn.arguments;
      }
    }
  }

  return {
    id,
    model,
    created,
    content,
    finishReason,
    toolCalls: [...toolCallsByIndex.values()].sort((left, right) => left.index - right.index),
  };
}

export function convertOpenAiSseToAnthropic(rawSse: string): string {
  const parsed = parseOpenAiSse(rawSse);
  const lines: string[] = [];
  let blockIndex = 0;

  lines.push(`data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: parsed.id,
      type: 'message',
      role: 'assistant',
      model: parsed.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  })}`);
  lines.push('');

  if (parsed.content.length > 0) {
    lines.push(`data: ${JSON.stringify({
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'text',
        text: '',
      },
    })}`);
    lines.push('');
    lines.push(`data: ${JSON.stringify({
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'text_delta',
        text: parsed.content,
      },
    })}`);
    lines.push('');
    lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}`);
    lines.push('');
    blockIndex += 1;
  }

  for (const toolCall of parsed.toolCalls) {
    lines.push(`data: ${JSON.stringify({
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: toolCall.id || `toolu_${blockIndex + 1}`,
        name: toolCall.function.name,
      },
    })}`);
    lines.push('');

    if (toolCall.function.arguments.length > 0) {
      lines.push(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: toolCall.function.arguments,
        },
      })}`);
      lines.push('');
    }

    lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}`);
    lines.push('');
    blockIndex += 1;
  }

  lines.push(`data: ${JSON.stringify({
    type: 'message_delta',
    delta: {
      stop_reason: mapOpenAiFinishReason(parsed.finishReason),
      stop_sequence: null,
    },
    usage: {
      output_tokens: 0,
    },
  })}`);
  lines.push('');
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/**
 * Parse buffered Anthropic SSE events into the full Anthropic response
 * JSON object (the same shape as a non-streaming `/v1/messages` response).
 *
 * This lets us feed the response through `adapter.parseResponse()` (the
 * Anthropic adapter) to get a `ProxyResponse` for the agent loop, without
 * needing the OpenAI SSE intermediate step for detection.
 *
 * Returns `null` if parsing fails (e.g. no `message_start` event found).
 */
export function parseAnthropicSseToResponseData(rawSse: string): Record<string, unknown> | null {
  const lines = rawSse.split('\n');
  let id = '';
  let model = '';
  const content: Record<string, unknown>[] = [];
  let stopReason: string | null = null;
  let usage: Record<string, unknown> = {};

  // Per-block accumulator state
  let currentBlockIndex: number | null = null;
  let currentBlockType: string | null = null;
  let currentToolId = '';
  let currentToolName = '';
  let currentInputJson = '';
  let currentText = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data: ')) continue;

    const jsonStr = line.slice('data: '.length).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = json.type as string | undefined;
    if (!type) continue;

    // ── message_start ──────────────────────────────────────────────
    if (type === 'message_start') {
      const message = json.message as Record<string, unknown> | undefined;
      if (message) {
        id = typeof message.id === 'string' ? message.id : '';
        model = typeof message.model === 'string' ? message.model : '';
        usage = (message.usage as Record<string, unknown>) ?? {};
      }
      continue;
    }

    // ── content_block_start ────────────────────────────────────────
    if (type === 'content_block_start') {
      const index = typeof json.index === 'number' ? json.index : 0;
      const block = json.content_block as Record<string, unknown> | undefined;
      if (!block) continue;

      currentBlockIndex = index;
      currentBlockType = block.type as string | null;
      currentText = '';
      currentInputJson = '';
      currentToolId = '';
      currentToolName = '';

      if (currentBlockType === 'tool_use') {
        currentToolId = typeof block.id === 'string' ? block.id : '';
        currentToolName = typeof block.name === 'string' ? block.name : '';
        // The initial input may be present in content_block_start
        if (block.input && typeof block.input === 'object') {
          currentInputJson = JSON.stringify(block.input);
        }
      } else if (currentBlockType === 'text') {
        currentText = typeof block.text === 'string' ? block.text : '';
      }
      continue;
    }

    // ── content_block_delta ────────────────────────────────────────
    if (type === 'content_block_delta') {
      const index = typeof json.index === 'number' ? json.index : -1;
      if (index !== currentBlockIndex) continue;

      const delta = json.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      const deltaType = delta.type as string | undefined;
      if (deltaType === 'text_delta' && typeof delta.text === 'string') {
        currentText += delta.text;
      } else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
        currentInputJson += delta.partial_json;
      }
      continue;
    }

    // ── content_block_stop ────────────────────────────────────────
    if (type === 'content_block_stop') {
      if (currentBlockType === 'text') {
        content.push({ type: 'text', text: currentText });
      } else if (currentBlockType === 'tool_use') {
        let input: Record<string, unknown> = {};
        if (currentInputJson) {
          try {
            input = JSON.parse(currentInputJson) as Record<string, unknown>;
          } catch {
            input = { _raw: currentInputJson };
          }
        }
        content.push({
          type: 'tool_use',
          id: currentToolId,
          name: currentToolName,
          input,
        });
      }

      currentBlockIndex = null;
      currentBlockType = null;
      continue;
    }

    // ── message_delta ──────────────────────────────────────────────
    if (type === 'message_delta') {
      const delta = json.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === 'string') {
        stopReason = delta.stop_reason;
      }
      const deltaUsage = json.usage as Record<string, unknown> | undefined;
      if (deltaUsage) {
        usage = { ...usage, ...deltaUsage };
      }
      continue;
    }

    // message_stop — no data, ignore
  }

  if (!id) {
    // No valid `message_start` was parsed — probably an error or
    // non-Anthropic response.  Caller falls back to pass-through.
    return null;
  }

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  } satisfies Record<string, unknown>;
}