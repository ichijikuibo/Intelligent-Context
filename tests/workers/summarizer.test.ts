import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  chunksRepo: {
    countUnsummarized: vi.fn(),
    countUnsummarizedCreatedAfter: vi.fn(),
    findUnsummarized: vi.fn(),
    markSummarized: vi.fn(),
  },
  summariesRepo: {
    findByCategory: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  getConfig: vi.fn(),
  getLastRun: vi.fn(),
  setLastRun: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.axiosPost,
  },
}));

vi.mock('../../src/db/repositories/chunks', () => ({
  chunksRepo: mocks.chunksRepo,
}));

vi.mock('../../src/db/repositories/summaries', () => ({
  summariesRepo: mocks.summariesRepo,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/config/config', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/workers/summarizerState', () => ({
  MIN_NEW_CHUNKS_FOR_SCHEDULED_SUMMARIZER: 5,
  getSummarizerLastSuccessfulRunAt: mocks.getLastRun,
  setSummarizerLastSuccessfulRunAt: mocks.setLastRun,
  shouldPersistSuccessfulRun: (hadFailure: boolean, remainingUnsummarized: number) =>
    !hadFailure && remainingUnsummarized === 0,
  shouldRunScheduledSummarizer: (newChunkCount: number) => newChunkCount >= 5,
}));

import { runSummarizer } from '../../src/workers/summarizer';

function makeProvider(content: unknown = '<one-line>Summary</one-line><categories>architecture</categories><content>## Notes\n- Fact</content>') {
  return {
    adapter: {
      buildRequest: vi.fn((request) => request),
      parseResponse: vi.fn(() => ({
        id: 'response-1',
        object: 'chat.completion',
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant' as const,
              content,
            },
            finish_reason: 'stop',
          },
        ],
      })),
      headers: vi.fn(() => ({ Authorization: 'Bearer test' })),
      endpoint: vi.fn(() => 'https://example.test/chat/completions'),
    },
    baseUrl: 'https://example.test',
    apiKey: 'test-key',
    providerName: 'test-provider',
    providerType: 'openai' as const,
  };
}

function makeChunk(id: string, category = 'architecture') {
  return {
    id,
    projectId: 'project-1',
    sessionId: null,
    requestId: null,
    fact: `Fact ${id}`,
    category,
    confidence: 0.8,
    source: 'extraction',
    hash: `hash-${id}`,
    tokensUsed: 10,
    summarized: false,
    createdAt: '2026-06-21T17:00:00.000Z',
  };
}

