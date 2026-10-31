import { PassThrough } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyRequest, ProxyResponse } from '../../../src/proxy/adapters/adapter';
import { GATHERER_SYSTEM_PROMPT } from '../../../src/learning/gathererPrompt';

const mocks = vi.hoisted(() => ({
  axiosIsAxiosError: vi.fn(),
  buildGathererContextBlock: vi.fn((gathererText: string) => `BLOCK:${gathererText}`),
  buildGathererRequest: vi.fn(),
  convertOpenAiSseToAnthropic: vi.fn((rawSse: string) => `anthropic:${rawSse}`),
  estimateTokens: vi.fn(() => 42),
  finishGathererPhase: vi.fn(),
  generateRunId: vi.fn(() => 'run-1'),
  getGathererPhase: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  parseSseToProxyResponse: vi.fn(),
  recordStat: vi.fn(),
  resolveProviderAndModelForJob: vi.fn(),
  setGathererAssistantContinuationMessage: vi.fn(),
  startGathererPhase: vi.fn(),
  unifiedCompletions: [] as Array<{ visibleText: string; finishReason: string | null }>,
  withParamFallback: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    isAxiosError: mocks.axiosIsAxiosError,
  },
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../../src/utils/tokens', () => ({
  estimateTokens: mocks.estimateTokens,
}));

vi.mock('../../../src/utils/stats', () => ({
  generateRunId: mocks.generateRunId,
  recordStat: mocks.recordStat,
}));

vi.mock('../../../src/proxy/unifiedStream', async () => {
  const streamModule = await import('stream');

  class FakeUnifiedProxyStream extends streamModule.PassThrough {
    private readonly callbacks: { onComplete?: (result: { visibleText: string; finishReason: string | null }) => void };

    constructor(options: { callbacks?: { onComplete?: (result: { visibleText: string; finishReason: string | null }) => void } }) {
      super();
      this.callbacks = options.callbacks ?? {};
    }

    override end(...args: any[]): this {
      const completion = mocks.unifiedCompletions.shift() ?? { visibleText: '', finishReason: null };
      this.callbacks.onComplete?.(completion);
      return super.end(...args);
    }
  }

  return {
    UnifiedProxyStream: FakeUnifiedProxyStream,
    parseSseToProxyResponse: mocks.parseSseToProxyResponse,
  };
});

vi.mock('../../../src/proxy/anthropicSseBridge', async () => {
  const streamModule = await import('stream');

  class FakeAnthropicToOpenAiStream extends streamModule.PassThrough {}

  return {
    AnthropicToOpenAiStream: FakeAnthropicToOpenAiStream,
    convertOpenAiSseToAnthropic: mocks.convertOpenAiSseToAnthropic,
  };
});

vi.mock('../../../src/proxy/upstream', () => ({
  resolveProviderAndModelForJob: mocks.resolveProviderAndModelForJob,
}));

vi.mock('../../../src/proxy/gatherer/phase', () => ({
  finishGathererPhase: mocks.finishGathererPhase,
  getGathererPhase: mocks.getGathererPhase,
  setGathererAssistantContinuationMessage: mocks.setGathererAssistantContinuationMessage,
  startGathererPhase: mocks.startGathererPhase,
}));

vi.mock('../../../src/proxy/gatherer/request', () => ({
  buildGathererContextBlock: mocks.buildGathererContextBlock,
  buildGathererRequest: mocks.buildGathererRequest,
}));

vi.mock('../../../src/utils/paramFallback', () => ({
  withParamFallback: mocks.withParamFallback,
}));

import { injectGathererResult, runGathererTurn } from '../../../src/proxy/gatherer/orchestrator';

function makeRequestBody(messages: ProxyRequest['messages']): ProxyRequest {
  return {
    model: 'gpt-4.1-mini',
    messages,
    stream: true,
  };
}

