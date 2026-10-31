import axios from 'axios';
import { PassThrough } from 'stream';
import type { ChatMessage, ProxyRequest } from '../adapters/adapter';
import { logger } from '../../utils/logger';
import { estimateTokens } from '../../utils/tokens';
import { recordStat, generateRunId } from '../../utils/stats';
import { UnifiedProxyStream, parseSseToProxyResponse } from '../unifiedStream';
import { AnthropicToOpenAiStream, convertOpenAiSseToAnthropic } from '../anthropicSseBridge';
import { resolveProviderAndModelForJob } from '../upstream';
import type { ClientProtocol } from '../clientProtocols';
import {
  startGathererPhase,
  finishGathererPhase,
  getGathererPhase,
  setGathererAssistantContinuationMessage,
} from './phase';
import { buildGathererContextBlock, buildGathererRequest } from './request';
import { GATHERER_SYSTEM_PROMPT } from '../../learning/gathererPrompt';
import type { GathererContextSelection } from '../../context/selector';
import { withParamFallback } from '../../utils/paramFallback';
import { applyUpstreamRequestMiddleware } from '../requestMiddleware';

export interface RunGathererTurnOptions {
  /** Resolved gatherer model ID (already trimmed, non-empty). */
  gathererModel: string;
  /** Request body — used as the source of messages and tools. */
  requestBody: ProxyRequest;
  projectId: string;
  sessionId: string | undefined;
  requestId: string;
  clientProtocol: ClientProtocol;
  selectionContext?: GathererContextSelection;
  /**
   * Optional assembled `## Project Context` block (the same one the
   * main model would receive on the non-gatherer path).  When
   * provided, `buildGathererRequest` injects it as a system message
   * between the gatherer instruction and the user messages so the
   * cheap model can use it as a starting point instead of
   * re-deriving everything from the codebase.
   */
  pastKnowledgeBlock?: string;
  /**
   * Snapshot of the original request messages captured before the
   * gatherer starts.  Stored in the phase so the main model sees only
   * the original user request (plus injected gatherer analysis), not
   * the gatherer's internal tool-call turns.
   */
  originalMessages?: ChatMessage[];
}

export interface GathererTurnResult {
  /** True if the gatherer produced finish_reason: "stop" and is done. */
  phaseFinished: boolean;
  /** The captured visible text (populated only when phaseFinished). */
  capturedText: string;
}

/**
 * Run one gatherer turn.  The gatherer's SSE output is always collected
 * into a buffer rather than being piped directly to the HTTP response.
 * After the stream completes we decide what to do with it:
 *
 * - `finish_reason === "tool_calls"` (or similar) → the buffered SSE
 *   (including tool-call definitions) is sent to the IDE so the IDE can
 *   execute the tools.  The gatherer phase remains in progress.
 *
 * - `finish_reason === "stop"` → the gatherer produced its final handoff.
 *   The visible text is CAPTURED, the phase is marked finished, and the
 *   SSE is DISCARDED (the IDE never sees the gatherer's final output —
 *   the main model runs next on the same HTTP response).
 *
 * The caller must inject `capturedText` into the original request and run
 * the main model when `phaseFinished` is true.
 */
