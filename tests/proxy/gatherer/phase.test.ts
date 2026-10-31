import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import {
  getGathererPhase,
  startGathererPhase,
  finishGathererPhase,
  setGathererAssistantContinuationMessage,
  clearGathererPhase,
} from '../../../src/proxy/gatherer/phase';

describe('gatherer phase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearGathererPhase('test-session');
    clearGathererPhase('other-session');
    clearGathererPhase('session-a');
    clearGathererPhase('session-b');
  });

  // ── startGathererPhase ─���─────────────────────────────────────────

  it('creates a new phase when none exists for the session', () => {
    const phase = startGathererPhase('test-session', 'deepseek-chat');

    expect(phase).toEqual({
      model: 'deepseek-chat',
      finished: false,
      capturedText: '',
      startedAt: expect.any(Number),
    });
    expect(getGathererPhase('test-session')).toBe(phase);
  });

  it('returns the existing unfinished phase instead of overwriting', () => {
    const first = startGathererPhase('test-session', 'deepseek-chat');
    const second = startGathererPhase('test-session', 'gpt-4o-mini');

    expect(second).toBe(first);
    expect(second.model).toBe('deepseek-chat');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Gatherer phase already in progress for session; reusing',
      expect.objectContaining({ sessionId: 'test-session', model: 'gpt-4o-mini' })
    );
  });

  it('replaces a finished phase with a new one', () => {
    startGathererPhase('test-session', 'deepseek-chat');
    finishGathererPhase('test-session', 'some analysis');

    const replacement = startGathererPhase('test-session', 'gpt-4o-mini');
    expect(replacement.model).toBe('gpt-4o-mini');
    expect(replacement.finished).toBe(false);
    expect(replacement.capturedText).toBe('');
  });

  // ── getGathererPhase ─────────────────────────────────────────────

  it('returns undefined for an unknown session', () => {
    expect(getGathererPhase('unknown-session')).toBeUndefined();
  });

  it('returns undefined when sessionId is undefined', () => {
    expect(getGathererPhase(undefined)).toBeUndefined();
  });

  it('returns the phase for a known session', () => {
    const phase = startGathererPhase('test-session', 'deepseek-chat');
    expect(getGathererPhase('test-session')).toBe(phase);
  });

  // ── finishGathererPhase ──────────────────────────────────────────

  it('marks the phase as finished and stores captured text', () => {
    startGathererPhase('test-session', 'deepseek-chat');
    finishGathererPhase('test-session', '<gatherer_analysis>…</gatherer_analysis>');

    const phase = getGathererPhase('test-session');
    expect(phase?.finished).toBe(true);
    expect(phase?.capturedText).toBe('<gatherer_analysis>…</gatherer_analysis>');
  });

  it('does nothing when finishing a non-existent phase', () => {
    expect(() => finishGathererPhase('unknown-session', 'text')).not.toThrow();
  });

  it('stores the last assistant continuation message for replay', () => {
    startGathererPhase('test-session', 'deepseek-chat');

    setGathererAssistantContinuationMessage('test-session', {
      role: 'assistant',
      content: '',
      reasoning_content: 'thought trail',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });

    expect(getGathererPhase('test-session')?.assistantContinuationMessage).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'thought trail',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
  });

  // ── clearGathererPhase ───────────────────────────────────────────

  it('removes the phase so getGathererPhase returns undefined', () => {
    startGathererPhase('test-session', 'deepseek-chat');
    expect(getGathererPhase('test-session')).toBeDefined();

    clearGathererPhase('test-session');
    expect(getGathererPhase('test-session')).toBeUndefined();
  });

  it('does nothing when clearing a non-existent phase', () => {
    expect(() => clearGathererPhase('unknown-session')).not.toThrow();
  });

  // ── Lifecycle integration ────────────────────────────────────────

  it('tracks the full start → finish → clear lifecycle', () => {
    startGathererPhase('test-session', 'deepseek-chat');
    finishGathererPhase('test-session', 'analysis text');

    const beforeClear = getGathererPhase('test-session');
    expect(beforeClear?.finished).toBe(true);
    expect(beforeClear?.capturedText).toBe('analysis text');

    clearGathererPhase('test-session');
    expect(getGathererPhase('test-session')).toBeUndefined();
  });

  it('allows multiple independent sessions to exist simultaneously', () => {
    const alpha = startGathererPhase('session-a', 'model-a');
    const bravo = startGathererPhase('session-b', 'model-b');

    expect(getGathererPhase('session-a')).toBe(alpha);
    expect(getGathererPhase('session-b')).toBe(bravo);
    expect(getGathererPhase('session-a')).not.toBe(getGathererPhase('session-b'));

    clearGathererPhase('session-a');
    expect(getGathererPhase('session-a')).toBeUndefined();
    expect(getGathererPhase('session-b')).toBeDefined();
  });
});
