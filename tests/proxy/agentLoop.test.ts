import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, ProxyRequest, ProxyResponse } from '../../src/proxy/adapters/adapter';

const mocks = vi.hoisted(() => ({
  appendToolResultReplayEntriesForSession: vi.fn(),
  axiosIsAxiosError: vi.fn((error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError),
  axiosPost: vi.fn(),
  executeLearningTool: vi.fn(),
  getLearningToolsForClientProtocol: vi.fn(),
  isLearningToolName: vi.fn((toolName: string) => toolName.startsWith('ic_')),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  withParamFallback: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    isAxiosError: mocks.axiosIsAxiosError,
    post: mocks.axiosPost,
  },
}));

vi.mock('../../src/proxy/contextReplay', () => ({
  appendToolResultReplayEntriesForSession: mocks.appendToolResultReplayEntriesForSession,
}));

vi.mock('../../src/proxy/tools/definitions', () => ({
  getLearningToolsForClientProtocol: mocks.getLearningToolsForClientProtocol,
  isLearningToolName: mocks.isLearningToolName,
}));

vi.mock('../../src/proxy/tools/executor', () => ({
  executeLearningTool: mocks.executeLearningTool,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/utils/paramFallback', () => ({
  withParamFallback: mocks.withParamFallback,
}));

import { runLearningToolAgentLoop, type LearningToolAgentLoopOptions } from '../../src/proxy/tools/agentLoop';

function buildResponse(message: Partial<ProxyResponse['choices'][number]['message']>, finishReason: string | null): ProxyResponse {
  return {
    id: 'resp-1',
    object: 'chat.completion',
    model: 'gpt-4.1-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        ...message,
      },
      finish_reason: finishReason,
    }],
  };
}

function createAdapter(parseResponse = vi.fn((data: unknown) => data as ProxyResponse)): Adapter {
  return {
    buildRequest: vi.fn((request: ProxyRequest) => ({ payload: request })),
    parseResponse,
    headers: vi.fn(() => ({})),
    endpoint: vi.fn(() => '/chat/completions'),
  };
}

function buildOptions(overrides: Partial<LearningToolAgentLoopOptions> = {}): LearningToolAgentLoopOptions {
  return {
    url: 'https://openai.test/chat/completions',
    headers: { Authorization: 'Bearer test-key' },
    adapter: createAdapter(),
    request: {
      model: 'gpt-4.1-mini',
      stream: true,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      messages: [{ role: 'user', content: 'review findings' }],
    },
    projectId: 'project-1',
    sessionId: 'session-1',
    requestId: 'request-1',
    providerName: 'OpenAI',
    providerType: 'openai',
    initialResponseData: { id: 'raw-1' },
    initialNormalizedResponse: buildResponse({ content: 'final reply' }, 'stop'),
    ...overrides,
  };
}

