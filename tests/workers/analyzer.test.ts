import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  chunksRepo: {
    findUnsummarized: vi.fn(),
    findFileLinkedByProject: vi.fn(),
  },
  filesRepo: {
    findByChunkIds: vi.fn(),
    findSummariesByFileIds: vi.fn(),
  },
  codeExtractsRepo: {
    findByChunkIds: vi.fn(),
  },
  summariesRepo: {
    findByProject: vi.fn(),
  },
  findingsRepo: {
    findByProject: vi.fn(),
    insert: vi.fn(),
  },
  projectsRepo: {
    findById: vi.fn(),
    updateAnalyzerLastRun: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  implementFinding: vi.fn(),
  getSystemModelConfig: vi.fn(),
  runLearningToolAgentLoop: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.axiosPost,
  },
}));

vi.mock('../../src/db/repositories/chunks', () => ({
  chunksRepo: mocks.chunksRepo,
}));

vi.mock('../../src/db/repositories/files', () => ({
  filesRepo: mocks.filesRepo,
}));

vi.mock('../../src/db/repositories/codeExtracts', () => ({
  codeExtractsRepo: mocks.codeExtractsRepo,
}));

vi.mock('../../src/db/repositories/summaries', () => ({
  summariesRepo: mocks.summariesRepo,
}));

vi.mock('../../src/db/repositories/findings', () => ({
  findingsRepo: mocks.findingsRepo,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/findings/actionFinding', () => ({
  implementFinding: mocks.implementFinding,
}));

