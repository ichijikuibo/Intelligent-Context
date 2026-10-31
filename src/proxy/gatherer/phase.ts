/**
 * In-memory gatherer phase state tracking.
 *
 * The gatherer runs across multiple HTTP requests — each tool-call turn
 * streams to the IDE, the IDE executes tools, and the results come back
 * on the next request.  This module tracks which phase the gatherer is in
 * so the proxy can route continuations back to the gatherer model instead
 * of the main model.
 */
import { logger } from '../../utils/logger';
import type { GathererContextSelection } from '../../context/selector';
import type { ChatMessage, ChatToolCall } from '../adapters/adapter';

export interface GathererAssistantContinuationMessage extends ChatMessage {
  tool_calls?: ChatToolCall[];
  reasoning_content?: string;
  reasoning?: string;
  [key: string]: unknown;
}

export interface GathererPhaseState {
  /** The resolved gatherer model ID (e.g. "deepseek-chat"). */
  model: string;
  /** Whether the gatherer has produced finish_reason: "stop". */
  finished: boolean;
  /** The gatherer's final visible text (the <gatherer_analysis> block). */
  capturedText: string;
  /** Timestamp when the phase started (for TTL-based cleanup). */
  startedAt: number;
  /** Selector-generated shortlist that should persist across gatherer turns. */
  selectionContext?: GathererContextSelection;
  /**
   * The assembled `## Project Context` block for the gatherer, set
   * once on the first request and reused across gatherer
   * continuations so we don't re-run `selectContext` on every turn.
   * Only present when `contextInjectMiddleware` produced one in
   * gatherer mode.
   */
  pastKnowledgeBlock?: string;
  /** Last assistant tool-call message emitted by the gatherer for continuation replay. */
  assistantContinuationMessage?: GathererAssistantContinuationMessage;
  /**
   * Snapshot of the original request messages captured before the
   * gatherer modified the conversation.  Restored on completion so the
   * main model only sees the original user request (plus the injected
   * gatherer analysis), not the gatherer's internal tool-call turns.
   */
  originalMessages?: ChatMessage[];
}

const phases = new Map<string, GathererPhaseState>();

/** Delete phases older than 30 minutes. */
const PHASE_TTL_MS = 30 * 60 * 1000;

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, phase] of phases) {
    if (now - phase.startedAt > PHASE_TTL_MS) {
      phases.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Don't keep the process alive just for phase cleanup.
cleanupTimer.unref();

export function getGathererPhase(
  sessionId: string | undefined
): GathererPhaseState | undefined {
  if (!sessionId) return undefined;
  return phases.get(sessionId);
}

export function startGathererPhase(
  sessionId: string,
  model: string,
  selectionContext?: GathererContextSelection,
  originalMessages?: ChatMessage[],
  pastKnowledgeBlock?: string,
): GathererPhaseState {
  const existing = phases.get(sessionId);
  if (existing && !existing.finished) {
    logger.warn('Gatherer phase already in progress for session; reusing', {
      sessionId,
      model,
      existingModel: existing.model,
    });
    return existing;
  }

  const phase: GathererPhaseState = {
    model,
    finished: false,
    capturedText: '',
    startedAt: Date.now(),
    ...(selectionContext ? { selectionContext } : {}),
    ...(originalMessages ? { originalMessages } : {}),
    ...(pastKnowledgeBlock ? { pastKnowledgeBlock } : {}),
  };
  phases.set(sessionId, phase);
  return phase;
}

export function finishGathererPhase(
  sessionId: string,
  capturedText: string
): void {
  const phase = phases.get(sessionId);
  if (phase) {
    phase.finished = true;
    phase.capturedText = capturedText;
  }
}

export function setGathererAssistantContinuationMessage(
  sessionId: string,
  message: GathererAssistantContinuationMessage,
): void {
  const phase = phases.get(sessionId);
  if (!phase) return;

  phase.assistantContinuationMessage = {
    ...message,
    tool_calls: Array.isArray(message.tool_calls)
      ? [...message.tool_calls]
      : undefined,
  };
}

export function clearGathererPhase(sessionId: string): void {
  phases.delete(sessionId);
}
