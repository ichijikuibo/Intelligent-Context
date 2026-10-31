import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  selectContext: vi.fn(),
  prepareGathererContextSelection: vi.fn(),
  getSystemModelConfig: vi.fn(() => ({ gatherer: '' })),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/context/selector', () => ({
  selectContext: mocks.selectContext,
  prepareGathererContextSelection: mocks.prepareGathererContextSelection,
}));

vi.mock('../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));

import { contextInjectMiddleware } from '../../src/proxy/middleware/contextInject';
import type { ChatMessage } from '../../src/proxy/adapters/adapter';
import {
  appendToolResultReplayEntriesForSession,
  clearContextReplayForSession,
} from '../../src/proxy/contextReplay';

function makeReq(messages: ChatMessage[], sessionId?: string) {
  return {
    projectId: 'project-1',
    projectName: 'Project One',
    headers: sessionId ? { 'x-session-id': sessionId } : {},
    body: { model: 'gpt-4o-mini', messages },
  } as unknown as Parameters<typeof contextInjectMiddleware>[0];
}

function makeRes() {
  return {} as unknown as Parameters<typeof contextInjectMiddleware>[1];
}

function next() {
  return vi.fn();
}

describe('contextInjectMiddleware', () => {
  beforeEach(() => {
    mocks.logger.info.mockReset();
    mocks.logger.debug.mockReset();
    mocks.logger.error.mockReset();
    mocks.logger.warn.mockReset();
    mocks.selectContext.mockReset();
    mocks.prepareGathererContextSelection.mockReset();
    mocks.getSystemModelConfig.mockReset();
    mocks.getSystemModelConfig.mockReturnValue({ gatherer: '' });
    clearContextReplayForSession('project-1', 'session-tool-results');
  });

  it('replays the cached context block on tool continuations for the same session', async () => {
    mocks.selectContext.mockResolvedValue({
      candidates: [
        {
          id: 'chunk-1',
          type: 'chunk',
          content: 'Fact summary',
          fullContent: 'Fact summary with file references',
          category: 'auth',
          categories: ['auth'],
          similarity: 0.9,
        },
      ],
      method: 'keyword',
      latencyMs: 5,
    });

    const initialReq = makeReq([{ role: 'user', content: 'Inspect auth flow' }], 'session-a');
    await contextInjectMiddleware(initialReq, makeRes(), next());

    expect(initialReq.contextApplied).toBe(true);
    expect(initialReq.body.messages[0]).toEqual(expect.objectContaining({ role: 'system' }));
    expect(String(initialReq.body.messages[0].content)).toContain('## Project Context');

    const continuationReq = makeReq(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: '1', content: 'file body' }],
        },
      ],
      'session-a'
    );

    await contextInjectMiddleware(continuationReq, makeRes(), next());

    expect(continuationReq.toolContinuation).toBe(true);
    expect(continuationReq.contextApplied).toBe(true);
    expect(continuationReq.body.messages[0]).toEqual(expect.objectContaining({ role: 'system' }));
    expect(String(continuationReq.body.messages[0].content)).toContain('## Project Context');
    expect(mocks.selectContext).toHaveBeenCalledTimes(1);
  });

  it('appends project context after existing system instructions', async () => {
    mocks.selectContext.mockResolvedValue({
      candidates: [
        {
          id: 'chunk-1',
          type: 'chunk',
          content: 'Fact summary',
          fullContent: 'Fact summary with file references',
          category: 'auth',
          categories: ['auth'],
          similarity: 0.9,
        },
      ],
      method: 'keyword',
      latencyMs: 5,
    });

    const req = makeReq([
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Inspect auth flow' },
    ]);

    await contextInjectMiddleware(req, makeRes(), next());

    const systemContent = String(req.body.messages[0].content);
    expect(systemContent).toContain('You are a coding assistant.');
    expect(systemContent).toContain('## Project Context');
    expect(systemContent.indexOf('You are a coding assistant.')).toBeLessThan(
      systemContent.indexOf('## Project Context')
    );
    expect(systemContent).toContain('It is not the user\'s request and not a task to answer directly.');
  });

  it('leaves tool continuations untouched when no cached context exists', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'file body' }],
      },
    ];
    const req = makeReq(messages, 'session-miss');

    await contextInjectMiddleware(req, makeRes(), next());

    expect(req.toolContinuation).toBe(true);
    expect(req.contextApplied).toBe(false);
    expect(req.body.messages).toEqual(messages);
    expect(mocks.selectContext).not.toHaveBeenCalled();
  });

  it('injects persisted internal IC tool results on later tool continuations', async () => {
    appendToolResultReplayEntriesForSession('project-1', 'session-tool-results', [
      {
        toolCallId: 'call_1',
        toolName: 'ic_list_findings',
        arguments: { status: 'open', limit: 5 },
        result: {
          success: true,
          result: {
            total: 1,
            items: [{ id: 'finding-1', title: 'Missing provenance' }],
          },
        },
      },
    ]);

    const req = makeReq(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: '1', content: 'file body' }],
        },
      ],
      'session-tool-results'
    );

    await contextInjectMiddleware(req, makeRes(), next());

    expect(req.toolContinuation).toBe(true);
    expect(req.contextApplied).toBe(true);
    expect(req.body.messages[0]).toEqual(expect.objectContaining({ role: 'system' }));
    expect(String(req.body.messages[0].content)).toContain('## Internal IC Tool Results');
    expect(String(req.body.messages[0].content)).toContain('<ic_tool_results>');
    expect(String(req.body.messages[0].content)).toContain('"toolCallId": "call_1"');
    expect(String(req.body.messages[0].content)).toContain('"id": "finding-1"');
    expect(mocks.selectContext).not.toHaveBeenCalled();
  });

  it('treats a trailing plain user message as a fresh turn even with earlier tool history', async () => {
    mocks.selectContext
      .mockResolvedValueOnce({
        candidates: [
          {
            id: 'chunk-1',
            type: 'chunk',
            content: 'Initial fact',
            fullContent: 'Initial fact',
            category: 'auth',
            categories: ['auth'],
            similarity: 0.9,
          },
        ],
        method: 'keyword',
        latencyMs: 5,
      })
      .mockResolvedValueOnce({
        candidates: [
          {
            id: 'chunk-2',
            type: 'chunk',
            content: 'Fresh fact',
            fullContent: 'Fresh fact for follow-up',
            category: 'billing',
            categories: ['billing'],
            similarity: 0.8,
          },
        ],
        method: 'semantic',
        latencyMs: 6,
      });

    const initialReq = makeReq([{ role: 'user', content: 'Inspect auth flow' }], 'session-b');
    await contextInjectMiddleware(initialReq, makeRes(), next());

    const followUpReq = makeReq(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: '1', content: 'file body' }],
        },
        { role: 'user', content: 'Now compare that with the billing flow' },
      ],
      'session-b'
    );

    await contextInjectMiddleware(followUpReq, makeRes(), next());

    expect(followUpReq.toolContinuation).toBe(false);
    expect(followUpReq.contextApplied).toBe(true);
    expect(mocks.selectContext).toHaveBeenCalledTimes(2);
    expect(String(followUpReq.body.messages[0].content)).toContain('Fresh fact for follow-up');
  });

  it('builds a gatherer selection bundle alongside the past-knowledge block when gatherer is configured', async () => {
    mocks.getSystemModelConfig.mockReturnValue({ gatherer: 'deepseek-chat' });
    mocks.prepareGathererContextSelection.mockResolvedValue({
      queryText: 'Inspect auth flow',
      referencedFiles: [],
      prioritySummaryIds: ['summary-auth'],
      summaryDescriptors: [],
      unsummarizedCategories: [],
      relevantFindings: [],
      shouldRefreshSummaries: true,
      summaryRefreshReasons: ['Referenced files matched stored chunks but do not have linked summaries yet.'],
    });
    mocks.selectContext.mockResolvedValue({
      candidates: [
        {
          id: 'chunk-1',
          type: 'chunk',
          content: 'Auth uses signed session tokens',
          fullContent: 'Auth uses signed session tokens. Tokens are issued by src/auth/context.ts.',
          category: 'auth',
          categories: ['auth'],
          similarity: 0.9,
        },
      ],
      method: 'keyword',
      latencyMs: 5,
    });

    const req = makeReq([{ role: 'user', content: 'Inspect auth flow' }], 'gatherer-session');

    await contextInjectMiddleware(req, makeRes(), next());

    // Body itself is untouched in gatherer mode — the past knowledge
    // is staged on `req.gathererContextBlock` and `req.gathererSelectionContext`
    // for the gatherer stage in `proxyToUpstream.handleStreaming`.
    expect(req.contextApplied).toBe(false);
    expect(req.gathererSelectionContext).toEqual(expect.objectContaining({
      prioritySummaryIds: ['summary-auth'],
    }));
    expect(req.gathererContextBlock).toBeDefined();
    expect(req.gathererContextBlock).toContain('## Project Context');
    expect(req.gathererContextBlock).toContain('Auth uses signed session tokens');
    // selectContext is now called in gatherer mode to build the past-knowledge
    // block; prepareGathererContextSelection still runs for the shortlist.
    expect(mocks.selectContext).toHaveBeenCalledTimes(1);
    expect(mocks.prepareGathererContextSelection).toHaveBeenCalledTimes(1);
  });

  it('skips past-knowledge block in gatherer mode when selectContext returns no candidates', async () => {
    mocks.getSystemModelConfig.mockReturnValue({ gatherer: 'deepseek-chat' });
    mocks.prepareGathererContextSelection.mockResolvedValue({
      queryText: 'Inspect auth flow',
      referencedFiles: [],
      prioritySummaryIds: [],
      summaryDescriptors: [],
      unsummarizedCategories: [],
      relevantFindings: [],
      shouldRefreshSummaries: false,
      summaryRefreshReasons: [],
    });
    mocks.selectContext.mockResolvedValue({
      candidates: [],
      method: 'keyword',
      latencyMs: 1,
    });

    const req = makeReq([{ role: 'user', content: 'Inspect auth flow' }], 'gatherer-empty');

    await contextInjectMiddleware(req, makeRes(), next());

    expect(req.gathererContextBlock).toBeUndefined();
    expect(req.gathererSelectionContext).toBeDefined();
    expect(mocks.selectContext).toHaveBeenCalledTimes(1);
  });

  it('does not block gatherer stage if past-knowledge build throws', async () => {
    mocks.getSystemModelConfig.mockReturnValue({ gatherer: 'deepseek-chat' });
    mocks.prepareGathererContextSelection.mockResolvedValue({
      queryText: 'Inspect auth flow',
      referencedFiles: [],
      prioritySummaryIds: ['summary-auth'],
      summaryDescriptors: [],
      unsummarizedCategories: [],
      relevantFindings: [],
      shouldRefreshSummaries: false,
      summaryRefreshReasons: [],
    });
    mocks.selectContext.mockRejectedValue(new Error('DB unavailable'));

    const req = makeReq([{ role: 'user', content: 'Inspect auth flow' }], 'gatherer-fail');

    await contextInjectMiddleware(req, makeRes(), next());

    expect(req.gathererSelectionContext).toBeDefined();
    expect(req.gathererContextBlock).toBeUndefined();
  });

  it('injects the selector shortlist directly into the main model in basic mode', async () => {
    mocks.getSystemModelConfig.mockReturnValue({
      requestContextMode: 'basic',
      gatherer: 'deepseek-chat',
    });
    mocks.prepareGathererContextSelection.mockResolvedValue({
      queryText: 'Inspect auth flow',
      referencedFiles: [{
        id: 'file-auth',
        fileName: 'src/auth/context.ts',
        purpose: 'Auth flow',
        chunkCount: 2,
        summaryCount: 1,
        linkedSummaryIds: ['summary-auth'],
      }],
      prioritySummaryIds: ['summary-auth'],
      summaryDescriptors: [{
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh logic lives in the auth context pipeline.',
        categories: ['auth'],
        priority: 'file-linked',
        linkedFileIds: ['file-auth'],
      }],
      unsummarizedCategories: [{
        id: 'auth',
        chunkCount: 2,
        newestChunkCreatedAt: '2026-07-24T00:00:00.000Z',
        oldestChunkCreatedAt: '2026-07-20T00:00:00.000Z',
      }],
      relevantFindings: [{
        id: 'finding-auth',
        title: 'Auth gap',
        severity: 'medium',
      }],
      shouldRefreshSummaries: true,
      summaryRefreshReasons: ['Unsummarized category backlog remains and should be refreshed into summaries.'],
    });

    const req = makeReq([{ role: 'user', content: 'Inspect auth flow' }], 'basic-session');

    await contextInjectMiddleware(req, makeRes(), next());

    expect(req.contextApplied).toBe(true);
    expect(req.gathererSelectionContext).toBeUndefined();
    expect(String(req.body.messages[0].content)).toContain('## Project Context Shortlist');
    expect(String(req.body.messages[0].content)).toContain('<project_context_shortlist>');
    expect(String(req.body.messages[0].content)).toContain('summary-auth');
    expect(mocks.selectContext).not.toHaveBeenCalled();
    expect(mocks.prepareGathererContextSelection).toHaveBeenCalledTimes(1);
  });

  it('falls through to context selection when gatherer model and main model share the same base name', async () => {
    mocks.getSystemModelConfig.mockReturnValue({ gatherer: 'DSK-deepseek-chat' });
    mocks.selectContext.mockResolvedValue({
      candidates: [
        {
          id: 'chunk-1',
          type: 'chunk',
          content: 'Fallback context',
          fullContent: 'Fallback context detail',
          category: 'general',
          categories: ['general'],
          similarity: 0.5,
        },
      ],
      method: 'keyword',
      latencyMs: 5,
    });

    const req = makeReq([{ role: 'user', content: 'hi' }], 'session-same-model');
    // Main model is 'gpt-4o-mini', gatherer is 'DSK-deepseek-chat' — different base
    // So gatherer still runs normally here. Override body.model so they match.
    req.body.model = 'deepseek-chat';

    await contextInjectMiddleware(req, makeRes(), next());

    // Gatherer is enabled with a configured model, but since the base models match,
    // we skip the gatherer path and fall through to regular context selection.
    expect(req.gathererSelectionContext).toBeUndefined();
    expect(mocks.prepareGathererContextSelection).not.toHaveBeenCalled();
    expect(mocks.selectContext).toHaveBeenCalledTimes(1);
    expect(req.contextApplied).toBe(true);
    expect(String(req.body.messages[0].content)).toContain('## Project Context');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Gatherer skipped in context inject — gatherer model and main model share the same base model',
      expect.objectContaining({
        gathererModel: 'DSK-deepseek-chat',
        mainModel: 'deepseek-chat',
        baseModel: 'deepseek-chat',
      }),
    );
  });
});