function makeExecution(providerType: 'openai' | 'anthropic' = 'openai') {
  return {
    adapter: {
      buildRequest: vi.fn((request: ProxyRequest) => ({ payload: request })),
      endpoint: vi.fn(() => 'https://provider.test/chat/completions'),
      headers: vi.fn(() => ({ Authorization: 'Bearer gatherer-key' })),
      parseResponse: vi.fn(),
    },
    apiKey: 'gatherer-key',
    baseUrl: 'https://provider.test',
    model: 'deepseek-chat',
    providerName: providerType === 'anthropic' ? 'Anthropic' : 'OpenAI',
    providerType,
  };
}

function makeResponse() {
  return {
    end: vi.fn(),
    flushHeaders: vi.fn(),
    setHeader: vi.fn(),
    write: vi.fn(),
  } as any;
}

function makeStopResponse(): ProxyResponse {
  return {
    id: 'resp-1',
    object: 'chat.completion',
    model: 'deepseek-chat',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '<gatherer_analysis>done</gatherer_analysis>' },
      finish_reason: 'stop',
    }],
  };
}

describe('gatherer orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unifiedCompletions.length = 0;
    mocks.axiosIsAxiosError.mockImplementation((error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError);
    mocks.getGathererPhase.mockReturnValue(undefined);
    mocks.resolveProviderAndModelForJob.mockResolvedValue(makeExecution());
    mocks.buildGathererRequest.mockReturnValue({
      model: 'deepseek-chat',
      stream: true,
      messages: [
        { role: 'system', content: GATHERER_SYSTEM_PROMPT },
        { role: 'user', content: 'Inspect auth flow' },
      ],
    });
  });

  it('corrects a malformed gatherer request before the upstream call and logs upstream failures with the real error', async () => {
    const malformedBody: ProxyRequest = {
      model: 'deepseek-chat',
      stream: true,
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'system', content: '## Project Context\n- fact: Auth uses signed tokens' },
        { role: 'user', content: 'Inspect auth flow' },
      ],
    };
    const upstreamError = Object.assign(new Error('upstream failed'), {
      isAxiosError: true,
      response: { status: 503 },
    });

    mocks.buildGathererRequest.mockReturnValue(malformedBody);
    mocks.withParamFallback.mockImplementation(async (request: ProxyRequest) => {
      expect(request.messages).toEqual([
        { role: 'system', content: GATHERER_SYSTEM_PROMPT },
        { role: 'system', content: '## Project Context\n- fact: Auth uses signed tokens' },
        { role: 'user', content: 'Inspect auth flow' },
      ]);
      throw upstreamError;
    });

    const result = await runGathererTurn({
      gathererModel: 'deepseek-chat',
      requestBody: makeRequestBody([{ role: 'user', content: 'Inspect auth flow' }]),
      projectId: 'project-1',
      sessionId: 'session-1',
      requestId: 'request-1',
      clientProtocol: 'openai',
    }, makeResponse());

    expect(result).toEqual({ phaseFinished: false, capturedText: '' });
    expect(mocks.axiosIsAxiosError).toHaveBeenCalledWith(upstreamError);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Gatherer request missing gatherer system prompt at index 0; correcting',
      expect.objectContaining({
        projectId: 'project-1',
        preservedPastKnowledge: true,
      }),
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Gatherer upstream POST failed; continuing without gathered context',
      expect.objectContaining({
        projectId: 'project-1',
        requestId: 'request-1',
        model: 'deepseek-chat',
        statusCode: 503,
        error: 'upstream failed',
      }),
    );
  });

  it('marks the phase finished and suppresses IDE streaming when the gatherer stops', async () => {
    const upstreamStream = new PassThrough();
    const res = makeResponse();

    mocks.withParamFallback.mockResolvedValue({
      result: { data: upstreamStream },
      paramStripped: null,
    });
    mocks.unifiedCompletions.push({
      visibleText: '<gatherer_analysis>done</gatherer_analysis>',
      finishReason: 'stop',
    });

    const resultPromise = runGathererTurn({
      gathererModel: 'deepseek-chat',
      requestBody: makeRequestBody([{ role: 'user', content: 'Inspect auth flow' }]),
      projectId: 'project-1',
      sessionId: 'session-1',
      requestId: 'request-2',
      clientProtocol: 'openai',
    }, res);

    setImmediate(() => {
      upstreamStream.end('data: {"id":"resp-1"}\n\ndata: [DONE]\n\n');
    });

    const result = await resultPromise;

    expect(result).toEqual({
      phaseFinished: true,
      capturedText: '<gatherer_analysis>done</gatherer_analysis>',
    });
    expect(mocks.finishGathererPhase).toHaveBeenCalledWith(
      'session-1',
      '<gatherer_analysis>done</gatherer_analysis>',
    );
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('streams tool-call SSE to the IDE and stores the assistant continuation message', async () => {
    const rawSse = 'data: {"id":"resp-1"}\n\ndata: [DONE]\n\n';
    const upstreamStream = new PassThrough();
    const res = makeResponse();
    const toolResponse: ProxyResponse = {
      id: 'resp-1',
      object: 'chat.completion',
      model: 'deepseek-chat',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"filePath":"src/index.ts"}',
            },
          }],
          reasoning_content: 'thought trail',
        } as any,
        finish_reason: 'tool_calls',
      }],
    };

    mocks.withParamFallback.mockResolvedValue({
      result: { data: upstreamStream },
      paramStripped: null,
    });
    mocks.unifiedCompletions.push({ visibleText: '', finishReason: 'tool_calls' });
    mocks.parseSseToProxyResponse.mockReturnValue(toolResponse);

    const resultPromise = runGathererTurn({
      gathererModel: 'deepseek-chat',
      requestBody: makeRequestBody([{ role: 'user', content: 'Inspect auth flow' }]),
      projectId: 'project-1',
      sessionId: 'session-1',
      requestId: 'request-3',
      clientProtocol: 'openai',
    }, res);

    setImmediate(() => {
      upstreamStream.end(rawSse);
    });

    const result = await resultPromise;

    expect(result).toEqual({ phaseFinished: false, capturedText: '' });
    expect(mocks.parseSseToProxyResponse).toHaveBeenCalledWith(rawSse);
    expect(mocks.setGathererAssistantContinuationMessage).toHaveBeenCalledWith(
      'session-1',
      toolResponse.choices[0]?.message,
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith(rawSse);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(mocks.finishGathererPhase).not.toHaveBeenCalled();
  });

  it('appends the gathered block to the last user message', () => {
    const requestBody = makeRequestBody([
      { role: 'user', content: 'Investigate auth flow' },
      { role: 'assistant', content: 'Looking into it' },
      { role: 'user', content: 'Focus on token refresh' },
    ]);

    injectGathererResult(requestBody, '<gatherer_analysis>auth notes</gatherer_analysis>');

    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'Investigate auth flow' },
      { role: 'assistant', content: 'Looking into it' },
      {
        role: 'user',
        content: 'Focus on token refresh\n\nBLOCK:<gatherer_analysis>auth notes</gatherer_analysis>',
      },
    ]);
    expect(mocks.buildGathererContextBlock).toHaveBeenCalledWith('<gatherer_analysis>auth notes</gatherer_analysis>');
  });

  it('prepends a user message when injecting gathered context into a conversation with no user turn', () => {
    const requestBody = makeRequestBody([
      { role: 'assistant', content: 'Looking into it' },
    ]);

    injectGathererResult(requestBody, '<gatherer_analysis>auth notes</gatherer_analysis>');

    expect(requestBody.messages).toEqual([
      {
        role: 'user',
        content: 'BLOCK:<gatherer_analysis>auth notes</gatherer_analysis>',
      },
      { role: 'assistant', content: 'Looking into it' },
    ]);
  });
});