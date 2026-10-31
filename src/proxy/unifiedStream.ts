import { Transform } from 'stream';
import type { Adapter, ChatMessage, ProxyRequest, ProxyResponse } from './adapters/adapter';
import { contentToText } from '../utils/messageContent';
import { runLearningToolAgentLoop } from './tools/agentLoop';
import { isLearningToolName } from './tools/definitions';
import { logger } from '../utils/logger';
import type { ProviderType } from '../db/repositories/providers';

// ── Types ────────────────────────────────────────────────────────────────

export interface UnifiedStreamCompletion {
  /** Visible text accumulated from content deltas */
  visibleText: string;
  /** The finish_reason from the final SSE chunk, or null */
  finishReason: string | null;
  /** Whether ic_ tool calls were intercepted and handled */
  icIntercepted: boolean;
  /** Whether any tool calls (including non-ic_) were detected */
  hadNonIcToolCalls: boolean;
}

/**
 * Options for the unified SSE proxy stream.
 *
 * When `enableIcIntercept` is true, the stream intercepts ic_* tool
 * calls from the upstream SSE response and runs the agent loop
 * synchronously (awaiting it) to resolve them internally.  The raw SSE
 * (which contains ic_* tool calls the IDE doesn't understand) is NEVER
 * forwarded to the IDE.  Instead, the agent loop's resolved result is
 * emitted — either plain text (finish_reason: "stop") or IDE-understandable
 * tool calls (read_file, grep_search, etc.).  The IDE never sees ic_*
 * tool calls.
 *
 * Because the IC path is the only consumer of `projectId`, `requestBody`
 * and `adapter`, the type system enforces that those fields are present
 * whenever interception is enabled. Callers that opt out of interception
 * (e.g. when `projectId` is unknown) are not forced to provide them.
 */
export type UnifiedStreamOptions = {
  callbacks?: UnifiedStreamCallbacks;
  requestId: string;
  sessionId?: string;
  // ── IC tool interception ──
  enableIcIntercept: boolean;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;
  providerName: string;
  providerType: ProviderType;
} & (
  | {
      enableIcIntercept: false;
      projectId?: string;
      adapter?: Adapter;
      requestBody?: ProxyRequest;
    }
  | {
      enableIcIntercept: true;
      projectId: string;
      adapter: Adapter;
      requestBody: ProxyRequest;
    }
);

export interface UnifiedStreamCallbacks {
  onComplete?: (result: UnifiedStreamCompletion) => void | Promise<void>;
}

// ── SSE → ProxyResponse reconstructor ────────────────────────────────────

interface SseToolCallAccumulator {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export function parseSseToProxyResponse(rawSse: string): ProxyResponse {
  const lines = rawSse.split('\n');
  let id = '';
  let model = '';
  const toolCallsByIndex = new Map<number, SseToolCallAccumulator>();
  let content = '';
  let reasoningContent = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let role = 'assistant';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;

    const jsonStr = trimmed.slice(5).trim();
    if (jsonStr === '[DONE]') continue;

    let chunk: Record<string, unknown> | undefined;
    try {
      chunk = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch (parseErr) {
      // Malformed upstream data: lines are skipped silently at debug level
      // so a flapping provider doesn't flood the log, but operators can
      // opt in to see exactly which line tripped the parser.
      logger.debug('parseSseToProxyResponse: skipping malformed JSON data: line', {
        linePreview: jsonStr.slice(0, 200),
        error: String(parseErr),
      });
      continue;
    }

    if (typeof chunk.id === 'string') id = chunk.id;
    if (typeof chunk.model === 'string') model = chunk.model;

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;

    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    if (typeof delta.role === 'string') role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;

    const rawToolCalls = delta.tool_calls;
    if (Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls as Array<Record<string, unknown>>) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        let existing = toolCallsByIndex.get(idx);
        if (!existing) {
          existing = { id: '', type: 'function', function: { name: '', arguments: '' } };
          toolCallsByIndex.set(idx, existing);
        }
        if (typeof tc.id === 'string') existing.id = tc.id;
        if (typeof tc.type === 'string') existing.type = tc.type;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn.name === 'string') existing.function.name += fn.name;
          if (typeof fn.arguments === 'string') existing.function.arguments += fn.arguments;
        }
      }
    }
  }

  const toolCalls = Array.from(toolCallsByIndex.values());
  const message = {
    role: role as 'assistant',
    content: content || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(reasoning ? { reasoning } : {}),
  } as ProxyResponse['choices'][number]['message'];

  return {
    id: id || 'ic-stream-0',
    object: 'chat.completion',
    model: model || 'unknown',
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
  };
}

