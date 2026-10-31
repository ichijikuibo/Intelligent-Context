import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  resolveProviderAndModelForJob: vi.fn(),
  runLearningToolAgentLoop: vi.fn(),
  getSystemModelConfig: vi.fn(),
  providersRepo: {
    findProviderForModel: vi.fn(),
  },
  getModelSupportsVisionForProvider: vi.fn(),
  getModelReference: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  recordStat: vi.fn(),
  resolveKnowledgeReferences: vi.fn(async () => []),
  canUseChatModel: vi.fn(() => true),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.axiosPost,
  },
}));

vi.mock('../../src/proxy/upstream', () => ({
  resolveProviderAndModelForJob: mocks.resolveProviderAndModelForJob,
}));

vi.mock('../../src/proxy/tools/agentLoop', () => ({
  runLearningToolAgentLoop: mocks.runLearningToolAgentLoop,
}));

vi.mock('../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

vi.mock('../../src/proxy/modelMetadataCache', () => ({
  getModelSupportsVisionForProvider: mocks.getModelSupportsVisionForProvider,
}));

vi.mock('../../src/proxy/modelReferenceCache', () => ({
  getModelReference: mocks.getModelReference,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/utils/stats', () => ({
  recordStat: mocks.recordStat,
  generateRunId: () => 'run-1',
}));

vi.mock('../../src/chat/knowledgeContext', () => ({
  resolveKnowledgeReferences: mocks.resolveKnowledgeReferences,
  KNOWLEDGE_REF_HEADER: 'Attached project knowledge:',
}));

vi.mock('../../src/chat/chatModels', () => ({
  canUseChatModel: mocks.canUseChatModel,
}));

import { runChatTurn, runChatTurnStream } from '../../src/chat/chatService';

const adapter = {
  buildRequest: vi.fn((req: Record<string, unknown>) => req),
  parseResponse: vi.fn((data: { choices?: unknown[] }) => data),
  headers: vi.fn(() => ({ authorization: 'Bearer test' })),
  endpoint: vi.fn(() => 'https://api.example.com/v1/chat/completions'),
};

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    adapter,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test',
    providerName: 'Example',
    providerType: 'openai',
    model: 'gpt-4.1',
    ...overrides,
  };
}

function textResponse(content: string) {
  return {
    data: {
      id: 'resp-1',
      object: 'chat.completion',
      model: 'gpt-4.1',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    },
  };
}

