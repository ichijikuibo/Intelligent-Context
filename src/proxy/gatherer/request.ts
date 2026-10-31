import type { ChatMessage, ProxyRequest } from '../adapters/adapter';
import { GATHERER_SYSTEM_PROMPT } from '../../learning/gathererPrompt';
import { LEARNING_CALL_TO_ACTION_TAG } from '../../learning/systemInstruction';
import type { GathererContextSelection } from '../../context/selector';
import type { GathererAssistantContinuationMessage } from './phase';
import { logger } from '../../utils/logger';
import { assembleContextShortlistMessage } from '../middleware/contextInject';

/**
 * Build the request body for the gatherer pipe. Mirrors the design in
 * `docs/two-stage-request-splitting.md` (sections 5.2 / 5.5).
 *
 * The gatherer receives:
 *   - the `GATHERER_SYSTEM_PROMPT` at index 0 (read-only researcher role),
 *   - the past-knowledge `## Project Context` block from
 *     `contextInjectMiddleware` (if it was built), so the cheap model
 *     can use already-stored facts as a starting point and not
 *     re-derive them from the codebase.  This is the same block the
 *     main model would see on the non-gatherer path, so the
 *     gatherer's `<gatherer_analysis>` handoff does not duplicate
 *     content the main model already has,
 *   - the gatherer selection shortlist (lightweight descriptors) when
 *     one was prepared.  Carries IDs and one-line summaries for any
 *     summaries/files the selector thinks are relevant, so the
 *     gatherer can `ic get` them for full detail when needed,
 *   - non-system messages from the original request (user, assistant,
 *     and tool turns are passed through so the gatherer sees the full
 *     conversation history, including previous tool turns),
 *   - the original `tools` list (so the gatherer can call IDE tools like
 *     `read_file`, `grep_search`, `file_search`),
 *   - the resolved gatherer model,
 *   - streaming forced on (the gatherer must be streaming to support tool
 *     calls and the multi-turn agent loop).
 *
 * The gatherer is told via the system prompt to gather only — never to
 * implement.
 */
