/**
 * Project chat agent.
 *
 * Runs a single conversational turn against the configured chat model, exposing
 * the same `ic` / `ic_*` learning tools the proxied agents use.
 *
 * Two entry points share one request-building path:
 *   - `runChatTurn`        — non-streaming; returns the final text.
 *   - `runChatTurnStream`  — streams text deltas as they arrive and, when the
 *                            model asks for knowledge tools, runs the server-side
 *                            agent loop and streams its resolved answer.
 *
 * The primary purpose is project Q&A over the accumulated knowledge base, with
 * the secondary ability to modify that knowledge (merge/trim summaries, update
 * chunks, resolve findings) purely through `ic` tool calls.
 */
import axios from 'axios';
import { providersRepo } from '../db/repositories/providers';
import { getSystemModelConfig } from '../config/systemModels';
import { resolveProviderAndModelForJob } from '../proxy/upstream';
import { applyUpstreamRequestMiddleware } from '../proxy/requestMiddleware';
import { getLearningToolsForClientProtocol } from '../proxy/tools/definitions';
import { runLearningToolAgentLoop } from '../proxy/tools/agentLoop';
import { withParamFallback, type ParamFallbackContext } from '../utils/paramFallback';
import { getModelSupportsVisionForProvider } from '../proxy/modelMetadataCache';
import { getModelReference } from '../proxy/modelReferenceCache';
import {
  containsImages,
  describeImageWithVisionModel,
  replaceImagesWithDescriptions,
  type ExtractedImage,
} from '../proxy/vision';
import { parseSseToProxyResponse } from '../proxy/unifiedStream';
import { parseAnthropicSseToResponseData } from '../proxy/anthropicSseBridge';
import { LEARNING_SYSTEM_INSTRUCTION } from '../learning/systemInstruction';
import { contentToText } from '../utils/messageContent';
import { recordStat, generateRunId } from '../utils/stats';
import { estimateTokens } from '../utils/tokens';
import { AppError } from '../utils/appErrors';
import { logger } from '../utils/logger';
import {
  resolveKnowledgeReferences,
  KNOWLEDGE_REF_HEADER,
  type KnowledgeRef,
} from './knowledgeContext';
import { canUseChatModel } from './chatModels';
import type { PublicUser } from '../db/repositories/users';
import type { ChatMessage, ProxyRequest, ProxyResponse } from '../proxy/adapters/adapter';

const CHAT_MAX_TURNS = 12;
const CHAT_MAX_OUTPUT_TOKENS = 4000;
const CHAT_TIMEOUT_MS = 180_000;
const MAX_ATTACHMENT_TEXT_CHARS = 120_000;

/** A file uploaded through the chat composer. */
export interface ChatAttachment {
  name: string;
  mimeType?: string;
  /** Text content for text/code attachments. */
  text?: string;
  /** Base64 payload (no data: prefix) for image attachments. */
  data?: string;
}

export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  /** Stored knowledge entities to pull into this message. */
  knowledge?: KnowledgeRef[];
}

export interface ChatTurnOptions {
  projectId: string;
  messages: ChatTurnMessage[];
  /** Explicit model override (scoped catalog id). Falls back to config. */
  model?: string;
  sessionId?: string;
  requestId?: string;
  /**
   * The authenticated caller. Used to enforce model access — a user may only
   * chat with a model they are allowed to reach.
   */
  user?: PublicUser;
}

export interface ChatTurnResult {
  content: string;
  model: string;
  providerName: string;
  internalTurnCount: number;
}

/** Events emitted by the streaming chat turn. */
export type ChatStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'status'; status: 'tool'; tool?: string }
  | { type: 'done'; model: string; providerName: string; internalTurnCount: number }
  | { type: 'error'; error: string };

export type ChatStreamEmitter = (event: ChatStreamEvent) => void;

/**
 * Chat-specific guidance appended after the shared `ic` tool instructions.
 * Mirrors the analyzer's "fewer, larger summaries" policy so the user can ask
 * the same kinds of consolidation questions with explicit guidance.
 */