vi.mock('../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));

vi.mock('../../src/proxy/tools/agentLoop', () => ({
  runLearningToolAgentLoop: mocks.runLearningToolAgentLoop,
}));

import { runAnalyzer } from '../../src/workers/analyzer';

function makeChunk(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: 'project-1',
    sessionId: null,
    requestId: null,
    fact: `Fact ${id}`,
    category: 'general',
    confidence: 0.8,
    source: 'extraction',
    hash: `hash-${id}`,
    tokensUsed: 12,
    summarized: false,
    createdAt: '2026-06-24T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function makeSummary(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: 'project-1',
    title: `Summary ${id}`,
    content: `Content ${id}`,
    oneLineSummary: `One line ${id}`,
    categoriesList: '["general"]',
    sourceChunkIds: '["chunk-1"]',
    version: 1,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function makeFinding(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: 'project-1',
    type: 'gap',
    severity: 'info',
    title: `Finding ${id}`,
    description: `Description ${id}`,
    relatedIds: { chunkIds: [], summaryIds: [], findingIds: [] },
    actions: [],
    status: 'open',
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    reviewedAt: null,
    actionsAppliedAt: null,
    ...overrides,
  };
}

function makeProvider() {
  return {
    adapter: {
      buildRequest: vi.fn((request) => request),
      parseResponse: vi.fn(() => ({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  type: 'contradiction',
                  severity: 'medium',
                  title: 'Remove stale chunk',
                  description: 'The older chunk should be removed.',
                  actions: [{ action: 'delete', targetType: 'chunk', targetId: 'chunk-1' }],
                },
              ]),
            },
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

describe('runAnalyzer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('chunk-1'),
      makeChunk('chunk-2'),
      makeChunk('chunk-3'),
      makeChunk('chunk-4'),
      makeChunk('chunk-5'),
    ]);
    mocks.chunksRepo.findFileLinkedByProject.mockResolvedValue([]);
    mocks.filesRepo.findByChunkIds.mockResolvedValue(new Map());
    mocks.codeExtractsRepo.findByChunkIds.mockResolvedValue(new Map());
    mocks.summariesRepo.findByProject.mockResolvedValue([]);
    mocks.findingsRepo.findByProject.mockResolvedValue([]);
    mocks.projectsRepo.findById.mockResolvedValue({
      id: 'project-1',
      analyzerLastRun: null,
    });
    mocks.findingsRepo.insert.mockResolvedValue({
      id: 'finding-1',
      title: 'Remove stale chunk',
      actions: [{ action: 'delete', targetType: 'chunk', targetId: 'chunk-1' }],
    });
    mocks.implementFinding.mockResolvedValue({ id: 'finding-1', status: 'implemented' });
    mocks.axiosPost.mockResolvedValue({ data: {} });
    mocks.projectsRepo.updateAnalyzerLastRun.mockResolvedValue(undefined);
    mocks.getSystemModelConfig.mockReturnValue({
      contextSelector: '',
      summarizer: '',
      analyzer: 'gpt-4.1-mini',
      learning: '',
      enableAgentAnalyzer: false,
      analyzerAgentMaxTurns: 60,
    });
    mocks.runLearningToolAgentLoop.mockReset();
  });

  it('auto-implements newly created findings that include parsed actions', async () => {
    await runAnalyzer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider() as any,
    });

    expect(mocks.findingsRepo.insert).toHaveBeenCalledTimes(1);
    expect(mocks.implementFinding).toHaveBeenCalledWith('finding-1');
    expect(mocks.projectsRepo.updateAnalyzerLastRun).toHaveBeenCalledWith('project-1');
  });

  it('includes file-linked chunks, provenance, findings, and dates in the analyzer prompt', async () => {
    mocks.chunksRepo.findFileLinkedByProject.mockResolvedValue([
      makeChunk('chunk-file', {
        fact: 'Database layer now uses PostgreSQL.',
        summarized: true,
        createdAt: '2026-06-25T00:00:00.000Z',
      }),
    ]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      makeSummary('summary-1', { updatedAt: '2026-06-27T00:00:00.000Z' }),
    ]);
    mocks.findingsRepo.findByProject.mockResolvedValue([
      makeFinding('finding-existing', {
        type: 'security',
        severity: 'high',
        title: 'Existing finding',
      }),
    ]);
    mocks.filesRepo.findByChunkIds.mockResolvedValue(new Map([
      ['chunk-file', [{
        id: 'file-1',
        chunkId: 'chunk-file',
        fileName: 'src/db/connection.ts',
        purpose: 'Database connection setup',
        createdAt: new Date('2026-06-25T00:00:00.000Z'),
        deletedAt: null,
      }]],
    ]));
    mocks.filesRepo.findSummariesByFileIds.mockResolvedValue(new Map());
    mocks.codeExtractsRepo.findByChunkIds.mockResolvedValue(new Map([
      ['chunk-file', [{
        id: 'extract-1',
        chunkId: 'chunk-file',
        fileName: 'src/db/connection.ts',
        language: 'ts',
        symbolsJson: '["connectDb"]',
        code: 'export async function connectDb() {}',
        createdAt: new Date('2026-06-25T00:00:00.000Z'),
        deletedAt: null,
      }]],
    ]));

    await runAnalyzer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider() as any,
    });

    const prompt = mocks.axiosPost.mock.calls[0]?.[1]?.messages?.[0]?.content as string;
    expect(prompt).toContain('File-grounded chunks are included even when already summarized');
    expect(prompt).toContain('chunk-file');
    expect(prompt).toContain('src/db/connection.ts');
    expect(prompt).toContain('connectDb');
    expect(prompt).toContain('2026-06-25T00:00:00.000Z');
    expect(prompt).toContain('2026-06-27T00:00:00.000Z');
    expect(prompt).toContain('Existing finding');
  });

  it('runs when enough new file-linked chunks exist after the last analyzer run', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([]);
    mocks.chunksRepo.findFileLinkedByProject.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => makeChunk(`chunk-file-${index + 1}`, {
        summarized: true,
        createdAt: `2026-06-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`,
      }))
    );
    mocks.projectsRepo.findById.mockResolvedValue({
      id: 'project-1',
      analyzerLastRun: '2026-06-01T00:00:00.000Z',
    });

    await runAnalyzer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider() as any,
    });

    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
  });

  it('uses the agent analyzer path with compact summary and chunk indexes when enabled', async () => {
    mocks.getSystemModelConfig.mockReturnValue({
      contextSelector: '',
      summarizer: '',
      analyzer: 'gpt-4.1-mini',
      learning: '',
      enableAgentAnalyzer: true,
      analyzerAgentMaxTurns: 42,
    });
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('chunk-db-1', { category: 'database', createdAt: '2026-06-28T00:00:00.000Z' }),
      makeChunk('chunk-db-2', { category: 'database', createdAt: '2026-06-23T00:00:00.000Z' }),
      makeChunk('chunk-api-1', { category: 'api', createdAt: '2026-06-20T00:00:00.000Z' }),
      makeChunk('chunk-api-2', { category: 'api', createdAt: '2026-06-19T00:00:00.000Z' }),
      makeChunk('chunk-api-3', { category: 'api', createdAt: '2026-06-18T00:00:00.000Z' }),
    ]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      makeSummary('summary-1', {
        content: 'Long summary body that should not be in the compact index.',
        oneLineSummary: 'Tracks database architecture',
        categoriesList: '["database"]',
        sourceChunkIds: '["chunk-db-1","chunk-db-2"]',
        updatedAt: '2026-06-27T00:00:00.000Z',
      }),
    ]);
    mocks.findingsRepo.findByProject.mockResolvedValue([
      makeFinding('finding-open', {
        type: 'gap',
        severity: 'info',
        title: 'Open finding',
        relatedIds: { chunkIds: ['chunk-db-1'], summaryIds: ['summary-1'], findingIds: [] },
      }),
      makeFinding('finding-done', {
        status: 'implemented',
        title: 'Implemented finding',
      }),
    ]);
    mocks.projectsRepo.findById.mockResolvedValue({
      id: 'project-1',
      analyzerLastRun: '2026-06-26T00:00:00.000Z',
    });

    const provider = makeProvider() as any;
    provider.adapter.parseResponse.mockReturnValueOnce({
      id: 'response-1',
      object: 'chat.completion',
      model: 'gpt-4.1-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'ic_get_summary',
                  arguments: '{"summaryId":"summary-1"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    mocks.runLearningToolAgentLoop.mockResolvedValue({
      responseData: { id: 'response-2' },
      normalizedResponse: {
        id: 'response-2',
        object: 'chat.completion',
        model: 'gpt-4.1-mini',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                updatedSummaryIds: ['summary-1'],
                deletedChunkIds: ['chunk-db-2'],
                createdFindingIds: [],
                notes: ['database summary refreshed'],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      },
      internalTurnCount: 3,
    });

    await runAnalyzer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider,
    }, true);

    const prompt = mocks.axiosPost.mock.calls[0]?.[1]?.messages?.[0]?.content as string;
    expect(prompt).toContain('"lastAnalyzerRunAt": "2026-06-26T00:00:00.000Z"');
    expect(prompt).toContain('"summary-1"');
    expect(prompt).toContain('"categories": [');
    expect(prompt).toContain('"changedChunkIds": [');
    expect(prompt).not.toContain('Long summary body that should not be in the compact index.');
    expect(prompt).not.toContain('Fact chunk-db-1');
    expect(prompt).toContain('Open finding');
    expect(prompt).not.toContain('Implemented finding');
    expect(mocks.runLearningToolAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      maxTurns: 42,
    }));
    expect(mocks.findingsRepo.insert).not.toHaveBeenCalled();
    expect(mocks.projectsRepo.updateAnalyzerLastRun).toHaveBeenCalledWith('project-1');
  });

  it('uses anthropic-format tools for the agent analyzer when the provider is anthropic', async () => {
    mocks.getSystemModelConfig.mockReturnValue({
      contextSelector: '',
      summarizer: '',
      analyzer: 'claude-sonnet',
      learning: '',
      enableAgentAnalyzer: true,
      analyzerAgentMaxTurns: 55,
    });
    mocks.projectsRepo.findById.mockResolvedValue({
      id: 'project-1',
      analyzerLastRun: null,
    });

    const provider = makeProvider() as any;
    provider.providerType = 'anthropic';
    provider.adapter.parseResponse.mockReturnValueOnce({
      id: 'response-1',
      object: 'chat.completion',
      model: 'claude-sonnet',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'ic_list_findings',
                  arguments: '{"status":"open"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    mocks.runLearningToolAgentLoop.mockResolvedValue({
      responseData: { id: 'response-2' },
      normalizedResponse: {
        id: 'response-2',
        object: 'chat.completion',
        model: 'claude-sonnet',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                updatedSummaryIds: [],
                deletedChunkIds: [],
                createdFindingIds: [],
                notes: [],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      },
      internalTurnCount: 1,
    });

    await runAnalyzer({
      projectId: 'project-1',
      model: 'claude-sonnet',
      provider,
    }, true);

    expect(mocks.axiosPost.mock.calls[0]?.[1]?.tools?.[0]).toMatchObject({
      name: 'ic_list_chunks',
      input_schema: expect.any(Object),
    });
    expect(mocks.runLearningToolAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      toolClientProtocol: 'anthropic',
      maxTurns: 55,
    }));
  });
});