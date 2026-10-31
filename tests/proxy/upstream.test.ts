import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';

function normalizeScopedModelId(value: string) {
  const uuidScopedMatch = value.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(.+)$/i);
  if (uuidScopedMatch) {
    return { providerHint: uuidScopedMatch[1], model: uuidScopedMatch[2] };
  }

  const match = value.match(/^([A-Z][A-Z0-9]{1,15})-(.+)$/);
  if (match) {
    return { providerHint: match[1], model: match[2] };
  }
  return { providerHint: undefined, model: value };
}

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  axiosIsAxiosError: vi.fn((error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError),
  hasModelAccess: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  openaiAdapter: {
    buildRequest: vi.fn(),
    parseResponse: vi.fn(),
    headers: vi.fn(),
    endpoint: vi.fn(),
  },
  anthropicAdapter: {
    buildRequest: vi.fn(),
    parseResponse: vi.fn(),
    headers: vi.fn(),
    endpoint: vi.fn(),
  },
  getSystemModelConfig: vi.fn(() => ({
    contextSelector: '',
    summarizer: '',
    analyzer: '',
    gatherer: '',
    learning: '',
    vision: '',
  })),
  getEffectiveContextConfig: vi.fn(() => ({
    gathererSkipOnToolContinuation: false,
  })),
  executeLearningTool: vi.fn(),
  providersRepo: {
    findAnyEnabled: vi.fn(),
    findBestForType: vi.fn(),
    findById: vi.fn(),
    findByShortPrefix: vi.fn(),
    findProviderForModel: vi.fn(),
    findModelForLabel: vi.fn(),
  },
  parseModels: vi.fn((provider: { models?: string }) =>
    (provider.models || '')
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model.length > 0)
  ),
  t: vi.fn((_: unknown, key: string) => key),
  formatUpstreamErrorMessage: vi.fn(() => 'formatted upstream error'),
  normalizeRequestedModelSelection: vi.fn((model: string, providerIdHint?: string) => ({ model, providerIdHint })),
  stripModelPrefix: vi.fn((model: string) => {
    const uuidScopedMatch = model.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(.+)$/i);
    if (uuidScopedMatch) return uuidScopedMatch[2]!;
    const match = model.match(/^([A-Z][A-Z0-9]{1,15})-(.+)$/);
    if (match) return match[2]!;
    return model;
  }),
  buildProviderScopedModelId: vi.fn((provider: { id: string; shortPrefix?: string | null }, model = '') => {
    const shortPrefix = String(provider.shortPrefix || '').trim();
    if (shortPrefix) {
      return model ? `${shortPrefix}-${model}` : shortPrefix;
    }
    return model ? `${provider.id}:${model}` : provider.id;
  }),
  // Gatherer mocks
  getGathererPhase: vi.fn(),
  startAndRunGathererTurn: vi.fn(),
  runGathererTurn: vi.fn(),
  injectGathererResult: vi.fn(),
  clearGathererPhase: vi.fn(),
  writeContextReplayForSession: vi.fn(),
  appendToolResultReplayEntriesForSession: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.axiosPost,
    isAxiosError: mocks.axiosIsAxiosError,
  },
}));

vi.mock('../../src/auth/context', () => ({
  hasModelAccess: mocks.hasModelAccess,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));

vi.mock('../../src/config/configOverrides', () => ({
  getEffectiveContextConfig: mocks.getEffectiveContextConfig,
}));

vi.mock('../../src/proxy/adapters/openai', () => ({
  openaiAdapter: mocks.openaiAdapter,
}));

vi.mock('../../src/proxy/adapters/anthropic', () => ({
  anthropicAdapter: mocks.anthropicAdapter,
}));

vi.mock('../../src/proxy/tools/executor', () => ({
  executeLearningTool: mocks.executeLearningTool,
}));

vi.mock('../../src/proxy/anthropicSseBridge', () => ({
  AnthropicToOpenAiStream: class AnthropicToOpenAiStream extends PassThrough {},
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

vi.mock('../../src/db/repositories/chunks', () => ({
  chunksRepo: { findByProject: vi.fn(() => Promise.resolve([])) },
}));

vi.mock('../../src/db/repositories/summaries', () => ({
  summariesRepo: { findByProject: vi.fn(() => Promise.resolve([])) },
}));

vi.mock('../../src/db/schema', () => ({
  parseModels: mocks.parseModels,
}));

vi.mock('../../src/i18n', () => ({
  t: mocks.t,
}));

vi.mock('../../src/proxy/errorMessage', () => ({
  formatUpstreamErrorMessage: mocks.formatUpstreamErrorMessage,
}));

vi.mock('../../src/proxy/modelSelection', () => ({
  normalizeRequestedModelSelection: mocks.normalizeRequestedModelSelection,
  buildProviderScopedModelId: mocks.buildProviderScopedModelId,
  stripModelPrefix: mocks.stripModelPrefix,
}));

vi.mock('../../src/proxy/gatherer/orchestrator', () => ({
  startAndRunGathererTurn: mocks.startAndRunGathererTurn,
  runGathererTurn: mocks.runGathererTurn,
  injectGathererResult: mocks.injectGathererResult,
}));

vi.mock('../../src/proxy/gatherer/phase', () => ({
  getGathererPhase: mocks.getGathererPhase,
  clearGathererPhase: mocks.clearGathererPhase,
}));

vi.mock('../../src/proxy/contextReplay', () => ({
  writeContextReplayForSession: mocks.writeContextReplayForSession,
  appendToolResultReplayEntriesForSession: mocks.appendToolResultReplayEntriesForSession,
}));

import { chunksRepo } from '../../src/db/repositories/chunks';
import { summariesRepo } from '../../src/db/repositories/summaries';

import {
  proxyToUpstream,
  resolveProviderAndModelForJob,
  resolveProviderForJob,
} from '../../src/proxy/upstream';
import {
  resetModelMetadataCache,
  setProviderModelOverrides,
} from '../../src/proxy/modelMetadataCache';
import { resetVisionDescriptionCache } from '../../src/proxy/vision';

function makeRes() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });

  return Object.assign(stream, {
    headersSent: false,
    _chunks: chunks,
    status: vi.fn().mockReturnValue(stream),
    json: vi.fn(function json(_payload: unknown) {
      (stream as PassThrough & { headersSent: boolean }).headersSent = true;
      return stream;
    }),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(function flushHeaders() {
      (stream as PassThrough & { headersSent: boolean }).headersSent = true;
    }),
  }) as any;
}

function readResponseOutput(res: any): string {
  return Buffer.concat(res._chunks ?? []).toString('utf8');
}

async function flushAsyncWork(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve();
  }
}