export function buildGathererRequest(
  originalBody: ProxyRequest,
  gathererModel: string,
  selectionContext?: GathererContextSelection | null,
  assistantContinuationMessage?: GathererAssistantContinuationMessage | null,
  projectName?: string,
  pastKnowledgeBlock?: string | null,
): ProxyRequest {
  const originalMessageCount = originalBody.messages?.length ?? 0;
  const originalSystemCount = originalBody.messages?.filter((m) => m.role === 'system').length ?? 0;
  const originalUserCount = originalBody.messages?.filter((m) => m.role === 'user').length ?? 0;
  const originalAssistantCount = originalBody.messages?.filter((m) => m.role === 'assistant').length ?? 0;
  const originalToolCount = originalBody.messages?.filter((m) => m.role === 'tool').length ?? 0;

  const gathererInstruction: ChatMessage = {
    role: 'system',
    content: GATHERER_SYSTEM_PROMPT,
  };
  const pastKnowledgeInstruction: ChatMessage | null = pastKnowledgeBlock && pastKnowledgeBlock.trim()
    ? {
        role: 'system',
        content: [
          'The following `## Project Context` block is durable, pre-selected project knowledge',
          'the proxy has chosen as relevant to this request.  Treat it as the starting point',
          'for your gather: anything recorded here is already in the knowledge store, so',
          'you do NOT need to re-read those files or re-derive those facts — focus on gaps.',
          'If a referenced file or summary is missing or stale, prefer reading the source',
          'directly over relying on the block.',
          '',
          pastKnowledgeBlock,
        ].join('\n'),
      }
    : null;
  const selectionInstruction = selectionContext
    ? buildGathererSelectionInstruction(selectionContext, projectName)
    : null;

  // Strip IDE system prompts (e.g. "you are a coding assistant") that
  // conflict with the gatherer's own instruction, but KEEP any system
  // messages that carry injected project context (identified by the
  // `<project_context>` marker) so the gatherer is grounded in real
  // project knowledge without having to rediscover it via tool calls.
  //
  // Also strip the per-turn `record_learning` call-to-action user
  // message that `createLearningToolsMiddleware` appends.  Learning
  // capture is the main model's job (not the gatherer's), so the
  // gatherer should not see a "call record_learning before you
  // respond" nudge — and the gatherer's role-reminder logic below
  // would otherwise attach to that message instead of the user's
  // real last turn, mis-anchoring the reminder.
  const nonSystemMessages = (originalBody.messages ?? []).filter(
    (m) => {
      if (m.role === 'user'
        && typeof m.content === 'string'
        && m.content.includes(LEARNING_CALL_TO_ACTION_TAG)) {
        return false;
      }
      if (m.role !== 'system') return true;
      if (typeof m.content === 'string' && m.content.includes('<project_context>')) return true;
      return false;
    }
  );
  const strippedSystemCount = originalSystemCount - nonSystemMessages.filter((m) => m.role === 'system').length;
  const strippedCtaCount = (originalBody.messages ?? []).filter(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(LEARNING_CALL_TO_ACTION_TAG)
  ).length;

  const replayedMessages = mergeAssistantContinuationMessage(
    nonSystemMessages,
    assistantContinuationMessage,
  );
  const hasContinuationMerge = replayedMessages.length !== nonSystemMessages.length || (
    assistantContinuationMessage !== null && assistantContinuationMessage !== undefined
  );

  // Per-turn reinforcement: the gatherer system prompt is at the top of
  // the conversation, but on later turns a fresh user request ("now do
  // X") tends to override the system instruction in the model's
  // attention.  Append a short role reminder onto the trailing user
  // message so the gatherer role is reasserted in the model's "current
  // task" window.  We only touch the last user-role message; assistant
  // and tool turns are left alone.
  const reminder = '\n\n[gatherer reminder: gather information only and produce a <gatherer_analysis> block. Do not implement or answer the request directly.]';
  const reinforced = [...replayedMessages];
  let reminderAppended = false;
  for (let i = reinforced.length - 1; i >= 0; i--) {
    if (reinforced[i].role === 'user') {
      const msg = reinforced[i];
      const text = typeof msg.content === 'string' ? msg.content + reminder : msg.content;
      reinforced[i] = { ...msg, content: text };
      reminderAppended = true;
      break;
    }
  }

  let gathererRequest: ProxyRequest = {
    ...originalBody,
    model: gathererModel,
    stream: true,
    messages: [
      gathererInstruction,
      ...(pastKnowledgeInstruction ? [pastKnowledgeInstruction] : []),
      ...(selectionInstruction ? [selectionInstruction] : []),
      ...reinforced,
    ],
  };

  // Log the full mutation summary
  const finalMessages = gathererRequest.messages;
  const finalSystemCount = finalMessages.filter((m) => m.role === 'system').length;
  const finalUserCount = finalMessages.filter((m) => m.role === 'user').length;
  const finalAssistantCount = finalMessages.filter((m) => m.role === 'assistant').length;
  const finalToolCount = finalMessages.filter((m) => m.role === 'tool').length;

  logger.info('Gatherer request built from original', {
    gathererModel,
    originalMessageCount,
    originalBreakdown: { system: originalSystemCount, user: originalUserCount, assistant: originalAssistantCount, tool: originalToolCount },
    strippedSystemMessages: strippedSystemCount,
    strippedLearningCta: strippedCtaCount,
    hasSelectionContext: !!selectionContext,
    hasPastKnowledgeBlock: !!pastKnowledgeInstruction,
    pastKnowledgeBlockLength: pastKnowledgeInstruction ? String(pastKnowledgeInstruction.content).length : 0,
    hasContinuationMerge,
    reminderAppended,
    finalMessageCount: finalMessages.length,
    finalBreakdown: { system: finalSystemCount, user: finalUserCount, assistant: finalAssistantCount, tool: finalToolCount },
  });

  return gathererRequest;
}

function mergeAssistantContinuationMessage(
  messages: ChatMessage[],
  assistantContinuationMessage?: GathererAssistantContinuationMessage | null,
): ChatMessage[] {
  if (!assistantContinuationMessage || assistantContinuationMessage.role !== 'assistant') {
    return [...messages];
  }

  const merged = [...messages];
  const assistantIndex = findContinuationAssistantIndex(merged);

  if (assistantIndex >= 0) {
    merged[assistantIndex] = mergeAssistantMessages(
      merged[assistantIndex]!,
      assistantContinuationMessage,
    );
    return merged;
  }

  const insertionIndex = findContinuationInsertionIndex(merged);
  if (insertionIndex >= 0) {
    merged.splice(insertionIndex, 0, cloneAssistantContinuationMessage(assistantContinuationMessage));
    return merged;
  }

  return [...merged, cloneAssistantContinuationMessage(assistantContinuationMessage)];
}