const CHAT_GUIDANCE = `ROLE
You are the project knowledge assistant for the intelligent-context management UI. You answer questions about the selected project's accumulated knowledge (chunks, summaries, files, findings) and, when asked, modify that knowledge through the \`ic\` tool. You are already scoped to the currently selected project — never ask the user which project, and never pass a projectId.

ANSWERING QUESTIONS
- Prefer the project context already provided, then use \`ic\` get/list/search operations to fill gaps.
- Ground every answer in stored knowledge. Quote the relevant fact or summary id when useful.
- If the knowledge base does not contain the answer, say so plainly instead of guessing.

ATTACHED KNOWLEDGE
- A user message may carry an "Attached project knowledge" block containing one or more summaries, findings, or files (a file block also lists every chunk and summary linked to that file).
- Treat attached knowledge as the authoritative, in-focus data for the turn: answer from it first, and when the user asks to change it, operate on those exact ids.

MODIFYING KNOWLEDGE
- Prefer fewer, larger summaries over many small ones. When two summaries cover the same topic, merge them: \`ic update\` one summary with the combined content, a merged oneLineSummary, the union of their categories, and the union of their sourceChunkIds, then \`ic delete\` the other summary.
- Reduce an oversized summary by rewriting its content more concisely while keeping every distinct fact; update the oneLineSummary to match.
- Fix stale or wrong chunks with \`ic update\` (fact/category/confidence) and remove duplicates with \`ic delete\`.
- Confirm destructive changes (delete) with the user first unless they explicitly asked for them in this turn.
- After modifying, briefly report exactly what changed (ids and one-line description).`;

function isImageAttachment(attachment: ChatAttachment): boolean {
  if (attachment.data && !attachment.text) return true;
  return typeof attachment.mimeType === 'string' && attachment.mimeType.startsWith('image/');
}