describe('proxy/upstream', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.openaiAdapter.buildRequest.mockImplementation((body: unknown) => ({ payload: body }));
    mocks.openaiAdapter.parseResponse.mockImplementation((data: unknown) => data);
    mocks.openaiAdapter.headers.mockImplementation((apiKey: string) => ({ Authorization: `Bearer ${apiKey}` }));
    mocks.openaiAdapter.endpoint.mockImplementation((baseUrl: string) => `${baseUrl}/chat/completions`);

    mocks.anthropicAdapter.buildRequest.mockImplementation((body: unknown) => ({ anthropic: body }));
    mocks.anthropicAdapter.parseResponse.mockImplementation((data: unknown) => data);
    mocks.anthropicAdapter.headers.mockImplementation((apiKey: string) => ({ Authorization: `Bearer ${apiKey}` }));
    mocks.anthropicAdapter.endpoint.mockImplementation((baseUrl: string) => `${baseUrl}/v1/messages`);

    mocks.executeLearningTool.mockResolvedValue({ success: true, result: {} });
    mocks.getSystemModelConfig.mockReturnValue({
      contextSelector: '',
      summarizer: '',
      analyzer: '',
      gatherer: '',
      learning: '',
      vision: '',
    });
    mocks.getEffectiveContextConfig.mockReturnValue({
      gathererSkipOnToolContinuation: false,
    });
    mocks.normalizeRequestedModelSelection.mockImplementation((model: string, providerIdHint?: string) => ({
      model,
      providerIdHint,
    }));
    mocks.providersRepo.findAnyEnabled.mockResolvedValue(null);
    mocks.providersRepo.findBestForType.mockResolvedValue(null);
    mocks.providersRepo.findById.mockResolvedValue(undefined);
    mocks.providersRepo.findByShortPrefix.mockResolvedValue(undefined);
    mocks.providersRepo.findProviderForModel.mockResolvedValue(undefined);
    mocks.providersRepo.findModelForLabel.mockResolvedValue(undefined);
    mocks.hasModelAccess.mockImplementation((user: any, modelId: string) => {
      if (user.role === 'admin') return true;

      const requested = normalizeScopedModelId(modelId);
      return user.allowedModels.some((allowed: string) => {
        if (allowed === modelId) return true;
        const candidate = normalizeScopedModelId(allowed);
        if (candidate.providerHint) {
          return candidate.providerHint === requested.providerHint && candidate.model === requested.model;
        }
        return candidate.model === requested.model;
      });
    });
    mocks.axiosPost.mockResolvedValue({ data: { choices: [{ message: { content: 'raw reply' } }] } });
    mocks.formatUpstreamErrorMessage.mockReturnValue('formatted upstream error');
    vi.mocked(chunksRepo.findByProject).mockResolvedValue([]);
    vi.mocked(summariesRepo.findByProject).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetModelMetadataCache();
    resetVisionDescriptionCache();
  });

  it('resolves a catalog display label to the real provider and upstream model', async () => {
    // The client sent `display_name` from /v1/models, which is not a valid
    // upstream model — it must be mapped back before forwarding.
    mocks.normalizeRequestedModelSelection.mockReturnValue({
      model: 'CommandCode (OpenAI) · DeepSeek V4.1 Flash',
      providerIdHint: undefined,
    });
    mocks.providersRepo.findModelForLabel.mockResolvedValue({
      provider: {
        id: 'provider-cc',
        name: 'CommandCode (OpenAI)',
        type: 'openai',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        apiKey: 'cc-key',
        shortPrefix: 'CCO',
        models: 'deepseek/deepseek-v4.1-flash',
        isEnabled: true,
      },
      modelId: 'deepseek/deepseek-v4.1-flash',
    });
    mocks.openaiAdapter.endpoint.mockReturnValue('https://api.commandcode.ai/provider/v1/chat/completions');
    mocks.openaiAdapter.headers.mockReturnValue({ Authorization: 'Bearer cc-key' });

    const execution = await resolveProviderAndModelForJob('CommandCode (OpenAI) · DeepSeek V4.1 Flash', 'openai');

    expect(execution).toEqual({
      adapter: mocks.openaiAdapter,
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      apiKey: 'cc-key',
      providerName: 'CommandCode (OpenAI)',
      providerType: 'openai',
      // The label must never reach the upstream as the model name.
      model: 'deepseek/deepseek-v4.1-flash',
    });
  });

  it('does not attempt label resolution for plain model IDs', async () => {
    mocks.providersRepo.findProviderForModel.mockResolvedValue({
      id: 'provider-ds',
      name: 'DeepSeek',
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'ds-key',
      models: 'deepseek-chat',
      isEnabled: true,
    });

    await resolveProviderAndModelForJob('deepseek-chat', 'openai');

    expect(mocks.providersRepo.findModelForLabel).not.toHaveBeenCalled();
  });

  it('falls back to an anthropic provider for background jobs when no openai provider exists', async () => {
    mocks.providersRepo.findBestForType
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 'provider-1',
        name: 'Anthropic',
        type: 'anthropic',
        baseUrl: 'https://anthropic.test',
        apiKey: 'anthropic-key',
      });

    const provider = await resolveProviderForJob('openai');

    expect(provider).toEqual({
      adapter: mocks.anthropicAdapter,
      baseUrl: 'https://anthropic.test',
      apiKey: 'anthropic-key',
      providerName: 'Anthropic',
      providerType: 'anthropic',
    });
  });

  it('resolves prefixed job models to the hinted provider and strips the prefix before execution', async () => {
    mocks.normalizeRequestedModelSelection.mockReturnValue({
      model: 'gpt-4.1-mini',
      providerIdHint: 'OAI',
    });
    mocks.providersRepo.findByShortPrefix.mockResolvedValue({
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini, gpt-4.1',
      isEnabled: true,
    });

    const execution = await resolveProviderAndModelForJob('OAI-gpt-4.1-mini', 'openai');

    expect(execution).toEqual({
      adapter: mocks.openaiAdapter,
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      providerName: 'OpenAI',
      providerType: 'openai',
      model: 'gpt-4.1-mini',
    });
  });

  it('falls back to anthropic providers for anthropic-looking job models when direct lookup misses', async () => {
    mocks.providersRepo.findProviderForModel.mockResolvedValue(undefined);
    mocks.providersRepo.findBestForType
      .mockResolvedValueOnce({
        id: 'provider-1',
        name: 'Anthropic',
        type: 'anthropic',
        baseUrl: 'https://anthropic.test',
        apiKey: 'anthropic-key',
        models: '',
        isEnabled: true,
      })
      .mockResolvedValue(undefined);

    const execution = await resolveProviderAndModelForJob('claude-3-5-haiku', 'openai');

    expect(mocks.providersRepo.findBestForType).toHaveBeenCalledWith('anthropic');
    expect(execution).toEqual({
      adapter: mocks.anthropicAdapter,
      baseUrl: 'https://anthropic.test',
      apiKey: 'anthropic-key',
      providerName: 'Anthropic',
      providerType: 'anthropic',
      model: 'claude-3-5-haiku',
    });
  });

  it('rejects requests for explicit models the authenticated user cannot access', async () => {
    mocks.providersRepo.findProviderForModel.mockResolvedValue({
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini, gpt-4.1',
      isEnabled: true,
    });
    mocks.hasModelAccess.mockReturnValue(false);

    const req = {
      body: { model: 'gpt-4.1', messages: [] },
      headers: {},
      user: { role: 'user', accessAllModels: false, allowedModels: ['gpt-4.1-mini'] },
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'You do not have access to this model.', type: 'auth_error' },
    });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('checks access against the resolved provider-scoped model id for prefixed selections', async () => {
    mocks.normalizeRequestedModelSelection.mockReturnValue({
      model: 'gpt-4.1-mini',
      providerIdHint: 'OAI',
    });
    mocks.providersRepo.findByShortPrefix.mockResolvedValue({
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      shortPrefix: 'OAI',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini, gpt-4.1',
      isEnabled: true,
    });
    mocks.hasModelAccess.mockReturnValue(false);

    const req = {
      body: { model: 'OAI-gpt-4.1-mini', messages: [] },
      headers: {},
      user: { role: 'user', accessAllModels: false, allowedModels: [] },
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res);

    expect(mocks.hasModelAccess).toHaveBeenCalledWith(req.user, 'OAI-gpt-4.1-mini');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('chooses the first allowed model for unknown selections and returns the response as-is for non-streaming project requests', async () => {
    mocks.providersRepo.findBestForType.mockResolvedValue({
      id: '123e4567-e89b-42d3-a456-426614174000',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini, gpt-4.1',
      isEnabled: true,
    });
    mocks.openaiAdapter.parseResponse.mockReturnValue({
      id: 'resp-1',
      object: 'chat.completion',
      model: 'gpt-4.1-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'raw reply' }, finish_reason: 'stop' }],
    });

    const req = {
      body: { model: 'unknown', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-session-id': 'session-1', 'x-ic-request-id': 'request-1' },
      projectId: 'project-1',
      user: { role: 'user', accessAllModels: false, allowedModels: ['gpt-4.1-mini'] },
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res);

    expect(req.body.model).toBe('gpt-4.1-mini');
    expect(mocks.axiosPost).toHaveBeenCalledWith(
      'https://openai.test/chat/completions',
      { payload: req.body },
      expect.objectContaining({ headers: { Authorization: 'Bearer openai-key' }, timeout: 120_000 })
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: [{ index: 0, message: { role: 'assistant', content: 'raw reply' }, finish_reason: 'stop' }],
      })
    );
  });

  it('adds the stable session header for OpenCode Go upstream requests', async () => {
    mocks.providersRepo.findBestForType.mockResolvedValue({
      id: 'provider-opencode',
      name: 'opencode Go',
      type: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'opencode-key',
      models: 'deepseek-v4.1-flash',
      isEnabled: true,
    });
    mocks.openaiAdapter.endpoint.mockReturnValue('https://opencode.ai/zen/go/v1/chat/completions');

    const req = {
      body: { model: 'unknown', messages: [{ role: 'user', content: 'hi' }] },
      headers: {
        'x-session-id': 'workspace-session',
        'x-opencode-session': 'chat-session-1',
      },
      user: { role: 'user', accessAllModels: true, allowedModels: [] },
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res);

    expect(mocks.axiosPost).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/chat/completions',
      { payload: req.body },
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer opencode-key',
          'x-opencode-session': 'chat-session-1',
        },
      })
    );
  });

  it('executes internal learning tool calls before returning the final response', async () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'ic_list_findings',
          arguments: '{"status":"open","limit":5}',
        },
      },
    ];

    mocks.providersRepo.findProviderForModel.mockResolvedValue({
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini',
      isEnabled: true,
    });
    mocks.openaiAdapter.parseResponse
      .mockReturnValueOnce({
        id: 'resp-1',
        object: 'chat.completion',
        model: 'gpt-4.1-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
      })
      .mockReturnValueOnce({
        id: 'resp-2',
        object: 'chat.completion',
        model: 'gpt-4.1-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'final reply' }, finish_reason: 'stop' }],
      });
    mocks.axiosPost
      .mockResolvedValueOnce({ data: { id: 'raw-1' } })
      .mockResolvedValueOnce({ data: { id: 'raw-2' } });
    mocks.executeLearningTool.mockResolvedValue({
      success: true,
      result: {
        total: 1,
        items: [{ id: 'finding-1', title: 'Missing provenance' }],
      },
    });

    const req = {
      body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'review findings' }] },
      headers: { 'x-session-id': 'session-1', 'x-ic-request-id': 'request-1' },
      projectId: 'project-1',
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res);

    expect(mocks.executeLearningTool).toHaveBeenCalledWith(
      'ic_list_findings',
      { status: 'open', limit: 5 },
      { projectId: 'project-1', sessionId: 'session-1', requestId: 'request-1' }
    );
    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    expect(mocks.appendToolResultReplayEntriesForSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      [
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
      ],
    );
    expect(mocks.axiosPost.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          model: 'gpt-4.1-mini',
          stream: false,
          tools: expect.any(Array),
          messages: [
          { role: 'user', content: 'review findings' },
          { role: 'assistant', content: '', tool_calls: toolCalls },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'ic_list_findings',
            content: JSON.stringify({
              success: true,
              result: {
                total: 1,
                items: [{ id: 'finding-1', title: 'Missing provenance' }],
              },
            }),
          },
        ],
      }),
    }));
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: [{ index: 0, message: { role: 'assistant', content: 'final reply' }, finish_reason: 'stop' }],
      })
    );
  });

  it('executes internal learning tool calls for anthropic client requests before returning the final response', async () => {
    mocks.providersRepo.findProviderForModel.mockResolvedValue({
      id: 'provider-1',
      name: 'Anthropic',
      type: 'anthropic',
      baseUrl: 'https://anthropic.test',
      apiKey: 'anthropic-key',
      models: 'claude-sonnet-4',
      isEnabled: true,
    });
    mocks.anthropicAdapter.parseResponse
      .mockReturnValueOnce({
        id: 'resp-1',
        object: 'chat.completion',
        model: 'claude-sonnet-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'toolu_1',
              type: 'function',
              function: {
                name: 'ic_list_findings',
                arguments: '{"status":"open","limit":3}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })
      .mockReturnValueOnce({
        id: 'resp-2',
        object: 'chat.completion',
        model: 'claude-sonnet-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'final reply' }, finish_reason: 'stop' }],
      });
    mocks.axiosPost
      .mockResolvedValueOnce({
        data: {
          id: 'msg_1',
          model: 'claude-sonnet-4',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'ic_list_findings', input: { status: 'open', limit: 3 } }],
          stop_reason: 'tool_use',
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 'msg_2',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'final reply' }],
          stop_reason: 'end_turn',
        },
      });
    mocks.executeLearningTool.mockResolvedValue({
      success: true,
      result: {
        total: 1,
        items: [{ id: 'finding-1', title: 'Anthropic finding' }],
      },
    });

    const req = {
      body: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'review findings' }] },
      headers: { 'x-session-id': 'session-1', 'x-ic-request-id': 'request-1' },
      projectId: 'project-1',
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res, { clientProtocol: 'anthropic' });

    expect(mocks.executeLearningTool).toHaveBeenCalledWith(
      'ic_list_findings',
      { status: 'open', limit: 3 },
      { projectId: 'project-1', sessionId: 'session-1', requestId: 'request-1' }
    );
    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
    expect(mocks.appendToolResultReplayEntriesForSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      [
        {
          toolCallId: 'toolu_1',
          toolName: 'ic_list_findings',
          arguments: { status: 'open', limit: 3 },
          result: {
            success: true,
            result: {
              total: 1,
              items: [{ id: 'finding-1', title: 'Anthropic finding' }],
            },
          },
        },
      ],
    );
    expect(mocks.axiosPost.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        anthropic: expect.objectContaining({
          model: 'claude-sonnet-4',
          messages: [
            { role: 'user', content: 'review findings' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'toolu_1',
                type: 'function',
                function: {
                  name: 'ic_list_findings',
                  arguments: '{"status":"open","limit":3}',
                },
              }],
            },
            {
              role: 'tool',
              tool_call_id: 'toolu_1',
              name: 'ic_list_findings',
              content: JSON.stringify({
                success: true,
                result: {
                  total: 1,
                  items: [{ id: 'finding-1', title: 'Anthropic finding' }],
                },
              }),
            },
          ],
          tools: expect.any(Array),
        }),
      })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'final reply' }],
    }));
  });

  it('rejects anthropic client requests when only a non-anthropic provider is available', async () => {
    mocks.providersRepo.findBestForType
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 'provider-1',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://openai.test',
        apiKey: 'openai-key',
        models: 'gpt-4.1-mini',
        isEnabled: true,
      });

    const req = {
      body: { model: '', messages: [] },
      headers: {},
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res, { clientProtocol: 'anthropic' });

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'api.error.noAnthropicProviderForMessages', type: 'configuration_error' },
    });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('routes through the messages API when a model override changes its wire format', async () => {
    // The provider row itself stays OpenAI-typed; only the model override says
    // this specific model speaks Anthropic. The request must follow the model.
    setProviderModelOverrides('provider-1', [
      { modelId: 'claude-sonnet-5', apiFormat: 'anthropic' },
    ]);
    mocks.providersRepo.findProviderForModel.mockResolvedValue({
      id: 'provider-1',
      name: 'Gateway',
      type: 'openai',
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'gateway-key',
      models: 'claude-sonnet-5, gpt-6',
      isEnabled: true,
    });

    const req = {
      body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      headers: {},
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res, { clientProtocol: 'anthropic' });

    expect(res.status).not.toHaveBeenCalledWith(502);
    expect(mocks.axiosPost).toHaveBeenCalledWith(
      'https://gateway.test/v1/v1/messages',
      expect.objectContaining({ anthropic: expect.any(Object) }),
      expect.objectContaining({ headers: { Authorization: 'Bearer gateway-key' } })
    );
  });

  describe('vision delegation', () => {
    const TARGET_PROVIDER = {
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test/v1',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini',
      isEnabled: true,
    };

    const VISION_PROVIDER = {
      id: 'provider-vision',
      name: 'Vision Gateway',
      type: 'openai',
      baseUrl: 'https://vision.test/v1',
      apiKey: 'vision-key',
      models: 'vision-model',
      isEnabled: true,
    };

    function primeVisionProviders() {
      mocks.providersRepo.findProviderForModel.mockImplementation(async (model: string) =>
        model === 'vision-model' ? VISION_PROVIDER : TARGET_PROVIDER
      );
    }

    function visionConfig(vision: string) {
      mocks.getSystemModelConfig.mockReturnValue({
        contextSelector: '',
        summarizer: '',
        analyzer: '',
        gatherer: '',
        learning: '',
        vision,
      });
    }

    function imageRequest() {
      return {
        body: {
          model: 'gpt-4.1-mini',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
              ],
            },
          ],
        },
        headers: { 'x-session-id': 'session-1', 'x-ic-request-id': 'request-1' },
      } as any;
    }

    it('interprets images with the configured vision model when the target cannot see them', async () => {
      visionConfig('vision-model');
      primeVisionProviders();
      mocks.axiosPost
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'A red error dialog.' } }] } })
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'raw reply' } }] } });

      const req = imageRequest();
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.axiosPost).toHaveBeenCalledTimes(2);

      // The vision model receives the image itself.
      const [visionUrl, visionPayload] = mocks.axiosPost.mock.calls[0] as [string, unknown];
      expect(visionUrl).toBe('https://vision.test/v1/chat/completions');
      expect(JSON.stringify(visionPayload)).toContain('data:image/png;base64,QUJD');

      // The main model receives the description instead of the image.
      const [, mainPayload] = mocks.axiosPost.mock.calls[1] as [string, unknown];
      expect(JSON.stringify(mainPayload)).toContain('image_description');
      expect(JSON.stringify(mainPayload)).toContain('A red error dialog.');
      expect(JSON.stringify(mainPayload)).not.toContain('image_url');
    });

    it('leaves images untouched for a model marked as vision-capable', async () => {
      setProviderModelOverrides('provider-1', [{ modelId: 'gpt-4.1-mini', supportsVision: true }]);
      visionConfig('vision-model');
      primeVisionProviders();
      mocks.axiosPost.mockResolvedValue({ data: { choices: [{ message: { content: 'raw reply' } }] } });

      const req = imageRequest();
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mocks.axiosPost.mock.calls[0]?.[1])).toContain('image_url');
    });

    it('forwards images untouched when no vision model is configured', async () => {
      visionConfig('');
      primeVisionProviders();
      mocks.axiosPost.mockResolvedValue({ data: { choices: [{ message: { content: 'raw reply' } }] } });

      const req = imageRequest();
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mocks.axiosPost.mock.calls[0]?.[1])).toContain('image_url');
    });

    it('degrades to a placeholder when the vision model fails', async () => {
      visionConfig('vision-model');
      primeVisionProviders();
      mocks.axiosPost
        .mockRejectedValueOnce(new Error('vision upstream down'))
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'raw reply' } }] } });

      const req = imageRequest();
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
      const [, mainPayload] = mocks.axiosPost.mock.calls[1] as [string, unknown];
      expect(JSON.stringify(mainPayload)).toContain('unavailable');
      expect(JSON.stringify(mainPayload)).toContain('could not be interpreted');
    });
  });

  it('surfaces streaming upstream failures with the formatted upstream error', async () => {
    mocks.providersRepo.findBestForType.mockResolvedValue({
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini',
      isEnabled: true,
    });
    mocks.axiosPost.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 504 },
    });
    mocks.formatUpstreamErrorMessage.mockReturnValue('gateway timeout');

    const req = {
      body: { model: 'gpt-4.1-mini', messages: [], stream: true },
      headers: {},
    } as any;
    const res = makeRes();

    await proxyToUpstream(req, res);

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'gateway timeout', type: 'upstream_error' },
    });
  });

  it('passes through normal streaming responses when learning tools are available but unused', async () => {
    const upstreamStream = new PassThrough();

    mocks.providersRepo.findProviderForModel.mockResolvedValue({
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini',
      isEnabled: true,
    });
    mocks.axiosPost.mockResolvedValue({ data: upstreamStream });

    const req = {
      body: {
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'ic_list_findings' } }],
      },
      headers: {},
      projectId: 'project-1',
    } as any;
    const res = makeRes();

    // Start proxy — it will block internally waiting for stream end, so
    // we must write data BEFORE awaiting the returned promise.
    const proxyPromise = proxyToUpstream(req, res);

    // Allow the internal axios.post to resolve and buffering listeners to attach.
    await flushAsyncWork();

    upstreamStream.write('data: {"id":"resp-1","model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
    await flushAsyncWork();

    upstreamStream.write('data: {"id":"resp-1","model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n');
    await flushAsyncWork();

    upstreamStream.end('data: [DONE]\n\n');

    // Now wait for proxy to finish processing the buffered stream.
    await proxyPromise;
    // Stream data flows through pipe() on process.nextTick — use
    // setImmediate to let the pipe chain fully drain.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(res.flushHeaders).toHaveBeenCalled();
    expect(mocks.executeLearningTool).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(readResponseOutput(res)).toContain('"content":"hello"');
  });

  // ── Gatherer routing tests ────────────────────────────────────────

  describe('gatherer routing', () => {
    const gathererProvider = {
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://openai.test',
      apiKey: 'openai-key',
      models: 'gpt-4.1-mini',
      isEnabled: true,
    };

    beforeEach(() => {
      // Default: gatherer is enabled with deepseek-chat
      mocks.getSystemModelConfig.mockReturnValue({
        contextSelector: '',
        summarizer: '',
        analyzer: '',
        gatherer: 'deepseek-chat',
        learning: '',
      });
      mocks.getEffectiveContextConfig.mockReturnValue({
        gathererSkipOnToolContinuation: false,
      });
      mocks.providersRepo.findProviderForModel.mockResolvedValue(gathererProvider);
      mocks.providersRepo.findBestForType.mockResolvedValue(gathererProvider);
      mocks.openaiAdapter.buildRequest.mockImplementation((body: unknown) => ({ payload: body }));
      mocks.openaiAdapter.headers.mockImplementation((apiKey: string) => ({ Authorization: `Bearer ${apiKey}` }));
      mocks.openaiAdapter.endpoint.mockImplementation((baseUrl: string) => `${baseUrl}/chat/completions`);

      // Reset gatherer-specific mocks
      mocks.getGathererPhase.mockReset();
      mocks.startAndRunGathererTurn.mockReset();
      mocks.runGathererTurn.mockReset();
      mocks.injectGathererResult.mockReset();
      mocks.clearGathererPhase.mockReset();
      mocks.writeContextReplayForSession.mockReset();
    });

    it('starts the gatherer phase on the first non-continuation request when gathererModel is set', async () => {
      // Arrange: no existing phase, gatherer finishes on first turn (no tool calls needed)
      mocks.getGathererPhase.mockReturnValue(undefined);
      mocks.startAndRunGathererTurn.mockResolvedValue({
        phaseFinished: true,
        capturedText: '<gatherer_analysis>file analysis</gatherer_analysis>',
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hello' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-1', 'x-ic-request-id': 'request-1' },
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      // Should have started the gatherer phase
      expect(mocks.startAndRunGathererTurn).toHaveBeenCalledTimes(1);
      expect(mocks.startAndRunGathererTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          gathererModel: 'deepseek-chat',
          projectId: 'project-1',
          sessionId: 'gatherer-session-1',
        }),
        res
      );

      // Should have injected the gathered context
      expect(mocks.injectGathererResult).toHaveBeenCalledWith(
        req.body,
        '<gatherer_analysis>file analysis</gatherer_analysis>'
      );

      // Should have cleared the phase
      expect(mocks.clearGathererPhase).toHaveBeenCalledWith('gatherer-session-1');
      expect(mocks.writeContextReplayForSession).toHaveBeenCalledTimes(1);

      // Should have fallen through to the main model pipe
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('streams gatherer tool calls to the IDE without falling through to the main model', async () => {
      // Arrange: gatherer returns tool_calls — not finished
      mocks.getGathererPhase.mockReturnValue(undefined);
      mocks.startAndRunGathererTurn.mockResolvedValue({
        phaseFinished: false,
        capturedText: '',
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'explore' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-2', 'x-ic-request-id': 'request-2' },
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      // Gatherer ran but did NOT finish
      expect(mocks.startAndRunGathererTurn).toHaveBeenCalledTimes(1);
      expect(mocks.injectGathererResult).not.toHaveBeenCalled();
      expect(mocks.clearGathererPhase).not.toHaveBeenCalled();

      // Main model NOT called — we returned early
      expect(mocks.axiosPost).not.toHaveBeenCalled();
    });

    it('routes a continuation turn back to the gatherer when phase is in progress', async () => {
      // Arrange: phase exists and is NOT finished → route to runGathererTurn
      mocks.getGathererPhase.mockReturnValue({
        model: 'deepseek-chat',
        finished: false,
        capturedText: '',
        startedAt: Date.now(),
      });
      mocks.runGathererTurn.mockResolvedValue({
        phaseFinished: true,
        capturedText: '<gatherer_analysis>gathered info</gatherer_analysis>',
      });
      mocks.openaiAdapter.buildRequest.mockImplementation((body: unknown) => ({ payload: body }));
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: {
          model: 'gpt-4.1-mini',
          messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'file result' }],
          stream: true,
        },
        headers: { 'x-session-id': 'gatherer-session-3', 'x-ic-request-id': 'request-3' },
        projectId: 'project-1',
        toolContinuation: true,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      // Used runGathererTurn (not startAndRunGathererTurn)
      expect(mocks.runGathererTurn).toHaveBeenCalledTimes(1);
      expect(mocks.startAndRunGathererTurn).not.toHaveBeenCalled();
      expect(mocks.runGathererTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          gathererModel: 'deepseek-chat',
          sessionId: 'gatherer-session-3',
        }),
        res
      );

      // Inject and clear
      expect(mocks.injectGathererResult).toHaveBeenCalledTimes(1);
      expect(mocks.clearGathererPhase).toHaveBeenCalledTimes(1);
      expect(mocks.writeContextReplayForSession).toHaveBeenCalledTimes(1);

      // Falls through to main model
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('falls through to the main model when the gatherer finishes with an empty handoff', async () => {
      mocks.getGathererPhase
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          model: 'deepseek-chat',
          finished: false,
          capturedText: '',
          startedAt: Date.now(),
          originalMessages: [{ role: 'user', content: 'explore' }],
        });
      mocks.startAndRunGathererTurn.mockResolvedValue({
        phaseFinished: true,
        capturedText: '',
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'explore' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-empty', 'x-ic-request-id': 'request-empty' },
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.startAndRunGathererTurn).toHaveBeenCalledTimes(1);
      expect(mocks.injectGathererResult).not.toHaveBeenCalled();
      expect(mocks.writeContextReplayForSession).not.toHaveBeenCalled();
      expect(mocks.clearGathererPhase).toHaveBeenCalledWith('gatherer-session-empty');
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('recovers a stale finished gatherer phase without rerunning the gatherer', async () => {
      mocks.getGathererPhase.mockReturnValue({
        model: 'deepseek-chat',
        finished: true,
        capturedText: '<gatherer_analysis>recovered analysis</gatherer_analysis>',
        startedAt: Date.now(),
        originalMessages: [{ role: 'user', content: 'continue' }],
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: {
          model: 'gpt-4.1-mini',
          messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'tool result' }],
          stream: true,
        },
        headers: { 'x-session-id': 'gatherer-session-stale', 'x-ic-request-id': 'request-stale' },
        projectId: 'project-1',
        toolContinuation: true,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.startAndRunGathererTurn).not.toHaveBeenCalled();
      expect(mocks.runGathererTurn).not.toHaveBeenCalled();
      expect(mocks.injectGathererResult).toHaveBeenCalledWith(
        req.body,
        '<gatherer_analysis>recovered analysis</gatherer_analysis>'
      );
      expect(mocks.writeContextReplayForSession).toHaveBeenCalledWith(
        'project-1',
        'gatherer-session-stale',
        expect.stringContaining('<gatherer_analysis>recovered analysis</gatherer_analysis>')
      );
      expect(mocks.clearGathererPhase).toHaveBeenCalledWith('gatherer-session-stale');
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('skips the gatherer entirely when gathererModel is empty', async () => {
      mocks.getSystemModelConfig.mockReturnValue({
        contextSelector: '',
        summarizer: '',
        analyzer: '',
        gatherer: '',
        learning: '',
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-4', 'x-ic-request-id': 'request-4' },
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.getGathererPhase).not.toHaveBeenCalled();
      expect(mocks.startAndRunGathererTurn).not.toHaveBeenCalled();
      expect(mocks.runGathererTurn).not.toHaveBeenCalled();

      // Main model runs directly
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('skips the gatherer when requestContextMode is not gatherer even if a gatherer model is configured', async () => {
      mocks.getSystemModelConfig.mockReturnValue({
        requestContextMode: 'basic',
        contextSelector: '',
        summarizer: '',
        analyzer: '',
        gatherer: 'deepseek-chat',
        learning: '',
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-mode', 'x-ic-request-id': 'request-mode' },
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.getGathererPhase).not.toHaveBeenCalled();
      expect(mocks.startAndRunGathererTurn).not.toHaveBeenCalled();
      expect(mocks.runGathererTurn).not.toHaveBeenCalled();
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('skips the gatherer on tool continuations when gathererSkipOnToolContinuation is true', async () => {
      mocks.getEffectiveContextConfig.mockReturnValue({
        gathererSkipOnToolContinuation: true,
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'continue' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-5', 'x-ic-request-id': 'request-5' },
        projectId: 'project-1',
        toolContinuation: true,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      // With toolContinuation=true & skipOn=true, the !phase branch has
      // (!ctx.gathererSkipOnToolContinuation || !toolContinuation)
      // = (false || false) = false → so we skip gatherer
      expect(mocks.startAndRunGathererTurn).not.toHaveBeenCalled();
      expect(mocks.runGathererTurn).not.toHaveBeenCalled();

      // Main model runs directly
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('still runs the gatherer on a new request (non-continuation) even when skipOnToolContinuation is true', async () => {
      mocks.getEffectiveContextConfig.mockReturnValue({
        gathererSkipOnToolContinuation: true,
      });
      mocks.getGathererPhase.mockReturnValue(undefined);
      mocks.startAndRunGathererTurn.mockResolvedValue({
        phaseFinished: true,
        capturedText: '<gatherer_analysis>analysis</gatherer_analysis>',
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'new request' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-6', 'x-ic-request-id': 'request-6' },
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      // Non-continuation → gatherer runs despite skipOn setting
      expect(mocks.startAndRunGathererTurn).toHaveBeenCalledTimes(1);
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('skips the gatherer when sessionId is missing', async () => {
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }], stream: true },
        headers: { 'x-ic-request-id': 'request-7' },  // no session-id header
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      // gathererEnabled requires !!sessionId → false when missing
      expect(mocks.startAndRunGathererTurn).not.toHaveBeenCalled();
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('skips the gatherer when gatherer model and main model have the same base name', async () => {
      mocks.getSystemModelConfig.mockReturnValue({
        gatherer: 'DSK-deepseek-chat',
        contextSelector: '',
        summarizer: '',
        analyzer: '',
        learning: '',
      });
      mocks.getEffectiveContextConfig.mockReturnValue({
        gathererSkipOnToolContinuation: false,
      });
      mocks.axiosPost.mockResolvedValue({ data: new PassThrough() });

      const req = {
        body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: true },
        headers: { 'x-session-id': 'gatherer-session-same-model', 'x-ic-request-id': 'request-same-model' },
        projectId: 'project-1',
        toolContinuation: false,
      } as any;
      const res = makeRes();

      await proxyToUpstream(req, res);

      expect(mocks.getGathererPhase).not.toHaveBeenCalled();
      expect(mocks.startAndRunGathererTurn).not.toHaveBeenCalled();
      expect(mocks.runGathererTurn).not.toHaveBeenCalled();
      expect(mocks.logger.info).toHaveBeenCalledWith(
        'Gatherer skipped — gatherer model and main model share the same base model',
        expect.objectContaining({
          gathererModel: 'DSK-deepseek-chat',
          mainModel: 'deepseek-chat',
          baseModel: 'deepseek-chat',
        }),
      );

      // Main model runs directly
      expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });
  });
});