function findContinuationAssistantIndex(messages: ChatMessage[]): number {
  let sawContinuationTail = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (sawContinuationTail && message.role === 'assistant') {
      return i;
    }

    if (isToolContinuationMessage(message)) {
      sawContinuationTail = true;
      continue;
    }

    if (sawContinuationTail) {
      return -1;
    }
  }

  return -1;
}

function findContinuationInsertionIndex(messages: ChatMessage[]): number {
  let insertionIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (isToolContinuationMessage(message)) {
      insertionIndex = i;
      continue;
    }

    break;
  }

  return insertionIndex;
}

function mergeAssistantMessages(
  existingMessage: ChatMessage,
  replayMessage: GathererAssistantContinuationMessage,
): GathererAssistantContinuationMessage {
  const existingRecord = existingMessage as unknown as Record<string, unknown>;
  const merged: GathererAssistantContinuationMessage = {
    ...replayMessage,
    ...existingMessage,
    role: 'assistant',
    content: existingMessage.content ?? replayMessage.content ?? '',
  };

  if ((!Array.isArray(existingMessage.tool_calls) || existingMessage.tool_calls.length === 0) && Array.isArray(replayMessage.tool_calls)) {
    merged.tool_calls = [...replayMessage.tool_calls];
  }

  if (typeof existingRecord.reasoning_content !== 'string' && typeof replayMessage.reasoning_content === 'string') {
    merged.reasoning_content = replayMessage.reasoning_content;
  }

  if (typeof existingRecord.reasoning !== 'string' && typeof replayMessage.reasoning === 'string') {
    merged.reasoning = replayMessage.reasoning;
  }

  return merged;
}

function cloneAssistantContinuationMessage(
  message: GathererAssistantContinuationMessage,
): GathererAssistantContinuationMessage {
  return {
    ...message,
    role: 'assistant',
    tool_calls: Array.isArray(message.tool_calls)
      ? [...message.tool_calls]
      : undefined,
  };
}

function isToolContinuationMessage(message: ChatMessage): boolean {
  if (message.role === 'tool') return true;
  if (message.role === 'user') return isPureToolBlockMessage(message.content, 'tool_result');
  if (message.role === 'assistant') return isPureToolBlockMessage(message.content, 'tool_use');
  return false;
}

function isPureToolBlockMessage(content: unknown, toolBlockType: 'tool_result' | 'tool_use'): boolean {
  if (!Array.isArray(content)) return false;

  let hasToolBlock = false;
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim().length === 0) continue;
      return false;
    }

    if (typeof block !== 'object' || block === null) return false;

    const type = (block as Record<string, unknown>).type;
    if (type === toolBlockType) {
      hasToolBlock = true;
      continue;
    }

    if (type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim().length === 0) continue;
    }

    return false;
  }

  return hasToolBlock;
}

/**
 * Build the `<gatherer_analysis>` block that gets injected into the
 * main model's messages after the gatherer pipe completes.
 */
export function buildGathererContextBlock(gathererText: string): string {
  // The gatherer model already wraps its output in a <gatherer_analysis>
  // block (enforced by the gatherer system prompt).  Do NOT re-wrap here —
  // that would produce nested <gatherer_analysis> tags that confuse the
  // main model.  Instead, just prepend a brief context note.
  // Injected as a user message so the main model treats it as material to
  // work with rather than authoritative instructions.
  return [
    'The following context was retrieved by an automated codebase scan to save you time on file lookups.',
    'The file contents and search results should be accurate, but any analysis or conclusions from the scanner may be incomplete — apply your own reasoning.',
    '',
    gathererText,
    '',
    '---',
  ].join('\n');
}

function buildGathererSelectionInstruction(
  selectionContext: GathererContextSelection,
  projectName?: string,
): ChatMessage {
  return {
    role: 'system',
    content: assembleContextShortlistMessage(selectionContext, projectName ?? 'Project'),
  };
}
