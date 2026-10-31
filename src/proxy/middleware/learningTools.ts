import type { RequestHandler } from 'express';
import type { ChatMessage, ProxyRequest } from '../adapters/adapter';
import type { ClientProtocol } from '../clientProtocols';
import { getSingleIcToolForClientProtocol } from '../tools/definitions';
import { getSystemModelConfig } from '../../config/systemModels';
import {
  LEARNING_CALL_TO_ACTION,
  LEARNING_CALL_TO_ACTION_TAG,
  LEARNING_INSTRUCTION_TAG,
  LEARNING_SYSTEM_INSTRUCTION,
} from '../../learning/systemInstruction';
import { logger } from '../../utils/logger';
import { appendTextToContent } from '../../utils/messageContent';

function getToolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object') return undefined;

  const candidate = tool as {
    name?: unknown;
    function?: { name?: unknown };
  };

  if (typeof candidate.name === 'string' && candidate.name.length > 0) {
    return candidate.name;
  }

  if (typeof candidate.function?.name === 'string' && candidate.function.name.length > 0) {
    return candidate.function.name;
  }

  return undefined;
}

function getMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map((block) => (block as { text?: unknown }).text ?? '')
      .join('\n');
  }
  return '';
}

function hasLearningInstruction(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== 'system') continue;
    if (getMessageText(message.content).includes(LEARNING_INSTRUCTION_TAG)) return true;
  }
  return false;
}

function injectLearningInstruction(messages: ChatMessage[]): ChatMessage[] {
  const next = [...messages];
  const sysIdx = next.findIndex((m) => m.role === 'system');
  const payload = `${LEARNING_INSTRUCTION_TAG}\n\n${LEARNING_SYSTEM_INSTRUCTION}`;

  if (sysIdx >= 0) {
    next[sysIdx] = {
      ...next[sysIdx],
      content: appendTextToContent(next[sysIdx].content, payload),
    };
  } else {
    next.unshift({ role: 'system', content: payload });
  }

  return next;
}

function hasLearningCallToAction(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (getMessageText(message.content).includes(LEARNING_CALL_TO_ACTION_TAG)) return true;
  }
  return false;
}

function appendLearningCallToAction(messages: ChatMessage[]): ChatMessage[] {
  return [
    ...messages,
    { role: 'user', content: LEARNING_CALL_TO_ACTION },
  ];
}

export function createLearningToolsMiddleware(clientProtocol: ClientProtocol): RequestHandler {
  return (req, _res, next) => {
    if (!req.projectId) {
      next();
      return;
    }

    const body = req.body as ProxyRequest | undefined;
    if (!body || typeof body !== 'object') {
      next();
      return;
    }

    const systemModels = getSystemModelConfig();
    const hasSeparateLearningModel = systemModels.learning.trim().length > 0;

    const existingTools = Array.isArray(body.tools) ? [...body.tools] : [];
    const existingNames = new Set(
      existingTools
        .map((tool) => getToolName(tool))
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    );

    const learningTools = getSingleIcToolForClientProtocol(clientProtocol)
      .filter((tool) => {
        const toolName = getToolName(tool);
        return !!toolName && !existingNames.has(toolName);
      });

    if (learningTools.length > 0) {
      body.tools = [...existingTools, ...learningTools];
      logger.info('Learning tools injected into request', {
        projectId: req.projectId,
        sessionId: req.headers['x-session-id'] ?? req.headers['x-interaction-id'],
        addedToolNames: learningTools.map(getToolName).filter(Boolean),
        totalToolCount: (body.tools as unknown[] | undefined)?.length ?? 0,
        toolContinuation: req.toolContinuation,
        hasSeparateLearningModel,
      });
    }

    if (body.tool_choice == null) {
      body.tool_choice = 'auto';
      logger.info('tool_choice set to auto (was null/undefined)', {
        projectId: req.projectId,
        hasSeparateLearningModel,
      });
    }

    // ── Inline (no separate learning model) path ──
    // When there's no separate learning model, inject the system
    // instruction and per-turn call-to-action so the main model
    // itself calls `record_learning` in-band.
    if (!hasSeparateLearningModel && Array.isArray(body.messages)) {
      // 1. Inject the system-level capability description (what the tool
      //    is, what fields it takes, when NOT to call it) once per
      //    request.  Idempotent on tool continuations via the tag.
      if (!hasLearningInstruction(body.messages as ChatMessage[])) {
        const msgBefore = body.messages.length;
        body.messages = injectLearningInstruction(body.messages as ChatMessage[]);
        logger.info('Learning system instruction injected into messages', {
          projectId: req.projectId,
          sessionId: req.headers['x-session-id'] ?? req.headers['x-interaction-id'],
          messageCountBefore: msgBefore,
          messageCountAfter: body.messages.length,
          toolContinuation: req.toolContinuation,
        });
      }

      // 2. Append a per-turn `role: 'user'` call-to-action on the FIRST
      //    request of a session, asking the model to call
      //    `record_learning` before finishing its response.  The
      //    imperative is deliberately not in the system message:
      //    empirically models treat system content as background
      //    guidance, especially when several other system messages
      //    are present, and ignore imperative instructions there.
      //    A user-role message at the end of the conversation lands in
      //    the model's "current task" window and is more reliably
      //    followed — mirroring the success of the old
      //    "[LEARN_START]…[LEARN_END]" trailer, which was a per-turn
      //    instruction rather than a system rule.
      //
      //    Skip on tool continuations: those are mid-loop turns and
      //    shouldn't get a fresh "now record learnings" nudge (the
      //    model may not be done yet).  The idempotency tag also
      //    guards against double-injection if `isToolContinuation`
      //    ever returns false for a request that has already seen the
      //    message (e.g. resume after a tool error).
      if (!req.toolContinuation && !hasLearningCallToAction(body.messages as ChatMessage[])) {
        const msgBefore = body.messages.length;
        body.messages = appendLearningCallToAction(body.messages as ChatMessage[]);
        logger.info('Learning call-to-action user message appended', {
          projectId: req.projectId,
          sessionId: req.headers['x-session-id'] ?? req.headers['x-interaction-id'],
          messageCountBefore: msgBefore,
          messageCountAfter: body.messages.length,
          toolContinuation: req.toolContinuation,
        });
      }
    }

    // ── Separate learning model path ──
    // When a learning model IS configured, the system instruction and
    // call-to-action are NOT injected into the main model. Instead, the
    // main model runs without any learning nudge, and a separate
    // learning extraction call runs after the main model completes
    // (handled in upstream.ts).  The `ic` tool definition is still
    // available for the main model to use if it needs to query project
    // knowledge, but it's not prompted to call `record_learning`.

    if (hasSeparateLearningModel) {
      logger.info('Separate learning model configured — skipping inline learning instruction', {
        projectId: req.projectId,
        sessionId: req.headers['x-session-id'] ?? req.headers['x-interaction-id'],
        learningModel: systemModels.learning,
        toolContinuation: req.toolContinuation,
      });
    }

    req.body = body;
    next();
  };
}