describe('runSummarizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({
      context: {
        autoSummarizeThreshold: 1,
        reservedResponseTokens: 4000,
        defaultModelMaxTokens: 16000,
        contextOverheadTokens: 500,
      },
    });
    mocks.summariesRepo.findByCategory.mockResolvedValue(undefined);
    mocks.summariesRepo.insert.mockImplementation(async (data) => ({
      id: 'summary-new',
      projectId: data.projectId,
      title: data.title,
      content: data.content,
      oneLineSummary: data.oneLineSummary ?? '',
      categoriesList: data.categoriesList ?? '[]',
      sourceChunkIds: JSON.stringify(data.sourceChunkIds),
      version: 1,
      createdAt: '2026-06-21T17:00:00.000Z',
      updatedAt: '2026-06-21T17:00:00.000Z',
    }));
    mocks.summariesRepo.update.mockImplementation(async (id, data) => ({
      id,
      title: data.title ?? 'Updated Summary',
      content: data.content ?? 'Body',
      oneLineSummary: data.oneLineSummary ?? '',
      categoriesList: data.categoriesList ?? '[]',
      sourceChunkIds: JSON.stringify(data.sourceChunkIds ?? []),
      version: 2,
      createdAt: '2026-06-21T17:00:00.000Z',
      updatedAt: '2026-06-21T17:00:01.000Z',
    }));
    mocks.chunksRepo.markSummarized.mockResolvedValue(undefined);
    mocks.axiosPost.mockResolvedValue({ data: {} });
  });

  it('skips scheduled runs until at least five new chunks exist since the last success', async () => {
    mocks.getLastRun.mockResolvedValue('2026-06-21T16:00:00.000Z');
    mocks.chunksRepo.countUnsummarizedCreatedAfter.mockResolvedValue(4);

    await runSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(),
      trigger: 'scheduled',
    });

    expect(mocks.chunksRepo.findUnsummarized).not.toHaveBeenCalled();
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.setLastRun).not.toHaveBeenCalled();
  });

  it('records the last successful run after a scheduled pass clears the backlog', async () => {
    mocks.getLastRun.mockResolvedValue(null);
    mocks.chunksRepo.countUnsummarized
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(0);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1'),
      makeChunk('2'),
      makeChunk('3'),
      makeChunk('4'),
      makeChunk('5'),
    ]);

    await runSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(),
      trigger: 'scheduled',
    });

    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.chunksRepo.markSummarized).toHaveBeenCalledWith(['1', '2', '3', '4', '5']);
    expect(mocks.setLastRun).toHaveBeenCalledTimes(1);
  });

  it('lets manual runs bypass the five-chunk background gate', async () => {
    mocks.chunksRepo.countUnsummarized.mockResolvedValue(0);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([makeChunk('1', 'global')]);

    await runSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(),
      trigger: 'manual',
    });

    expect(mocks.getLastRun).not.toHaveBeenCalled();
    expect(mocks.chunksRepo.countUnsummarizedCreatedAfter).not.toHaveBeenCalled();
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.setLastRun).toHaveBeenCalledTimes(1);
  });

  it('handles text-block array responses from openai-compatible providers', async () => {
    mocks.chunksRepo.countUnsummarized.mockResolvedValue(0);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'learning'),
      makeChunk('2', 'learning'),
      makeChunk('3', 'learning'),
    ]);

    await runSummarizer({
      projectId: 'project-1',
      model: 'deepseek-v4-pro',
      provider: makeProvider([
        { type: 'text', text: '<one-line>Summary</one-line>' },
        { type: 'text', text: '<categories>learning</categories><content>## Notes\n- Fact</content>' },
      ]),
      trigger: 'manual',
    });

    expect(mocks.summariesRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Summary',
      oneLineSummary: 'Summary',
      content: '## Notes\n- Fact',
      categoriesList: JSON.stringify(['learning']),
      sourceChunkIds: ['1', '2', '3'],
    }));
    expect(mocks.chunksRepo.markSummarized).toHaveBeenCalledWith(['1', '2', '3']);
  });

  it('sends a stable OpenCode session header for background summarizer calls', async () => {
    // OpenCode Go requires the x-opencode-session header, including for
    // background traffic the proxy generates itself. Without this the
    // summarizer upstream returned HTTP 400.
    mocks.chunksRepo.countUnsummarized.mockResolvedValue(0);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'learning'),
      makeChunk('2', 'learning'),
      makeChunk('3', 'learning'),
    ]);

    const provider = makeProvider();
    provider.adapter.endpoint.mockReturnValue('https://opencode.ai/zen/go/v1/chat/completions');

    await runSummarizer({
      projectId: 'project-1',
      model: 'deepseek-v4.1-flash',
      provider,
      trigger: 'manual',
    });

    expect(mocks.axiosPost).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/chat/completions',
      expect.anything(),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test',
          'x-opencode-session': 'ic-summarizer:project-1',
        },
      }),
    );
  });

  it('reuses an active run instead of starting an overlapping summarizer pass', async () => {
    mocks.chunksRepo.countUnsummarized.mockResolvedValue(0);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'learning'),
      makeChunk('2', 'learning'),
      makeChunk('3', 'learning'),
    ]);

    let resolvePost: ((value: { data: {} }) => void) | undefined;
    const postPromise = new Promise<{ data: {} }>((resolve) => {
      resolvePost = resolve;
    });
    mocks.axiosPost.mockReturnValue(postPromise);

    const firstRun = runSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(),
      trigger: 'manual',
    });

    await Promise.resolve();

    const secondRun = runSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(),
      trigger: 'scheduled',
    });

    resolvePost?.({ data: {} });
    await Promise.all([firstRun, secondRun]);

    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Summarizer already running; reusing active run',
      expect.objectContaining({ projectId: 'project-1', trigger: 'scheduled' })
    );
  });

  it('keeps the processing category when the model returns a different category list', async () => {
    mocks.chunksRepo.countUnsummarized.mockResolvedValue(0);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'learning'),
      makeChunk('2', 'learning'),
      makeChunk('3', 'learning'),
    ]);
    mocks.summariesRepo.findByCategory.mockResolvedValue({
      id: 'summary-1',
      projectId: 'project-1',
      title: 'Learning Summary',
      content: '## Existing\n- Older fact',
      oneLineSummary: 'Learning Summary',
      categoriesList: JSON.stringify(['learning', 'architecture']),
      sourceChunkIds: JSON.stringify(['old-1']),
      version: 1,
      createdAt: '2026-06-21T17:00:00.000Z',
      updatedAt: '2026-06-21T17:00:00.000Z',
    });

    await runSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(
        '<one-line>Summary</one-line><categories>architecture, api-design</categories><content>## Notes\n- Fact</content>'
      ),
      trigger: 'manual',
    });

    expect(mocks.summariesRepo.update).toHaveBeenCalledWith(
      'summary-1',
      expect.objectContaining({
        categoriesList: JSON.stringify(['learning', 'architecture', 'api-design']),
      })
    );
  });

  it('splits large category backlogs into multiple batches', async () => {
    mocks.chunksRepo.countUnsummarized.mockResolvedValue(0);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue(
      Array.from({ length: 57 }, (_, index) => ({
        ...makeChunk(String(index + 1), 'learning'),
        tokensUsed: 200,
      }))
    );

    await runSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(
        '<one-line>Summary</one-line><categories>learning</categories><content>## Notes\n- Fact</content>'
      ),
      trigger: 'manual',
    });

    expect(mocks.axiosPost).toHaveBeenCalledTimes(3);
    expect(mocks.chunksRepo.markSummarized).toHaveBeenCalledTimes(3);
    expect(mocks.axiosPost.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ max_tokens: 4000 })
    );
  });
});