function toolCallResponse(name: string) {
  return {
    data: {
      id: 'resp-2',
      object: 'chat.completion',
      model: 'gpt-4.1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  };
}

describe('chatService.runChatTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSystemModelConfig.mockReturnValue({
      chat: 'gpt-4.1',
      icTools: '',
      vision: '',
    });
    mocks.resolveProviderAndModelForJob.mockResolvedValue(makeExecution());
    mocks.providersRepo.findProviderForModel.mockResolvedValue({ id: 'provider-1' });
    mocks.getModelSupportsVisionForProvider.mockReturnValue(true);
    mocks.getModelReference.mockReturnValue(undefined);
    mocks.canUseChatModel.mockReturnValue(true);
  });

  it('throws when there are no messages', async () => {
    await expect(runChatTurn({ projectId: 'project-1', messages: [] }))
      .rejects.toThrow(/At least one message/);
  });

  it('throws when no chat model can be resolved', async () => {
    mocks.getSystemModelConfig.mockReturnValue({ chat: '', icTools: '', vision: '' });
    mocks.resolveProviderAndModelForJob.mockResolvedValue(null);

    await expect(runChatTurn({
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/No chat model is configured/);
  });

  it('returns the model text for a plain (non-tool) turn', async () => {
    mocks.axiosPost.mockResolvedValue(textResponse('Auth uses signed tokens.'));

    const result = await runChatTurn({
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'How does auth work?' }],
    });

    expect(result.content).toBe('Auth uses signed tokens.');
    expect(result.model).toBe('gpt-4.1');
    expect(result.internalTurnCount).toBe(0);
    expect(mocks.runLearningToolAgentLoop).not.toHaveBeenCalled();

    // The request must carry the ic tools so the model can reach the knowledge base.
    const payload = adapter.buildRequest.mock.calls[0][0];
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.tools.length).toBeGreaterThan(0);
    expect(payload.messages[0].role).toBe('system');
    expect(String(payload.messages[0].content)).toContain('ic');
  });

  it('runs the ic tool agent loop when the model requests a tool', async () => {
    mocks.axiosPost.mockResolvedValue(toolCallResponse('ic'));
    mocks.runLearningToolAgentLoop.mockResolvedValue({
      responseData: {},
      normalizedResponse: {
        id: 'resp-3',
        object: 'chat.completion',
        model: 'gpt-4.1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Merged the two summaries.' }, finish_reason: 'stop' }],
      },
      internalTurnCount: 2,
    });

    const result = await runChatTurn({
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'Merge summaries A and B' }],
    });

    expect(mocks.runLearningToolAgentLoop).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Merged the two summaries.');
    expect(result.internalTurnCount).toBe(2);
  });

  it('expands text attachments into the user message', async () => {
    mocks.axiosPost.mockResolvedValue(textResponse('ok'));

    await runChatTurn({
      projectId: 'project-1',
      messages: [{
        role: 'user',
        content: 'Review this',
        attachments: [{ name: 'notes.txt', mimeType: 'text/plain', text: 'hello world' }],
      }],
    });

    const payload = adapter.buildRequest.mock.calls[0][0];
    const userMessage = payload.messages[1];
    expect(Array.isArray(userMessage.content)).toBe(true);
    const parts = userMessage.content as Array<{ type: string; text?: string }>;
    expect(parts.some((part) => part.type === 'text' && part.text?.includes('notes.txt'))).toBe(true);
    expect(parts.some((part) => part.text?.includes('hello world'))).toBe(true);
  });

  it('wraps upstream failures in a chat-specific error', async () => {
    mocks.axiosPost.mockRejectedValue(new Error('boom'));

    await expect(runChatTurn({
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/The chat request failed/);
  });

  it('inlines resolved knowledge references into the user message', async () => {
    mocks.axiosPost.mockResolvedValue(textResponse('ok'));
    mocks.resolveKnowledgeReferences.mockResolvedValue(['## Attached summary: Auth summary (sum-1)\nAuth uses tokens.']);

    await runChatTurn({
      projectId: 'project-1',
      messages: [{
        role: 'user',
        content: 'Explain this',
        knowledge: [{ type: 'summary', id: 'sum-1' }],
      }],
    });

    expect(mocks.resolveKnowledgeReferences).toHaveBeenCalledWith('project-1', [{ type: 'summary', id: 'sum-1' }]);
    const payload = adapter.buildRequest.mock.calls[0][0];
    const parts = payload.messages[1].content as Array<{ type: string; text?: string }>;
    expect(parts.some((part) => part.text?.includes('Attached project knowledge:'))).toBe(true);
    expect(parts.some((part) => part.text?.includes('Auth uses tokens.'))).toBe(true);
  });

  it('rejects a model override the caller cannot access', async () => {
    mocks.canUseChatModel.mockReturnValue(false);

    await expect(runChatTurn({
      projectId: 'project-1',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'SECRET-gpt-5',
    })).rejects.toThrow(/access to the selected model/);

    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────

/** Build a fake readable SSE stream from raw `data:` lines. */
function sseStream(lines: string[]): NodeJS.ReadableStream {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const stream = {
    on(event: string, handler: (arg?: unknown) => void) {
      handlers[event] = handler;
      return stream;
    },
  } as unknown as NodeJS.ReadableStream;

  // Deliver on the next tick so listeners are attached first.
  setImmediate(() => {
    for (const line of lines) {
      handlers.data?.(Buffer.from(`${line}\n`, 'utf8'));
    }
    handlers.end?.();
  });

  return stream;
}

describe('chatService.runChatTurnStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveKnowledgeReferences.mockResolvedValue([]);
    mocks.getSystemModelConfig.mockReturnValue({ chat: 'gpt-4.1', icTools: '', vision: '' });
    mocks.resolveProviderAndModelForJob.mockResolvedValue(makeExecution());
    mocks.providersRepo.findProviderForModel.mockResolvedValue({ id: 'provider-1' });
    mocks.getModelSupportsVisionForProvider.mockReturnValue(true);
    mocks.getModelReference.mockReturnValue(undefined);
    mocks.canUseChatModel.mockReturnValue(true);
  });

  it('emits delta events for a plain streaming turn and a done event', async () => {
    mocks.axiosPost.mockResolvedValue({
      data: sseStream([
        'data: {"id":"c1","model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"id":"c1","model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"Auth uses "},"finish_reason":null}]}',
        'data: {"id":"c1","model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"signed tokens."},"finish_reason":null}]}',
        'data: {"id":"c1","model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    });

    const events: Array<Record<string, unknown>> = [];
    await runChatTurnStream(
      { projectId: 'project-1', messages: [{ role: 'user', content: 'How does auth work?' }] },
      (event) => events.push(event as unknown as Record<string, unknown>),
    );

    const deltas = events.filter((e) => e.type === 'delta').map((e) => e.content);
    expect(deltas).toEqual(['Auth uses ', 'signed tokens.']);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(mocks.runLearningToolAgentLoop).not.toHaveBeenCalled();
  });

  it('runs the agent loop and streams the resolved answer when a tool is requested', async () => {
    mocks.axiosPost.mockResolvedValue({
      data: sseStream([
        'data: {"id":"c1","model":"gpt-4.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"ic","arguments":""}}]},"finish_reason":null}]}',
        'data: {"id":"c1","model":"gpt-4.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ops\\":[]}"}}]},"finish_reason":null}]}',
        'data: {"id":"c1","model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    });
    mocks.runLearningToolAgentLoop.mockResolvedValue({
      responseData: {},
      normalizedResponse: {
        id: 'resp-3',
        object: 'chat.completion',
        model: 'gpt-4.1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Merged the two summaries.' }, finish_reason: 'stop' }],
      },
      internalTurnCount: 2,
    });

    const events: Array<Record<string, unknown>> = [];
    await runChatTurnStream(
      { projectId: 'project-1', messages: [{ role: 'user', content: 'Merge summaries' }] },
      (event) => events.push(event as unknown as Record<string, unknown>),
    );

    expect(events.some((e) => e.type === 'status' && e.status === 'tool')).toBe(true);
    expect(events.some((e) => e.type === 'delta' && e.content === 'Merged the two summaries.')).toBe(true);
    expect(mocks.runLearningToolAgentLoop).toHaveBeenCalledTimes(1);
    const done = events.find((e) => e.type === 'done');
    expect(done?.internalTurnCount).toBe(2);
  });

  it('emits an error event when the upstream call fails', async () => {
    mocks.axiosPost.mockRejectedValue(new Error('boom'));

    const events: Array<Record<string, unknown>> = [];
    await runChatTurnStream(
      { projectId: 'project-1', messages: [{ role: 'user', content: 'hi' }] },
      (event) => events.push(event as unknown as Record<string, unknown>),
    );

    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('emits an error event when no model is configured', async () => {
    mocks.getSystemModelConfig.mockReturnValue({ chat: '', icTools: '', vision: '' });
    mocks.resolveProviderAndModelForJob.mockResolvedValue(null);

    const events: Array<Record<string, unknown>> = [];
    await runChatTurnStream(
      { projectId: 'project-1', messages: [{ role: 'user', content: 'hi' }] },
      (event) => events.push(event as unknown as Record<string, unknown>),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });
});