/** Convert one user turn into a ChatMessage, expanding attachments + knowledge. */
async function buildUserMessage(projectId: string, message: ChatTurnMessage): Promise<ChatMessage> {
  const attachments = message.attachments ?? [];
  const knowledge = message.knowledge ?? [];

  const knowledgeBlocks = knowledge.length > 0
    ? await resolveKnowledgeReferences(projectId, knowledge)
    : [];
  const knowledgeText = knowledgeBlocks.length > 0
    ? `${KNOWLEDGE_REF_HEADER}\n\n${knowledgeBlocks.join('\n\n')}`
    : '';

  if (attachments.length === 0 && !knowledgeText) {
    return { role: 'user', content: message.content };
  }

  const parts: unknown[] = [];
  const trimmedContent = message.content.trim();
  if (trimmedContent) {
    parts.push({ type: 'text', text: trimmedContent });
  }

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      const mimeType = attachment.mimeType?.startsWith('image/') ? attachment.mimeType : 'image/png';
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${(attachment.data ?? '').replace(/\s/g, '')}` },
      });
      continue;
    }

    const text = (attachment.text ?? '').slice(0, MAX_ATTACHMENT_TEXT_CHARS);
    parts.push({
      type: 'text',
      text: `--- Attached file: ${attachment.name} ---\n${text}`,
    });
  }

  if (knowledgeText) {
    parts.push({ type: 'text', text: knowledgeText });
  }

  return { role: 'user', content: parts };
}

async function toChatMessages(projectId: string, messages: ChatTurnMessage[]): Promise<ChatMessage[]> {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    result.push(
      message.role === 'user'
        ? await buildUserMessage(projectId, message)
        : { role: 'assistant', content: message.content }
    );
  }
  return result;
}

/**
 * Route images to the configured vision model when the chat model cannot see
 * them itself. Mirrors the proxy's delegation rules but keeps the vision model
 * and the chat model independent.
 */
async function applyChatVisionDelegation(
  messages: ChatMessage[],
  execution: { model: string; providerName: string; providerType: string },
  ctx: { projectId: string; sessionId?: string; requestId: string }
): Promise<void> {
  if (!containsImages(messages)) return;

  // A model the user marked (or the reference catalog reports) as vision-capable
  // sees the images itself.
  const provider = await providersRepo.findProviderForModel(execution.model);
  if (provider && getModelSupportsVisionForProvider(provider.id, execution.model) === true) return;
  if (getModelReference(execution.model)?.supportsVision === true) return;

  const visionSelection = getSystemModelConfig().vision.trim();
  if (!visionSelection) return;

  const visionExecution = await resolveProviderAndModelForJob(visionSelection, 'openai');
  if (!visionExecution) return;

  // Delegating a model to itself cannot add vision capability.
  if (visionExecution.model === execution.model && visionExecution.providerName === execution.providerName) {
    return;
  }

  const replaced = await replaceImagesWithDescriptions(messages, async (image: ExtractedImage) => {
    try {
      const description = await describeImageWithVisionModel(visionExecution, image, {
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
      });
      return `<image_description>\n${description.trim()}\n</image_description>`;
    } catch (err) {
      logger.warn('Chat vision delegation failed for an image', {
        projectId: ctx.projectId,
        requestId: ctx.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      return '<image_description unavailable="true">The image could not be interpreted by the configured vision model.</image_description>';
    }
  });

  if (replaced > 0) {
    logger.info('Chat images interpreted by the vision model', {
      projectId: ctx.projectId,
      requestId: ctx.requestId,
      visionModel: visionSelection,
      imageCount: replaced,
    });
  }
}

/**
 * Resolve the model for a chat turn: explicit request override first, then the
 * configured chat model, then the ic-tools model as a pragmatic fallback.
 *
 * Every candidate is checked against the caller's model access so a restricted
 * user can never chat with a model they are not granted, even if they tamper
 * with the request. A configured default the user cannot reach is skipped
 * rather than failing the turn outright.
 */
async function resolveChatExecution(
  projectId: string,
  modelOverride: string | undefined,
  user: PublicUser | undefined
): Promise<Awaited<ReturnType<typeof resolveProviderAndModelForJob>>> {
  const models = getSystemModelConfig();

  const requested = modelOverride?.trim();
  if (requested && !canUseChatModel(user, requested)) {
    throw new AppError('You do not have access to the selected model.', {
      statusCode: 403,
      code: 'chat_model_forbidden',
      publicMessage: 'You do not have access to the selected model.',
    });
  }

  const candidates = [requested, models.chat.trim(), models.icTools.trim()].filter(
    (value): value is string => Boolean(value && value.length > 0 && canUseChatModel(user, value))
  );

  for (const candidate of candidates) {
    const execution = await resolveProviderAndModelForJob(candidate, 'openai');
    if (execution) return execution;
  }

  logger.warn('Chat turn has no resolvable model', { projectId, modelOverride });
  return null;
}

interface PreparedChatRequest {
  projectId: string;
  request: ProxyRequest;
  url: string;
  headers: Record<string, string>;
  requestId: string;
  runId: string;
  model: string;
  providerName: string;
  providerType: string;
  toolClientProtocol: 'openai' | 'anthropic';
  adapter: NonNullable<Awaited<ReturnType<typeof resolveProviderAndModelForJob>>>['adapter'];
  isAnthropicUpstream: boolean;
  ctx: ParamFallbackContext;
  sessionId?: string;
}

/** Validate, resolve the model, and build the upstream chat request. */
async function prepareChatRequest(
  options: ChatTurnOptions,
  stream: boolean
): Promise<PreparedChatRequest> {
  const { projectId } = options;
  if (!Array.isArray(options.messages) || options.messages.length === 0) {
    throw new AppError('At least one message is required.', {
      statusCode: 400,
      code: 'chat_empty',
      publicMessage: 'At least one message is required.',
    });
  }

  const execution = await resolveChatExecution(projectId, options.model, options.user);
  if (!execution) {
    throw new AppError('No chat model is configured.', {
      statusCode: 400,
      code: 'chat_no_model',
      publicMessage: 'No chat model is configured. Select one in Settings.',
    });
  }

  const { adapter, baseUrl, apiKey, providerName, providerType } = execution;
  const model = execution.model;
  const requestId = options.requestId ?? `chat-${generateRunId()}`;

  const chatMessages = await toChatMessages(projectId, options.messages);
  await applyChatVisionDelegation(chatMessages, { model, providerName, providerType }, {
    projectId,
    sessionId: options.sessionId,
    requestId,
  });

  const systemPrompt = `${LEARNING_SYSTEM_INSTRUCTION}\n\n${CHAT_GUIDANCE}`;
  const toolClientProtocol = providerType === 'anthropic' ? 'anthropic' : 'openai';
  const request: ProxyRequest = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...chatMessages],
    stream,
    temperature: 0.3,
    max_tokens: CHAT_MAX_OUTPUT_TOKENS,
    tools: getLearningToolsForClientProtocol(toolClientProtocol),
    tool_choice: 'auto',
  };

  const url = adapter.endpoint(baseUrl);
  const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey), {
    sessionId: options.sessionId,
    projectId,
    jobKey: `chat:${projectId}`,
  });

  const runId = generateRunId();
  const promptText = contentToText(request.messages[0]?.content);

  recordStat({
    projectId,
    sessionId: options.sessionId,
    requestId,
    model,
    runId,
    type: 'chat',
    direction: 'input',
    meta: { messageCount: options.messages.length, providerName, providerType, stream },
    tokens: estimateTokens(promptText),
    body: promptText,
  });

  const ctx: ParamFallbackContext = {
    projectId,
    sessionId: options.sessionId,
    requestId,
    model,
    providerName,
    providerType,
    url,
    requestHeaders: headers,
  };

  return {
    projectId,
    request,
    url,
    headers,
    requestId,
    runId,
    model,
    providerName,
    providerType,
    toolClientProtocol,
    adapter,
    isAnthropicUpstream: providerType === 'anthropic',
    ctx,
    sessionId: options.sessionId,
  };
}

function recordChatOutput(
  prepared: PreparedChatRequest,
  content: string,
  internalTurnCount: number,
  usage?: ProxyResponse['usage']
): void {
  recordStat({
    projectId: prepared.projectId,
    sessionId: prepared.sessionId,
    requestId: prepared.requestId,
    model: prepared.model,
    runId: prepared.runId,
    type: 'chat',
    direction: 'output',
    meta: {
      providerName: prepared.providerName,
      internalTurnCount,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
    },
    tokens: usage?.completion_tokens ?? estimateTokens(content),
    body: content,
  });
}

/** Run one non-streaming chat turn with the ic tool loop. */
export async function runChatTurn(options: ChatTurnOptions): Promise<ChatTurnResult> {
  const prepared = await prepareChatRequest(options, false);
  const { request, adapter, ctx, url, headers, providerName, providerType, toolClientProtocol } = prepared;

  try {
    let responseData: unknown;
    let normalized: ProxyResponse;
    ({ result: normalized } = await withParamFallback(request, adapter, ctx, async (payload) => {
      const response = await axios.post(url, payload, { headers, timeout: CHAT_TIMEOUT_MS });
      responseData = response.data;
      return adapter.parseResponse(response.data);
    }));

    let internalTurnCount = 0;
    const firstChoice = normalized.choices?.[0];
    const initialToolCalls = (firstChoice?.message as { tool_calls?: unknown } | undefined)?.tool_calls;

    if (firstChoice?.finish_reason === 'tool_calls' || Array.isArray(initialToolCalls)) {
      const loopResult = await runLearningToolAgentLoop({
        url,
        headers,
        adapter,
        request,
        projectId: prepared.projectId,
        sessionId: prepared.sessionId,
        requestId: prepared.requestId,
        providerName,
        providerType,
        initialResponseData: responseData,
        initialNormalizedResponse: normalized,
        maxTurns: CHAT_MAX_TURNS,
        toolClientProtocol,
      });

      normalized = loopResult.normalizedResponse;
      internalTurnCount = loopResult.internalTurnCount;
    }

    const content = contentToText(normalized.choices?.[0]?.message?.content).trim();
    recordChatOutput(prepared, content, internalTurnCount, normalized.usage);

    logger.info('Chat turn completed', {
      projectId: prepared.projectId,
      requestId: prepared.requestId,
      model: prepared.model,
      providerName,
      internalTurnCount,
      contentLength: content.length,
    });

    return {
      content: content || '(The model returned an empty response.)',
      model: prepared.model,
      providerName,
      internalTurnCount,
    };
  } catch (err) {
    logger.error('Chat turn failed', {
      projectId: prepared.projectId,
      requestId: prepared.requestId,
      model: prepared.model,
      providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AppError('The chat request failed.', {
      statusCode: 502,
      code: 'chat_upstream_failed',
      publicMessage: 'The chat request failed. Check the provider configuration and try again.',
      details: { providerName, model: prepared.model },
    });
  }
}

// ── Streaming ──────────────────────────────────────────────────────────────

/** Accumulates raw SSE text while emitting each complete `data:` line. */
async function readSseStream(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): Promise<string> {
  let buffer = '';
  let raw = '';

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      raw += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        onLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) {
        onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
        raw += '\n';
      }
      resolve();
    });
    stream.on('error', reject);
  });

  return raw;
}

interface ParsedDelta {
  /** Live text to forward to the client, if any. */
  text?: string;
  /** Learning-tool names seen in this delta. */
  toolNames?: string[];
}

/** Extract streamed text and any learning-tool names from one SSE data line. */
function parseStreamDelta(json: Record<string, unknown>, isAnthropic: boolean): ParsedDelta {
  if (isAnthropic) {
    // Anthropic: content_block_delta { delta: { type: 'text_delta', text } }
    const delta = json.delta as Record<string, unknown> | undefined;
    if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
      return { text: delta.text };
    }
    // Anthropic: content_block_start { content_block: { type: 'tool_use', name } }
    const block = json.content_block as Record<string, unknown> | undefined;
    if (json.type === 'content_block_start' && block?.type === 'tool_use' && typeof block.name === 'string') {
      return { toolNames: [block.name] };
    }
    return {};
  }

  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return {};

  const result: ParsedDelta = {};
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    result.text = delta.content;
  }

  const toolCalls = delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    const names = toolCalls
      .map((call) => (call as { function?: { name?: unknown } })?.function?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    if (names.length > 0) result.toolNames = names;
  }

  return result;
}

/**
 * Stream one chat turn.
 *
 * Text deltas are forwarded live. If the model asks for knowledge tools, the
 * stream emits a `status` event, runs the server-side agent loop, and then
 * streams the resolved answer (only the portion not already forwarded).
 */
export async function runChatTurnStream(
  options: ChatTurnOptions,
  emit: ChatStreamEmitter
): Promise<void> {
  let prepared: PreparedChatRequest;
  try {
    prepared = await prepareChatRequest(options, true);
  } catch (err) {
    emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const { request, adapter, ctx, url, headers, providerName, providerType, toolClientProtocol } = prepared;

  let forwardedText = '';
  let toolDetected = false;
  let detectedToolName: string | undefined;

  try {
    let rawSse = '';
    await withParamFallback(request, adapter, ctx, async (payload) => {
      const response = await axios.post(url, payload, {
        headers,
        responseType: 'stream',
        timeout: CHAT_TIMEOUT_MS,
      });

      rawSse = await readSseStream(response.data as NodeJS.ReadableStream, (line) => {
        if (!line.startsWith('data: ')) return;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') return;

        let json: Record<string, unknown>;
        try {
          json = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          return;
        }

        const parsed = parseStreamDelta(json, prepared.isAnthropicUpstream);

        if (parsed.toolNames && parsed.toolNames.some((name) => name.startsWith('ic'))) {
          if (!toolDetected) {
            toolDetected = true;
            detectedToolName = parsed.toolNames.find((name) => name.startsWith('ic'));
            emit({ type: 'status', status: 'tool', tool: detectedToolName });
          }
          return;
        }

        // Once a tool call is in flight the turn is resolved by the agent loop,
        // so later content deltas are not part of the user-facing answer.
        if (!toolDetected && parsed.text) {
          forwardedText += parsed.text;
          emit({ type: 'delta', content: parsed.text });
        }
      });

      return { data: rawSse };
    });

    let internalTurnCount = 0;
    let finalText = forwardedText;
    let usage: ProxyResponse['usage'];

    if (toolDetected) {
      const reconstructed = prepared.isAnthropicUpstream
        ? parseAnthropicSseToResponseData(rawSse)
        : parseSseToProxyResponse(rawSse);

      if (reconstructed) {
        const normalized = adapter.parseResponse(reconstructed);
        const loopResult = await runLearningToolAgentLoop({
          url,
          headers,
          adapter,
          request,
          projectId: prepared.projectId,
          sessionId: prepared.sessionId,
          requestId: prepared.requestId,
          providerName,
          providerType,
          initialResponseData: reconstructed,
          initialNormalizedResponse: normalized,
          maxTurns: CHAT_MAX_TURNS,
          toolClientProtocol,
        });

        internalTurnCount = loopResult.internalTurnCount;
        finalText = contentToText(loopResult.normalizedResponse.choices?.[0]?.message?.content).trim();
        usage = loopResult.normalizedResponse.usage;

        // Emit only the portion of the resolved answer that was not already
        // streamed, so a pre-tool preamble is not duplicated.
        const remainder = finalText.startsWith(forwardedText)
          ? finalText.slice(forwardedText.length)
          : (forwardedText ? `\n\n${finalText}` : finalText);
        if (remainder) emit({ type: 'delta', content: remainder });
      } else {
        logger.warn('Chat stream: could not reconstruct tool-call response from SSE', {
          projectId: prepared.projectId,
          requestId: prepared.requestId,
        });
      }
    } else if (!prepared.isAnthropicUpstream) {
      // Reconstruct usage for telemetry from the OpenAI-format SSE.
      usage = parseSseToProxyResponse(rawSse).usage;
    }

    recordChatOutput(prepared, finalText, internalTurnCount, usage);
    emit({
      type: 'done',
      model: prepared.model,
      providerName,
      internalTurnCount,
    });

    logger.info('Chat stream completed', {
      projectId: prepared.projectId,
      requestId: prepared.requestId,
      model: prepared.model,
      providerName,
      internalTurnCount,
      toolDetected,
      contentLength: finalText.length,
    });
  } catch (err) {
    logger.error('Chat stream failed', {
      projectId: prepared.projectId,
      requestId: prepared.requestId,
      model: prepared.model,
      providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    emit({
      type: 'error',
      error: 'The chat request failed. Check the provider configuration and try again.',
    });
  }
}