// ── ProxyResponse → SSE emitter ──────────────────────────────────────────

export function streamCompletionAsSse(response: ProxyResponse, push: (chunk: string) => void): void {
  const id = response.id;
  const mdl = response.model;
  const message = response.choices?.[0]?.message;
  const messageRecord = message as unknown as Record<string, unknown> | undefined;
  const finishReason = response.choices?.[0]?.finish_reason;
  const role = message?.role ?? 'assistant';
  const content = contentToText(message?.content);
  const reasoningContent = messageRecord?.reasoning_content;
  const reasoning = messageRecord?.reasoning;
  const toolCalls = (message as unknown as Record<string, unknown> | undefined)
    ?.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }> | undefined;

  push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: mdl, choices: [{ index: 0, delta: { role }, finish_reason: null }] })}\n\n`);

  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: mdl, choices: [{ index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null }] })}\n\n`);
  }

  if (typeof reasoning === 'string' && reasoning.length > 0) {
    push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: mdl, choices: [{ index: 0, delta: { reasoning }, finish_reason: null }] })}\n\n`);
  }

  if (content) {
    push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: mdl, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  }

  if (toolCalls && toolCalls.length > 0) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: mdl, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }] })}\n\n`);
      push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: mdl, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] })}\n\n`);
    }
  }

  push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: mdl, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: (response as { usage?: unknown }).usage ?? null })}\n\n`);
  push('data: [DONE]\n\n');
}

// ── Unified Proxy Stream ─────────────────────────────────────────────────
//
// Streaming pass-through for upstream SSE responses with ic_ tool-call
// interception.
//
// When ic_* tool calls are detected in the upstream SSE, the stream:
//   1. Buffers the remaining SSE (starting from the first IC tool delta)
//   2. After the stream ends, reconstructs the response and runs the
//      agent loop synchronously (awaited) to resolve all ic_* tools
//   3. The agent loop executes each ic_* tool, feeds results back to the
//      upstream model, and continues until the model produces either
//      plain text (finish_reason: "stop") or IDE-understandable tool
//      calls (read_file, grep_search, etc.)
//   4. The agent loop's final result is emitted as SSE to the IDE — the
//      IDE NEVER sees ic_* tool calls it cannot execute.
//
// Visible text is still counted so downstream callers (stats, completion
// callbacks) can report it.

export class UnifiedProxyStream extends Transform {
  // ── SSE line buffering ──
  private lineBuffer = '';

  // ── IC interception state ──
  private intercepting = false;
  private interceptBuffer: string[] = [];
  /**
   * Flag to suppress the `[DONE]` marker in `_flush` when the agent
   * loop has already emitted a resolved SSE stream (which includes
   * its own [DONE]) inside `_handleIcInterception`.
   */
  private streamCompleted = false;
  /**
   * Per-index tool name accumulator. Some providers split the function
   * name across multiple SSE deltas (e.g. the Anthropic→OpenAI bridge
   * sends `name: 'i'` then `name: 'c_list_chunks'`), and the name may
   * arrive in a different chunk than the one that triggers detection.
   * We track each `index`'s accumulated name so the trigger decision in
   * `_processLine` stays accurate regardless of chunk ordering.
   */
  private toolNameAccumulator = new Map<number, string>();

  // ── Completion tracking ──
  private visibleText = '';
  private finishReason: string | null = null;
  private hadNonIcToolCalls = false;
  private icIntercepted = false;
  private completed = false;
  private callbackFired = false;

  private opts: UnifiedStreamOptions;

  constructor(opts: UnifiedStreamOptions) {
    super({ objectMode: false });
    this.opts = opts;
  }

  // ── Transform interface ──────────────────────────────────────────────

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    const raw = this.lineBuffer + chunk.toString('utf8');
    const lines = raw.split('\n');
    this.lineBuffer = lines.pop() ?? '';
    const outputLines: string[] = [];

    for (const line of lines) {
      const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
      outputLines.push(...this._processLine(cleanLine));
    }

