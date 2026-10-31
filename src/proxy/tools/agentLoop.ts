import axios from 'axios';
import type { Adapter, ChatMessage, ChatToolCall, ProxyRequest, ProxyResponse } from '../adapters/adapter';
import { logger } from '../../utils/logger';
import { isLearningToolName, getLearningToolsForClientProtocol } from './definitions';
import { executeLearningTool } from './executor';
import type { ClientProtocol } from '../clientProtocols';
import { withParamFallback, type ParamFallbackContext } from '../../utils/paramFallback';
import {
  appendToolResultReplayEntriesForSession,
  type ToolResultReplayEntry,
} from '../contextReplay';

const DEFAULT_MAX_AGENT_TURNS = 10;

type OpenAiToolCall = ChatToolCall;

interface AssistantToolCallMessage extends ChatMessage {
  tool_calls?: OpenAiToolCall[];
}

interface ToolResultMessage extends ChatMessage {
  tool_call_id: string;
}

interface ExecutedToolResult {
  message: ToolResultMessage;
  replayEntry: ToolResultReplayEntry;
}

export interface LearningToolAgentLoopOptions {
  url: string;
  headers: Record<string, string>;
  adapter: Adapter;
  request: ProxyRequest;
  projectId: string;
  sessionId?: string;
  requestId: string;
  providerName: string;
  providerType: string;
  initialResponseData: unknown;
  initialNormalizedResponse?: ProxyResponse;
  maxTurns?: number;
  toolClientProtocol?: ClientProtocol;
}

export interface LearningToolAgentLoopResult {
  responseData: unknown;
  normalizedResponse: ProxyResponse;
  internalTurnCount: number;
}

function getAssistantMessage(response: ProxyResponse): AssistantToolCallMessage | undefined {
  return response.choices?.[0]?.message as AssistantToolCallMessage | undefined;
}

function getToolCalls(response: ProxyResponse): OpenAiToolCall[] {
  const toolCalls = getAssistantMessage(response)?.tool_calls;
  return Array.isArray(toolCalls) ? toolCalls : [];
}

function getToolName(toolCall: OpenAiToolCall): string | undefined {
  return typeof toolCall.function?.name === 'string'
    ? toolCall.function.name
    : undefined;
}

function getToolId(toolCall: OpenAiToolCall): string | undefined {
  return typeof toolCall.id === 'string' && toolCall.id.length > 0
    ? toolCall.id
    : undefined;
}

function serializeToolResult(result: unknown): string {
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify({
      success: false,
      result: null,
      error: 'Tool result could not be serialized.',
    });
  }
}

function parseToolArguments(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs == null || rawArgs === '') {
    return {};
  }

  if (typeof rawArgs === 'string') {
    const parsed = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  }

  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }

  throw new Error('Tool arguments must be a JSON object.');
}

function cloneAssistantMessage(message: AssistantToolCallMessage): AssistantToolCallMessage {
  return {
    ...message,
    role: 'assistant',
    content: message.content ?? '',
    tool_calls: Array.isArray(message.tool_calls)
      ? [...message.tool_calls]
      : [],
  };
}

async function buildToolResultMessage(
  toolCall: OpenAiToolCall,
  projectId: string,
  sessionId: string | undefined,
  requestId: string
): Promise<ExecutedToolResult> {
  const toolCallId = getToolId(toolCall);
  const toolName = getToolName(toolCall);

  if (!toolCallId || !toolName) {
    throw new Error('Upstream tool call was missing an id or function name.');
  }

  let parsedArguments: Record<string, unknown> = {};
  let executionResult;
  try {
    parsedArguments = parseToolArguments(toolCall.function?.arguments);
    executionResult = await executeLearningTool(
      toolName,
      parsedArguments,
      { projectId, sessionId, requestId }
    );
  } catch (error) {
    executionResult = {
      success: false,
      result: null,
      error: error instanceof Error ? error.message : 'Learning tool execution failed.',
    };
  }

  return {
    message: {
      role: 'tool',
      tool_call_id: toolCallId,
      name: toolName,
      content: serializeToolResult(executionResult),
    },
    replayEntry: {
      toolCallId,
      toolName,
      arguments: parsedArguments,
      result: executionResult,
    },
  };
}