export async function runGathererTurn(
  options: RunGathererTurnOptions,
  res: import('express').Response
): Promise<GathererTurnResult> {
  const execution = await resolveProviderAndModelForJob(options.gathererModel);
  if (!execution) {
    logger.warn('Gatherer model configured but no provider resolved; skipping', {
      model: options.gathererModel,
      projectId: options.projectId,
    });
    return { phaseFinished: false, capturedText: '' };
  }

  const phase = getGathererPhase(options.sessionId);
  const gathererBody = buildGathererRequest(
    options.requestBody,
    execution.model,
    options.selectionContext ?? phase?.selectionContext,
    phase?.assistantContinuationMessage,
    undefined,
    options.pastKnowledgeBlock ?? phase?.pastKnowledgeBlock,
  );

  // Verify the first system message is the gatherer prompt — the IDE may
  // have re-sent its own "You are an expert coding assistant" system
  // message in a subsequent request (e.g. after the user types another
  // message in the same chat).  Strip any non-gatherer system messages
  // and ensure GATHERER_SYSTEM_PROMPT is always at index 0.
  //
  // The past-knowledge block (index 1 in normal flow) is preserved by
  // pulling it forward if it exists; it is identified by the
  // `## Project Context` heading rather than a content match so the
  // check is robust to preamble text changes.
  if (gathererBody.messages && gathererBody.messages.length > 0) {
    const first = gathererBody.messages[0];
    const firstIsGatherer = first?.role === 'system' && first?.content === GATHERER_SYSTEM_PROMPT;
    if (!firstIsGatherer) {
      const sysMessages = gathererBody.messages.filter((m) => m.role === 'system');
      const offendingSysCount = sysMessages.filter((m) => m.content !== GATHERER_SYSTEM_PROMPT).length;
      const preservedPastKnowledge = gathererBody.messages.find(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('## Project Context')
      );
      logger.warn('Gatherer request missing gatherer system prompt at index 0; correcting', {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        firstRole: first?.role,
        firstContentPreview: typeof first?.content === 'string' ? first.content.slice(0, 120) : '(non-string)',
        systemMessageCount: sysMessages.length,
        nonGathererSystemCount: offendingSysCount,
        preservedPastKnowledge: !!preservedPastKnowledge,
      });
      gathererBody.messages = [
        { role: 'system' as const, content: GATHERER_SYSTEM_PROMPT },
        ...(preservedPastKnowledge ? [preservedPastKnowledge] : []),
        ...gathererBody.messages.filter((m) => m.role !== 'system'),
      ];
    }
  }

  const url = execution.adapter.endpoint(execution.baseUrl);
  const reqHeaders = applyUpstreamRequestMiddleware(url, execution.adapter.headers(execution.apiKey), {
    sessionId: options.sessionId,
    projectId: options.projectId,
  });

  const gathererMsgCount = gathererBody.messages?.length ?? 0;
  const gathererSysCount = gathererBody.messages?.filter((m) => m.role === 'system').length ?? 0;
  const gathererUserCount = gathererBody.messages?.filter((m) => m.role === 'user').length ?? 0;
  const gathererAssistantCount = gathererBody.messages?.filter((m) => m.role === 'assistant').length ?? 0;
  const gathererToolCount = gathererBody.messages?.filter((m) => m.role === 'tool').length ?? 0;
  logger.info('Gatherer turn: built gatherer request, sending upstream', {
    projectId: options.projectId,
    sessionId: options.sessionId,
    requestId: options.requestId,
    model: execution.model,
    url,
    messageCount: gathererMsgCount,
    systemMessages: gathererSysCount,
    userMessages: gathererUserCount,
    assistantMessages: gathererAssistantCount,
    toolMessages: gathererToolCount,
    hasSelectionContext: !!options.selectionContext,
    hasAssistantContinuation: !!phase?.assistantContinuationMessage,
    isContinuationTurn: !!phase,
    stream: true,
  });

  const runId = generateRunId();
  recordStat({
    projectId: options.projectId,
    sessionId: options.sessionId,
    model: execution.model,
    runId,
    type: 'gatherer',
    direction: 'input',
    meta: { gathererModelName: options.gathererModel },
    tokens: estimateTokens(JSON.stringify(gathererBody.messages ?? [])),
    body: JSON.stringify(gathererBody.messages ?? []),
  });

  let upstreamResponse;
  try {
    ({ result: upstreamResponse } = await withParamFallback(
      gathererBody,
      execution.adapter,
      {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        model: execution.model,
        providerName: execution.providerName,
        providerType: execution.providerType,
        url,
        requestHeaders: reqHeaders,
      },
      async (payload) => axios.post(url, payload, {
        headers: reqHeaders,
        responseType: 'stream',
        timeout: 120_000,
      }),
    ));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
    logger.warn('Gatherer upstream POST failed; continuing without gathered context', {
      projectId: options.projectId,
      requestId: options.requestId,
      model: execution.model,      
      statusCode,
      error: errorMessage,
    });
    return { phaseFinished: false, capturedText: '' };
  }

  // Bridge if the IDE speaks OpenAI but the gatherer is on Anthropic.
  const sourceStream =
    options.clientProtocol === 'openai' && execution.providerType === 'anthropic'
      ? upstreamResponse.data.pipe(new AnthropicToOpenAiStream())
      : upstreamResponse.data;

  // Collect all SSE output into a buffer.
  const collector = new PassThrough();
  const sseChunks: Buffer[] = [];
  collector.on('data', (chunk: Buffer) => sseChunks.push(chunk));

  let visibleText = '';
  let finishReason: string | null = null;

  const completion = new Promise<void>((resolve, reject) => {
    const unified = new UnifiedProxyStream({
      callbacks: {
        onComplete: (result) => {
          visibleText = result.visibleText;
          finishReason = result.finishReason;
        },
      },
      projectId: options.projectId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      enableIcIntercept: true,
      upstreamUrl: url,
      upstreamHeaders: reqHeaders,
      adapter: execution.adapter,
      requestBody: gathererBody,
      providerName: execution.providerName,
      providerType: execution.providerType,
    });

    sourceStream.on('error', (err: Error) => {
      logger.warn('Gatherer source stream error', {
        projectId: options.projectId,
        error: err.message,
      });
      reject(err);
    });

    unified.on('error', (err: Error) => {
      logger.warn('Gatherer unified stream error', {
        projectId: options.projectId,
        error: err.message,
      });
      reject(err);
    });

    collector.on('finish', () => setImmediate(resolve));

    sourceStream.pipe(unified).pipe(collector);
  });

  try {
    await completion;
  } catch (err) {
    logger.warn('Gatherer pipe failed; continuing without gathered context', {
      projectId: options.projectId,
      error: String(err),
    });
    return { phaseFinished: false, capturedText: '' };
  }

  recordStat({
    projectId: options.projectId,
    sessionId: options.sessionId,
    model: execution.model,
    runId,
    type: 'gatherer',
    direction: 'output',
    tokens: estimateTokens(visibleText),
    body: visibleText || undefined,
  });

  if (finishReason === 'stop') {
    // Gatherer finished — capture text, mark phase done, discard SSE.
    logger.info('Gatherer stage completed; handing off to main model', {
      projectId: options.projectId,
      model: execution.model,
      gathererTokens: estimateTokens(visibleText),
    });
    finishGathererPhase(options.sessionId!, visibleText);
    return { phaseFinished: true, capturedText: visibleText };
  }

  // Tool calls — send buffered SSE to IDE so it can execute them.
  const rawSse = Buffer.concat(sseChunks).toString('utf8');
  const parsedResponse = parseSseToProxyResponse(rawSse);
  const assistantMessage = parsedResponse.choices?.[0]?.message;
  const toolCallsInResponse = (assistantMessage as unknown as Record<string, unknown> | undefined)?.tool_calls;
  const toolCallNames = Array.isArray(toolCallsInResponse)
    ? (toolCallsInResponse as Array<{ function?: { name?: string }; name?: string }>).map((tc) => tc?.function?.name ?? tc?.name ?? '').filter(Boolean)
    : [];

  logger.info('Gatherer made tool calls; streaming to IDE for execution', {
    projectId: options.projectId,
    sessionId: options.sessionId,
    requestId: options.requestId,
    model: execution.model,
    finishReason,
    toolCallCount: Array.isArray(toolCallsInResponse) ? toolCallsInResponse.length : 0,
    toolCallNames,
    rawSseLength: rawSse.length,
    hasContent: typeof assistantMessage?.content === 'string' && assistantMessage.content.trim().length > 0,
    contentPreview: typeof assistantMessage?.content === 'string' ? assistantMessage.content.slice(0, 150) : undefined,
  });

  // Defensive: if the parsed response has no tool_calls and no meaningful
  // content, the upstream SSE was likely corrupted (e.g. ic_ interception
  // failed without a fallback).  Log a warning so the operator can
  // investigate, but still send whatever we have rather than leaving the
  // IDE hanging with an empty response.
  const hasToolCalls = Array.isArray((assistantMessage as unknown as Record<string, unknown> | undefined)?.tool_calls)
    && ((assistantMessage as unknown as Record<string, unknown> | undefined)?.tool_calls as unknown[]).length > 0;
  const hasContent = typeof assistantMessage?.content === 'string' && assistantMessage.content.trim().length > 0;

  if (!hasToolCalls && !hasContent) {
    logger.warn('Gatherer response has no tool_calls and no content; SSE may be incomplete', {
      projectId: options.projectId,
      model: execution.model,
      finishReason,
      rawSseLength: rawSse.length,
    });
  }

  if (options.sessionId && assistantMessage?.role === 'assistant') {
    setGathererAssistantContinuationMessage(
      options.sessionId,
      assistantMessage as import('./phase').GathererAssistantContinuationMessage,
    );
  }
  const clientSse = options.clientProtocol === 'anthropic' && execution.providerType === 'openai'
    ? convertOpenAiSseToAnthropic(rawSse)
    : rawSse;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.  write(clientSse);
  res.end();

  return { phaseFinished: false, capturedText: '' };
}