    const out = outputLines.length > 0 ? `${outputLines.join('\n')}\n` : '';
    if (out) this.push(Buffer.from(out, 'utf8'));
    callback();
  }

  async _flush(callback: () => void): Promise<void> {
    if (this.lineBuffer.length > 0) {
      const cleanLine = this.lineBuffer.endsWith('\r') ? this.lineBuffer.slice(0, -1) : this.lineBuffer;
      const outputLines = this._processLine(cleanLine);
      const out = outputLines.length > 0 ? `${outputLines.join('\n')}\n` : '';
      if (out) this.push(Buffer.from(out, 'utf8'));
      this.lineBuffer = '';
    }

    await this._onStreamComplete();

    // Emit exactly one [DONE] to terminate the SSE stream cleanly.
    // Upstream providers (DeepSeek) may emit multiple [DONE] markers
    // (e.g. after reasoning and after response).  We suppress all of
    // them in `_processLine` and emit our own here.  The raw-SSE IC
    // interception path never sets `streamCompleted`, so the guarded
    // check below is effectively always-true — but kept as a safety
    // valve in case a future code path emits a synthetic finish.
    if (!this.streamCompleted) {
      this.push(Buffer.from('data: [DONE]\n\n', 'utf8'));
    }

    callback();
  }

  _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.completed) {
      this.completed = true;
      this._fireCallback();
    }
    callback(err);
  }

  // ── Line processing ──────────────────────────────────────────────────

  private _processLine(line: string): string[] {
    if (line === '') return [line];
    if (!line.startsWith('data: ')) return [line];

    if (line === 'data: [DONE]') {
      // DeepSeek (and potentially other providers) emits reasoning as a
      // separate SSE segment with its own [DONE] before the actual
      // response.  Passing through every [DONE] confuses IDE clients:
      // they stop reading after the first one and miss any tool calls
      // that arrive after it.
      //
      // Suppress ALL upstream [DONE] markers and emit exactly one in
      // `_flush`. We intentionally do NOT push the marker into
      // `interceptBuffer`: `parseSseToProxyResponse` already skips
      // `[DONE]` lines, so the buffer copy was dead code.
      return [];
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line.slice('data: '.length));
    } catch (parseErr) {
      // Malformed SSE data lines are passed through unchanged so the
      // IDE can still surface them — but log at debug level so flaky
      // providers are visible when the operator raises the log level.
      logger.debug('UnifiedProxyStream: failed to parse SSE data line', {
        linePreview: line.slice(0, 200),
        error: String(parseErr),
      });
      return [line];
    }

    // ── Track finish_reason ──
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (choice && typeof choice.finish_reason === 'string') {
      this.finishReason = choice.finish_reason;
    }

    // ── Track visible text content for stats ──
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === 'string') {
      this.visibleText += delta.content;
    }

    // ── Detect tool calls (ic_ and non-ic_) ──
    const rawToolCalls = delta?.tool_calls;
    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      // Some providers split the function name across multiple SSE
      // deltas (e.g. `name: 'i'` then `name: 'c_list_chunks'`), and the
      // name may arrive in a different chunk than the one that triggers
      // detection.  We accumulate per-index so the trigger decision in
      // this same block stays accurate regardless of chunk ordering.
      const detectedNames: string[] = [];
      for (const tc of rawToolCalls as Array<Record<string, unknown>>) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const fn = tc.function as Record<string, unknown> | undefined;
        const nameChunk = typeof fn?.name === 'string' ? fn.name : undefined;
        if (nameChunk && nameChunk.length > 0) {
          const existing = this.toolNameAccumulator.get(idx) ?? '';
          this.toolNameAccumulator.set(idx, existing + nameChunk);
        }
        const fullName = this.toolNameAccumulator.get(idx);
        if (fullName && fullName.length > 0) {
          detectedNames.push(fullName);
        }
      }

      const hasIc = detectedNames.some((n) => isLearningToolName(n));
      const hasNonIc = detectedNames.some((n) => !isLearningToolName(n));

      if (hasNonIc) this.hadNonIcToolCalls = true;

      if (hasIc && this.opts.enableIcIntercept && !this.intercepting) {
        logger.debug('UnifiedProxyStream: IC tool detected, beginning interception', {
          requestId: this.opts.requestId,
          icToolNames: detectedNames.filter((n) => isLearningToolName(n)),
          nonIcToolNames: detectedNames.filter((n) => !isLearningToolName(n)),
        });
        this.intercepting = true;
        this.interceptBuffer = [line];
        return []; // suppress from output
      }
    }

    // If already intercepting, buffer everything
    if (this.intercepting) {
      this.interceptBuffer.push(line);
      return [];
    }

    return [line];
  }

  // ── Stream completion ────────────────────────────────────────────────

  private async _onStreamComplete(): Promise<void> {
    if (this.completed) return;
    this.completed = true;

    if (this.intercepting && this.interceptBuffer.length > 0) {
      await this._handleIcInterception();
    }

    this._fireCallback();
  }

  private _fireCallback(): void {
    if (this.callbackFired) return;
    if (!this.opts.callbacks?.onComplete) return;
    this.callbackFired = true;
    Promise.resolve(
      this.opts.callbacks.onComplete({
        visibleText: this.visibleText,
        finishReason: this.finishReason,
        icIntercepted: this.icIntercepted,
        hadNonIcToolCalls: this.hadNonIcToolCalls,
      })
    ).catch((err) => logger.error('UnifiedProxyStream onComplete failed', { error: String(err) }));
  }

  private async _handleIcInterception(): Promise<void> {
    this.icIntercepted = true;
    const rawSse = this.interceptBuffer.join('\n');

    if (this.opts.enableIcIntercept && this.opts.projectId && this.opts.requestBody && this.opts.adapter) {
      let responseData: ProxyResponse | null = null;
      try {
        responseData = parseSseToProxyResponse(rawSse);
      } catch (parseErr) {
        logger.error('UnifiedProxyStream: failed to parse intercepted SSE', {
          requestId: this.opts.requestId,
          parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }

      if (responseData) {
        const normalised = this.opts.adapter.parseResponse(responseData);

        try {
          // Run the agent loop synchronously (await it) to resolve all ic_*
          // tool calls internally.  The loop executes ic_* tools, appends
          // results to the conversation, re-queries the upstream, and
          // continues until the model produces either plain text
          // (finish_reason: "stop") or IDE-understandable tool calls
          // (read_file, grep_search, etc.).
          const loopResult = await runLearningToolAgentLoop({
            url: this.opts.upstreamUrl,
            headers: this.opts.upstreamHeaders,
            adapter: this.opts.adapter,
            request: this.opts.requestBody,
            projectId: this.opts.projectId,
            sessionId: this.opts.sessionId,
            requestId: this.opts.requestId,
            providerName: this.opts.providerName,
            providerType: this.opts.providerType,
            initialResponseData: responseData,
            initialNormalizedResponse: normalised,
          });

          // Update tracking fields from the agent loop's resolved response
          const finalMessage = loopResult.normalizedResponse.choices?.[0]?.message;
          const finalFinishReason = loopResult.normalizedResponse.choices?.[0]?.finish_reason;
          if (typeof finalFinishReason === 'string') {
            this.finishReason = finalFinishReason;
          }

          // Emit the agent loop's final result as SSE to the IDE.
          // All ic_* tools have been executed server-side; the output
          // contains only text and/or IDE-understandable tool calls.
          streamCompletionAsSse(loopResult.normalizedResponse, (chunk) => {
            this.push(Buffer.from(chunk, 'utf8'));
          });

          // streamCompletionAsSse emits its own [DONE] marker.  Tell
          // _flush not to emit a second one.
          this.streamCompleted = true;

          logger.info('UnifiedProxyStream: agent loop completed, resolved SSE sent to IDE', {
            requestId: this.opts.requestId,
            internalTurnCount: loopResult.internalTurnCount,
            finishReason: this.finishReason,
            hasToolCalls: Array.isArray((finalMessage as unknown as Record<string, unknown> | undefined)?.tool_calls),
          });
          return;
        } catch (loopErr) {
          logger.error('UnifiedProxyStream: agent loop failed; falling back to raw SSE', {
            requestId: this.opts.requestId,
            error: loopErr instanceof Error ? loopErr.message : String(loopErr),
          });
        }
      }
    }

    // Fallback: flush the raw SSE to the IDE when interception is
    // disabled, parsing failed, or the agent loop threw.
    if (rawSse.length > 0) {
      logger.debug('UnifiedProxyStream: flushing raw intercepted SSE to IDE (fallback)', {
        requestId: this.opts.requestId,
        rawSseLength: rawSse.length,
        enableIcIntercept: this.opts.enableIcIntercept,
      });
      this.push(Buffer.from(rawSse, 'utf8'));
    }
  }

}