/**
 * Build a synthetic `ProxyResponse` that surfaces the upstream failure
 * to the user-facing model.  The response contains a single assistant
 * message explaining that the internal tool loop failed and asking the
 * model to continue without those tools.  This lets the conversation
 * keep going on the next user message rather than terminating the
 * stream.
 */
function buildTurnFailureFallbackResponse(
  options: LearningToolAgentLoopOptions,
  errorMessage: string,
  axiosStatus: number | undefined,
): unknown {
  const status = axiosStatus !== undefined ? `HTTP ${axiosStatus}` : 'network error';
  const text = `The internal learning tool loop failed (${status}: ${errorMessage}). The conversation can continue without the internal tool results — please respond to the user based on the conversation so far.`;

  // We deliberately return a minimal OpenAI-shaped JSON payload here
  // instead of a `ProxyResponse` because the caller's adapter may not
  // understand a `ProxyResponse` raw (e.g. Anthropic adapter expects
  // Anthropic-shaped JSON).  Constructing the OpenAI form and letting
  // `parseResponse` normalise is the safe path.
  return {
    id: `ic-turn-failure-${Date.now()}`,
    object: 'chat.completion',
    model: options.request.model ?? 'unknown',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
      },
      finish_reason: 'stop',
    }],
  };
}

export async function runLearningToolAgentLoop(
  options: LearningToolAgentLoopOptions
): Promise<LearningToolAgentLoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_AGENT_TURNS;
  // Strip client-facing tool definitions and streaming options from the
  // original request.  Internal tool-loop turns must be non-streaming
  // (for parseable JSON responses) and must only expose ic_* tools to
  // the upstream so it can chain learning tool calls without getting
  // distracted by client-side tools.
  const {
    stream: _stream,
    stream_options: _streamOpts,
    tools: _tools,
    tool_choice: _toolChoice,
    ...baseRequest
  } = options.request;
  const workingRequest: ProxyRequest = {
    ...baseRequest,
    stream: false,
    // Expose only ic_* tools so the upstream can chain additional
    // learning tool calls (e.g. ic_update_finding after ic_get_finding).
    tools: getLearningToolsForClientProtocol(options.toolClientProtocol ?? 'openai') as unknown as ProxyRequest['tools'],
    messages: [...options.request.messages],
  };

  const learningToolNames = (workingRequest.tools as Array<{ function?: { name?: string }; name?: string }> | undefined)
    ?.map((t) => t?.function?.name ?? t?.name ?? '')
    .filter(Boolean) ?? [];

  logger.info('Learning tool agent loop started — working request built from original', {
    projectId: options.projectId,
    sessionId: options.sessionId,
    requestId: options.requestId,
    model: workingRequest.model ?? options.request.model,
    providerName: options.providerName,
    originalMessageCount: options.request.messages.length,
    workingMessageCount: workingRequest.messages.length,
    icToolsAvailable: learningToolNames,
    strippedStream: 'stream' in options.request,
    strippedTools: 'tools' in options.request,
    strippedToolChoice: 'tool_choice' in options.request,
    maxTurns,
  });

  let responseData = options.initialResponseData;
  let normalizedResponse = options.initialNormalizedResponse ?? options.adapter.parseResponse(responseData);
  let internalTurnCount = 0;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const toolCalls = getToolCalls(normalizedResponse);
    if (toolCalls.length === 0) {
      logger.info('Agent loop: finished — model produced no tool calls', {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        internalTurnCount,
        finishReason: normalizedResponse.choices?.[0]?.finish_reason,
      });
      return {
        responseData,
        normalizedResponse,
        internalTurnCount,
      };
    }

    const learningToolCalls = toolCalls.filter((toolCall) => {
      const toolName = getToolName(toolCall);
      return typeof toolName === 'string' && isLearningToolName(toolName);
    });

    if (learningToolCalls.length === 0) {
      // The response contains only non-ic_ tool calls (e.g. read_file).
      // Return as-is — the IDE will handle those tools.
      logger.info('Agent loop: finished — only non-ic_ tools remain (IDE tools)', {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        internalTurnCount,
        nonIcToolNames: toolCalls.map((tc) => getToolName(tc)).filter(Boolean),
        finishReason: normalizedResponse.choices?.[0]?.finish_reason,
      });
      return {
        responseData,
        normalizedResponse,
        internalTurnCount,
      };
    }

    if (learningToolCalls.length !== toolCalls.length) {
      // Mixed internal (ic_*) and client (IDE) tool calls.
      // Execute only the ic_ tools internally, then add a user message
      // explaining that the non-ic_ tools were dropped because mixed
      // calls are not supported.  The model is told to re-issue the
      // dropped tools in a separate turn (after the agent loop finishes
      // and the standard IDE tools become available again).
      const assistantMessage = getAssistantMessage(normalizedResponse);
      if (!assistantMessage) {
        throw new Error('Upstream returned tool calls without an assistant message.');
      }

      const toolResults = await Promise.all(
        learningToolCalls.map((toolCall) => buildToolResultMessage(
          toolCall,
          options.projectId,
          options.sessionId,
          options.requestId,
        ))
      );
      const toolResultMessages = toolResults.map((toolResult) => toolResult.message);

      // Build a slim assistant message with only ic_ tool calls so the
      // conversation stays coherent (non-ic_ calls are omitted since we
      // don't have results for them).
      const slimAssistantMessage: AssistantToolCallMessage = {
        ...cloneAssistantMessage(assistantMessage),
        tool_calls: learningToolCalls,
      };

      const mixedToolNames = learningToolCalls.map((toolCall) => getToolName(toolCall)).filter(Boolean) as string[];
      const allToolNames = toolCalls.map((toolCall) => getToolName(toolCall)).filter(Boolean) as string[];
      const droppedToolNames = allToolNames.filter((n) => !mixedToolNames.includes(n));

      // Inject a user-role message telling the model that mixed tool
      // calls aren't allowed and which tools were dropped.  The model
      // receives this alongside the IC tool results, so it can decide:
      //   - Call only IC tools (handled by the agent loop)
      //   - Return text (agent loop finishes; IDE tools available next)
      const mixedToolMessage: ChatMessage = {
        role: 'user',
        content: `[system] Mixed tool calls are not supported — internal ic_* tools and standard IDE tools cannot be called in the same turn. The following tools were dropped because they were called alongside ic_* tools: ${droppedToolNames.join(', ')}. The ic_* tools have been executed. Please re-issue the dropped tools in a separate turn after the internal agent loop finishes — call either ic_* tools or standard IDE tools, not both together.`,
      };

      workingRequest.messages = [
        ...workingRequest.messages,
        slimAssistantMessage,
        ...toolResultMessages,
        mixedToolMessage,
      ];

      appendToolResultReplayEntriesForSession(
        options.projectId,
        options.sessionId,
        toolResults.map((toolResult) => toolResult.replayEntry),
      );

      logger.info('Agent loop: mixed tool turn — executed ic_ tools, informed model that non-ic_ tools were dropped', {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        turn: turn + 1,
        icToolNames: mixedToolNames,
        droppedTools: droppedToolNames,
        messageCountAfterAppend: workingRequest.messages.length,
        lastMessageRole: workingRequest.messages[workingRequest.messages.length - 1]?.role,
      });

      const ctx: ParamFallbackContext = {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        model: workingRequest.model ?? options.request.model ?? 'unknown',
        providerName: options.providerName,
        providerType: options.providerType,
        url: options.url,
        requestHeaders: options.headers,
      };

      try {
        logger.info('Agent loop: sending mixed-turn upstream request', {
          projectId: options.projectId,
          sessionId: options.sessionId,
          requestId: options.requestId,
          turn: turn + 1,
          model: ctx.model,
          url: options.url,
          messageCount: workingRequest.messages.length,
          toolCount: (workingRequest.tools as unknown[] | undefined)?.length ?? 0,
          lastMessageRole: workingRequest.messages[workingRequest.messages.length - 1]?.role,
        });

        const { result: response } = await withParamFallback(
          workingRequest,
          options.adapter,
          ctx,
          async (payload) => axios.post(options.url, payload, {
            headers: options.headers,
            timeout: 120_000,
          }),
        );

        responseData = response.data;
        normalizedResponse = options.adapter.parseResponse(responseData);
        internalTurnCount += 1;
        continue; // re-enter the loop with the model's new response
      } catch (error) {
        // The internal tool turn failed (axios 5xx, timeout, network
        // blip, etc.).  We log and return a partial response to the
        // caller. The successful IC tool results were already appended
        // to the working request and replay cache before this POST, so
        // the next request can continue from coherent history without
        // adding a duplicate tool result for the same tool_call_id.
        const errorMessage = error instanceof Error ? error.message : String(error);
        const axiosStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
        logger.error('Internal learning tool turn failed after mixed tools; registering failure and continuing', {
          projectId: options.projectId,
          sessionId: options.sessionId,
          requestId: options.requestId,
          turn: turn + 1,
          model: ctx.model,
          axiosStatus,
          error: errorMessage,
        });
        // Build a synthetic response that surfaces the failure to the
        // upstream model: it explains which tools failed and asks the
        // model to continue.  We don't try to keep the agent loop
        // running inside this turn. The next HTTP request from the IDE
        // will still see the successful tool results via replay.
        const fallback = buildTurnFailureFallbackResponse(options, errorMessage, axiosStatus);
        return {
          responseData: fallback,
          normalizedResponse: options.adapter.parseResponse(fallback),
          internalTurnCount: internalTurnCount + 1,
        };
      }
    }

    const assistantMessage = getAssistantMessage(normalizedResponse);
    if (!assistantMessage) {
      throw new Error('Upstream returned tool calls without an assistant message.');
    }

    const toolResults = await Promise.all(
      learningToolCalls.map((toolCall) => buildToolResultMessage(
        toolCall,
        options.projectId,
        options.sessionId,
        options.requestId,
      ))
    );
    const toolResultMessages = toolResults.map((toolResult) => toolResult.message);

    workingRequest.messages = [
      ...workingRequest.messages,
      cloneAssistantMessage(assistantMessage),
      ...toolResultMessages,
    ];

    const icToolNames = learningToolCalls.map((toolCall) => getToolName(toolCall)).filter(Boolean) as string[];

    logger.info('Agent loop: ic_-only tool turn — appending assistant message + tool results', {
      projectId: options.projectId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      turn: turn + 1,
      icToolNames,
      messageCountAfterAppend: workingRequest.messages.length,
      lastMessageRole: workingRequest.messages[workingRequest.messages.length - 1]?.role,
    });

    appendToolResultReplayEntriesForSession(
      options.projectId,
      options.sessionId,
      toolResults.map((toolResult) => toolResult.replayEntry),
    );

    const ctx: ParamFallbackContext = {
      projectId: options.projectId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      model: workingRequest.model ?? options.request.model ?? 'unknown',
      providerName: options.providerName,
      providerType: options.providerType,
      url: options.url,
      requestHeaders: options.headers,
    };

    try {
      logger.info('Agent loop: sending ic_-only upstream request', {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        turn: turn + 1,
        model: ctx.model,
        url: options.url,
        messageCount: workingRequest.messages.length,
        toolCount: (workingRequest.tools as unknown[] | undefined)?.length ?? 0,
        lastMessageRole: workingRequest.messages[workingRequest.messages.length - 1]?.role,
        icToolNames,
      });

      const { result: response } = await withParamFallback(
        workingRequest,
        options.adapter,
        ctx,
        async (payload) => axios.post(options.url, payload, {
          headers: options.headers,
          timeout: 120_000,
        }),
      );

      responseData = response.data;
      normalizedResponse = options.adapter.parseResponse(responseData);
      internalTurnCount += 1;
    } catch (error) {
      // Mirror the mixed-tools branch above: instead of throwing and
      // aborting the entire conversation, return a partial response so
      // the IDE can see the error and the user can continue on the
      // next request. The successful tool results were already cached.
      const errorMessage = error instanceof Error ? error.message : String(error);
      const axiosStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
      logger.error('Internal learning tool turn failed; registering failure and continuing', {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        turn: turn + 1,
        model: ctx.model,
        axiosStatus,
        error: errorMessage,
      });
      const fallback = buildTurnFailureFallbackResponse(options, errorMessage, axiosStatus);
      return {
        responseData: fallback,
        normalizedResponse: options.adapter.parseResponse(fallback),
        internalTurnCount: internalTurnCount + 1,
      };
    }
  }

  throw new Error(`Learning tool loop exceeded ${maxTurns} turns.`);
}