/**
 * Start a brand-new gatherer phase and run the first turn.
 */
export async function startAndRunGathererTurn(
  options: RunGathererTurnOptions,
  res: import('express').Response
): Promise<GathererTurnResult> {
  startGathererPhase(
    options.sessionId!,
    options.gathererModel,
    options.selectionContext,
    options.originalMessages,
    options.pastKnowledgeBlock,
  );
  return runGathererTurn(options, res);
}

/**
 * Inject the gatherer's captured text into the main request's messages,
 * as a `<gatherer_analysis>` block appended to the last user message
 * (like an attached file), so the model treats it as supporting material
 * rather than authoritative instructions.
 */
export function injectGathererResult(
  requestBody: ProxyRequest,
  gathererText: string
): void {
  if (!gathererText.trim()) return;
  const messageCountBefore = requestBody.messages?.length ?? 0;
  const block = buildGathererContextBlock(gathererText);

  // Append to the last user message's content, like an attached file.
  // This places the gatherer output at the bottom of the user's request
  // where the model treats it as supporting material rather than a
  // separate authoritative block at the top.
  const messages = requestBody.messages as ChatMessage[];
  const reverseUserIdx = [...messages].reverse().findIndex((m) => m.role === 'user');
  const lastUserIdx = reverseUserIdx >= 0
    ? messages.length - 1 - reverseUserIdx
    : -1;
  if (lastUserIdx >= 0) {
    const lastUser = messages[lastUserIdx];
    const separator = typeof lastUser.content === 'string' && lastUser.content.trim().length > 0 ? '\n\n' : '';
    messages[lastUserIdx] = {
      ...lastUser,
      content: typeof lastUser.content === 'string'
        ? lastUser.content + separator + block
        : block,
    };
  } else {
    // No user message found — fall back to prepending as a user message.
    requestBody.messages = [{ role: 'user', content: block }, ...messages];
  }

  logger.info('Gatherer analysis injected into request body', {
    gathererTextLength: gathererText.length,
    gathererTextPreview: gathererText.slice(0, 200),
    messageCountBefore,
    messageCountAfter: requestBody.messages?.length ?? 0,
  });
}