describe('proxy/tools/agentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLearningToolsForClientProtocol.mockReturnValue([
      { type: 'function', function: { name: 'ic_list_findings' } },
      { type: 'function', function: { name: 'ic_update_finding' } },
    ]);
    mocks.isLearningToolName.mockImplementation((toolName: string) => toolName.startsWith('ic_'));
    mocks.axiosIsAxiosError.mockImplementation((error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError);
  });

  it('returns non-ic tool calls without executing the internal loop', async () => {
    const responseWithIdeTool = buildResponse({
      tool_calls: [{
        id: 'call_read_file',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"filePath":"src/index.ts"}',
        },
      }],
    }, 'tool_calls');

    const result = await runLearningToolAgentLoop(buildOptions({
      initialNormalizedResponse: responseWithIdeTool,
    }));

    expect(result).toEqual({
      responseData: { id: 'raw-1' },
      normalizedResponse: responseWithIdeTool,
      internalTurnCount: 0,
    });
    expect(mocks.executeLearningTool).not.toHaveBeenCalled();
    expect(mocks.withParamFallback).not.toHaveBeenCalled();
    expect(mocks.appendToolResultReplayEntriesForSession).not.toHaveBeenCalled();
  });

  it('executes mixed internal and IDE tools, then asks the model to re-issue dropped IDE tools', async () => {
    const icToolCall = {
      id: 'call_ic',
      type: 'function',
      function: {
        name: 'ic_list_findings',
        arguments: '{"status":"open"}',
      },
    };
    const ideToolCall = {
      id: 'call_read_file',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"filePath":"src/index.ts"}',
      },
    };
    const finalResponse = buildResponse({ content: 'final reply' }, 'stop');
    const adapter = createAdapter(vi.fn().mockReturnValue(finalResponse));

    mocks.executeLearningTool.mockResolvedValue({
      success: true,
      result: {
        total: 1,
        items: [{ id: 'finding-1', title: 'Missing provenance' }],
      },
    });
    mocks.withParamFallback.mockResolvedValue({
      result: { data: { id: 'raw-2' } },
      paramStripped: null,
    });

    const result = await runLearningToolAgentLoop(buildOptions({
      adapter,
      initialNormalizedResponse: buildResponse({
        content: 'thinking',
        tool_calls: [icToolCall, ideToolCall],
      }, 'tool_calls'),
    }));

    expect(mocks.executeLearningTool).toHaveBeenCalledWith(
      'ic_list_findings',
      { status: 'open' },
      { projectId: 'project-1', sessionId: 'session-1', requestId: 'request-1' },
    );
    expect(mocks.withParamFallback).toHaveBeenCalledTimes(1);

    const forwardedRequest = mocks.withParamFallback.mock.calls[0]?.[0] as ProxyRequest;
    expect(forwardedRequest).toEqual(expect.objectContaining({
      model: 'gpt-4.1-mini',
      stream: false,
      tools: [
        { type: 'function', function: { name: 'ic_list_findings' } },
        { type: 'function', function: { name: 'ic_update_finding' } },
      ],
      messages: [
        { role: 'user', content: 'review findings' },
        { role: 'assistant', content: 'thinking', tool_calls: [icToolCall] },
        {
          role: 'tool',
          tool_call_id: 'call_ic',
          name: 'ic_list_findings',
          content: JSON.stringify({
            success: true,
            result: {
              total: 1,
              items: [{ id: 'finding-1', title: 'Missing provenance' }],
            },
          }),
        },
        {
          role: 'user',
          content: expect.stringContaining('Mixed tool calls are not supported'),
        },
      ],
    }));
    expect(forwardedRequest.messages[3]?.content).toContain('read_file');
    expect(mocks.appendToolResultReplayEntriesForSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      [{
        toolCallId: 'call_ic',
        toolName: 'ic_list_findings',
        arguments: { status: 'open' },
        result: {
          success: true,
          result: {
            total: 1,
            items: [{ id: 'finding-1', title: 'Missing provenance' }],
          },
        },
      }],
    );
    expect(result).toEqual({
      responseData: { id: 'raw-2' },
      normalizedResponse: finalResponse,
      internalTurnCount: 1,
    });
  });

  it('turns malformed learning tool arguments into a tool failure result', async () => {
    const finalResponse = buildResponse({ content: 'final reply' }, 'stop');
    const adapter = createAdapter(vi.fn().mockReturnValue(finalResponse));

    mocks.withParamFallback.mockResolvedValue({
      result: { data: { id: 'raw-2' } },
      paramStripped: null,
    });

    await runLearningToolAgentLoop(buildOptions({
      adapter,
      initialNormalizedResponse: buildResponse({
        tool_calls: [{
          id: 'call_bad_args',
          type: 'function',
          function: {
            name: 'ic_list_findings',
            arguments: '[]',
          },
        }],
      }, 'tool_calls'),
    }));

    expect(mocks.executeLearningTool).not.toHaveBeenCalled();

    const forwardedRequest = mocks.withParamFallback.mock.calls[0]?.[0] as ProxyRequest;
    expect(forwardedRequest.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_bad_args',
      name: 'ic_list_findings',
      content: JSON.stringify({
        success: false,
        result: null,
        error: 'Tool arguments must be a JSON object.',
      }),
    });
    expect(mocks.appendToolResultReplayEntriesForSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      [{
        toolCallId: 'call_bad_args',
        toolName: 'ic_list_findings',
        arguments: {},
        result: {
          success: false,
          result: null,
          error: 'Tool arguments must be a JSON object.',
        },
      }],
    );
  });

  it('returns a fallback response after an upstream POST failure without duplicating replay entries', async () => {
    const fallbackNormalizedResponse = buildResponse({ content: 'fallback reply' }, 'stop');
    const parseResponse = vi.fn().mockReturnValue(fallbackNormalizedResponse);
    const adapter = createAdapter(parseResponse);

    mocks.executeLearningTool.mockResolvedValue({
      success: true,
      result: { total: 0, items: [] },
    });
    mocks.withParamFallback.mockRejectedValue(Object.assign(new Error('upstream unavailable'), {
      isAxiosError: true,
      response: { status: 503 },
    }));

    const result = await runLearningToolAgentLoop(buildOptions({
      adapter,
      initialNormalizedResponse: buildResponse({
        tool_calls: [{
          id: 'call_ic',
          type: 'function',
          function: {
            name: 'ic_list_findings',
            arguments: '{"status":"open"}',
          },
        }],
      }, 'tool_calls'),
    }));

    expect(mocks.appendToolResultReplayEntriesForSession).toHaveBeenCalledTimes(1);
    expect(mocks.appendToolResultReplayEntriesForSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      [{
        toolCallId: 'call_ic',
        toolName: 'ic_list_findings',
        arguments: { status: 'open' },
        result: {
          success: true,
          result: { total: 0, items: [] },
        },
      }],
    );

    const fallbackPayload = parseResponse.mock.calls[0]?.[0] as ProxyResponse;
    expect(fallbackPayload.model).toBe('gpt-4.1-mini');
    expect(fallbackPayload.choices[0]?.message.content).toContain('HTTP 503: upstream unavailable');
    expect(result).toEqual({
      responseData: fallbackPayload,
      normalizedResponse: fallbackNormalizedResponse,
      internalTurnCount: 1,
    });
  });
});