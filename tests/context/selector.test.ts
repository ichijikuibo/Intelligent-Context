import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  chunksRepo: {
    searchByKeywords: vi.fn(),
    findUnsummarized: vi.fn(),
    findByIds: vi.fn(),
    countUnsummarized: vi.fn(),
    countByProject: vi.fn(),
    findByProject: vi.fn(),
  },
  summariesRepo: {
    findByProject: vi.fn(),
    countByProject: vi.fn(),
  },
  findingsRepo: {
    findOpenGapsByProject: vi.fn(),
    countOpenGapsByProject: vi.fn(),
  },
  filesRepo: {
    findByChunkIds: vi.fn(),
    findByChunkId: vi.fn(),
    findByProjectFileHints: vi.fn(),
    findByProjectFileHintsList: vi.fn(),
    findSummariesByFileIds: vi.fn(),
    findChunksByFileIds: vi.fn(),
  },
  codeExtractsRepo: {
    findByChunkIds: vi.fn(),
  },
  selectionsRepo: {
    insert: vi.fn(),
  },
  embeddingsRepo: {
    findByChunkIds: vi.fn(),
  },
  getEffectiveContextConfig: vi.fn(),
  getSystemModelConfig: vi.fn(),
  resolveProviderForJob: vi.fn(),
  resolveProviderAndModelForJob: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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

vi.mock('../../src/db/repositories/findings', () => ({
  findingsRepo: mocks.findingsRepo,
}));

vi.mock('../../src/db/repositories/files', () => ({
  filesRepo: mocks.filesRepo,
}));

vi.mock('../../src/db/repositories/codeExtracts', () => ({
  codeExtractsRepo: mocks.codeExtractsRepo,
}));

vi.mock('../../src/db/repositories/selections', () => ({
  selectionsRepo: mocks.selectionsRepo,
}));

vi.mock('../../src/db/repositories/embeddings', () => ({
  embeddingsRepo: mocks.embeddingsRepo,
}));

vi.mock('../../src/config/configOverrides', () => ({
  getEffectiveContextConfig: mocks.getEffectiveContextConfig,
}));

vi.mock('../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));

vi.mock('../../src/proxy/upstream', () => ({
  resolveProviderForJob: mocks.resolveProviderForJob,
  resolveProviderAndModelForJob: mocks.resolveProviderAndModelForJob,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import { selectContext } from '../../src/context/selector';

describe('selectContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.axiosPost.mockReset();
    mocks.getSystemModelConfig.mockReturnValue({ contextSelector: '' });
    mocks.resolveProviderForJob.mockResolvedValue(null);
    mocks.resolveProviderAndModelForJob.mockResolvedValue(null);
    mocks.getEffectiveContextConfig.mockReturnValue({
      maxCandidates: 10,
      tokenBudget: 5000,
      semanticDuplicateThreshold: 0.92,
      bypassSelectorItemThreshold: 10,
      bypassSelectorTokenThreshold: 3000,
      reservedResponseTokens: 1000,
      contextOverheadTokens: 200,
      defaultModelMaxTokens: 16000,
    });
    mocks.chunksRepo.searchByKeywords.mockResolvedValue([]);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([]);
    mocks.chunksRepo.findByIds.mockResolvedValue([]);
    mocks.chunksRepo.countUnsummarized.mockResolvedValue(0);
    mocks.chunksRepo.findByProject.mockResolvedValue([]);
    mocks.chunksRepo.countByProject.mockResolvedValue(0);
    mocks.embeddingsRepo.findByChunkIds.mockResolvedValue([]);
    mocks.summariesRepo.findByProject.mockResolvedValue([]);
    mocks.summariesRepo.countByProject.mockResolvedValue(0);
    mocks.findingsRepo.findOpenGapsByProject.mockResolvedValue([]);
    mocks.findingsRepo.countOpenGapsByProject.mockResolvedValue(0);
    mocks.filesRepo.findByChunkIds.mockResolvedValue(new Map());
    mocks.filesRepo.findByChunkId.mockResolvedValue([]);
    mocks.filesRepo.findByProjectFileHints.mockResolvedValue(new Map());
    mocks.filesRepo.findByProjectFileHintsList.mockResolvedValue([]);
    mocks.filesRepo.findSummariesByFileIds.mockResolvedValue(new Map());
    mocks.filesRepo.findChunksByFileIds.mockResolvedValue(new Map());
    mocks.codeExtractsRepo.findByChunkIds.mockResolvedValue(new Map());
    mocks.selectionsRepo.insert.mockResolvedValue(undefined);
  });

  it('treats file-linked summaries as guaranteed context for referenced files', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      {
        id: 'chunk-auth-1',
        fact: 'Auth refresh tokens are coordinated from src/auth/context.ts.',
        category: 'auth',
        createdAt: '2026-07-01T12:34:56.000Z',
      },
    ]);
    mocks.chunksRepo.findByIds.mockResolvedValue([
      {
        id: 'chunk-auth-1',
        fact: 'Auth refresh tokens are coordinated from src/auth/context.ts.',
        category: 'auth',
        createdAt: '2026-07-01T12:34:56.000Z',
      },
    ]);
    mocks.filesRepo.findByChunkIds.mockResolvedValue(new Map([
      ['chunk-auth-1', [{ id: 'file-auth', chunkId: 'chunk-auth-1', fileName: 'src/auth/context.ts', purpose: 'Auth request context and refresh handling.' }]],
    ]));
    mocks.filesRepo.findByProjectFileHintsList.mockResolvedValue([
      {
        id: 'file-auth',
        projectId: 'project-1',
        fileName: 'src/auth/context.ts',
        normalizedFileName: 'src/auth/context.ts',
        purpose: 'Auth request context and refresh handling.',
        chunkCount: 1,
        summaryCount: 1,
        createdAt: '2026-07-01T12:00:00.000Z',
        updatedAt: '2026-07-04T10:11:12.000Z',
        deletedAt: null,
      },
    ]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-global',
        oneLineSummary: 'Project uses strict TypeScript and concise API handlers.',
        categoriesList: '["global"]',
        content: '## Global\n- Use strict TypeScript.\n- Keep API handlers concise.',
        createdAt: '2026-06-25T08:00:00.000Z',
        updatedAt: '2026-07-03T09:10:11.000Z',
      },
      {
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh logic lives in the auth context pipeline.',
        categoriesList: '["auth"]',
        content: '## Auth\n- Refresh tokens are coordinated by the auth context pipeline.',
        createdAt: '2026-07-02T08:00:00.000Z',
        updatedAt: '2026-07-04T10:11:12.000Z',
      },
    ]);
    mocks.filesRepo.findSummariesByFileIds.mockResolvedValue(new Map([
      ['file-auth', [{
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh logic lives in the auth context pipeline.',
        categoriesList: '["auth"]',
        content: '## Auth\n- Refresh tokens are coordinated by the auth context pipeline.',
        createdAt: '2026-07-02T08:00:00.000Z',
        updatedAt: '2026-07-04T10:11:12.000Z',
      }]],
    ]));
    mocks.filesRepo.findChunksByFileIds.mockResolvedValue(new Map([
      ['file-auth', [{
        id: 'chunk-auth-1',
        fact: 'Auth refresh tokens are coordinated from src/auth/context.ts.',
        category: 'auth',
        createdAt: '2026-07-01T12:34:56.000Z',
      }]],
    ]));

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: 'Update D:\\Source\\intelligent-context\\src\\auth\\context.ts to adjust auth refresh handling.' }],
      'gpt-4o-mini',
      'req-files-1'
    );

    expect(result.method).toBe('descriptor+bypass');
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['summary-global', 'summary-auth'])
    );
    expect(result.candidates.find((candidate) => candidate.id === 'summary-auth')).toEqual(
      expect.objectContaining({
        guaranteed: true,
        type: 'summary',
        updatedAt: '2026-07-04T10:11:12.000Z',
      })
    );
    expect(result.candidates.find((candidate) => candidate.id === 'summary-auth')?.fullContent).toContain(
      'Recency: last updated 2026-07-04 10:11:12 UTC; created 2026-07-02 08:00:00 UTC.'
    );
    expect(result.candidates.map((candidate) => candidate.id)).not.toContain('chunk-auth-1');
  });

  it('passes recency metadata to the selector model', async () => {
    mocks.getEffectiveContextConfig.mockReturnValue({
      maxCandidates: 10,
      tokenBudget: 5000,
      semanticDuplicateThreshold: 0.92,
      bypassSelectorItemThreshold: 0,
      bypassSelectorTokenThreshold: 0,
      reservedResponseTokens: 1000,
      contextOverheadTokens: 200,
      defaultModelMaxTokens: 16000,
    });
    mocks.getSystemModelConfig.mockReturnValue({ contextSelector: 'selector-model' });
    mocks.axiosPost.mockResolvedValue({ data: {} });
    mocks.resolveProviderAndModelForJob.mockResolvedValue({
      adapter: {
        buildRequest: vi.fn((request) => request),
        parseResponse: vi.fn(() => ({
          choices: [
            {
              message: {
                content: '{"summaryIds":["summary-auth"],"categoryIds":["auth"]}',
              },
            },
          ],
        })),
        headers: vi.fn(() => ({ Authorization: 'Bearer test' })),
        endpoint: vi.fn(() => 'https://example.test/chat/completions'),
      },
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'selector-model',
    });
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      {
        id: 'chunk-auth-1',
        fact: 'Auth refresh tokens are coordinated by the auth context pipeline.',
        category: 'auth',
        createdAt: '2026-07-05T12:00:00.000Z',
      },
      {
        id: 'chunk-auth-2',
        fact: 'The auth middleware renews tokens after refresh succeeds.',
        category: 'auth',
        createdAt: '2026-07-04T08:00:00.000Z',
      },
      {
        id: 'chunk-billing-1',
        fact: 'Billing retries happen in the invoice worker.',
        category: 'billing',
        createdAt: '2026-06-28T09:15:00.000Z',
      },
    ]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh flow and token renewal.',
        categoriesList: '["auth"]',
        content: '## Auth\n- The auth refresh flow renews tokens through the context middleware.',
        createdAt: '2026-07-02T09:30:00.000Z',
        updatedAt: '2026-07-06T15:45:00.000Z',
      },
    ]);

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: 'Trace the auth refresh flow and token renewal path.' }],
      'gpt-4o-mini',
      'req-llm-recency-1'
    );

    expect(result.method).toBe('descriptor+llm');

    const prompt = String(mocks.axiosPost.mock.calls[0]?.[1]?.messages?.[0]?.content ?? '');
    expect(mocks.axiosPost.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      stop: ['\n\n'],
    }));
    // Prompt must explicitly tell the model to skip reasoning/commentary.
    expect(prompt).toContain('Do NOT think');
    expect(prompt).toContain('Output ONLY the JSON object');
    expect(prompt).toContain('Use timestamp metadata as a freshness signal');
    expect(prompt).toContain('"newestChunkCreatedAt":"2026-07-05T12:00:00.000Z"');
    expect(prompt).toContain('"oldestChunkCreatedAt":"2026-07-04T08:00:00.000Z"');
    expect(prompt).toContain('"createdAt":"2026-07-02T09:30:00.000Z"');
    expect(prompt).toContain('"updatedAt":"2026-07-06T15:45:00.000Z"');
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['summary-auth', 'chunk-auth-1', 'chunk-auth-2'])
    );
    expect(result.candidates.map((candidate) => candidate.id)).not.toContain('chunk-billing-1');
  });

  it('selects summaries and unsummarized categories instead of a mixed chunk pool', async () => {
    mocks.getEffectiveContextConfig.mockReturnValue({
      maxCandidates: 10,
      tokenBudget: 5000,
      semanticDuplicateThreshold: 0.92,
      bypassSelectorItemThreshold: 0,
      bypassSelectorTokenThreshold: 0,
      reservedResponseTokens: 1000,
      contextOverheadTokens: 200,
      defaultModelMaxTokens: 16000,
    });
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      {
        id: 'chunk-auth-1',
        fact: 'Auth refresh tokens are coordinated by the auth context pipeline.',
        category: 'auth',
      },
      {
        id: 'chunk-auth-2',
        fact: 'The auth middleware renews tokens after refresh succeeds.',
        category: 'auth',
      },
      {
        id: 'chunk-billing-1',
        fact: 'Billing retries happen in the invoice worker.',
        category: 'billing',
      },
    ]);
    mocks.filesRepo.findByChunkIds.mockResolvedValue(new Map());
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-global',
        oneLineSummary: 'Project uses strict TypeScript and concise API handlers.',
        categoriesList: '["global"]',
        content: '## Global\n- Use strict TypeScript.\n- Keep API handlers concise.',
      },
      {
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh flow and token renewal.',
        categoriesList: '["auth"]',
        content: '## Auth\n- The auth refresh flow renews tokens through the context middleware.',
      },
      {
        id: 'summary-billing',
        oneLineSummary: 'Billing retries and invoice worker behavior.',
        categoriesList: '["billing"]',
        content: '## Billing\n- Invoice worker handles retry backoff.',
      },
    ]);

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: 'Trace the auth refresh flow and token renewal path.' }],
      'gpt-4o-mini',
      'req-auth-1'
    );

    expect(result.method).toBe('descriptor+heuristic');
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['summary-global', 'summary-auth', 'chunk-auth-1', 'chunk-auth-2'])
    );
    expect(result.candidates.map((candidate) => candidate.id)).not.toContain('summary-billing');
    expect(result.candidates.map((candidate) => candidate.id)).not.toContain('chunk-billing-1');
  });

  it('includes open gap findings when the query overlaps the missing area', async () => {
    mocks.findingsRepo.findOpenGapsByProject.mockResolvedValue([
      {
        id: 'gap-1',
        title: 'Auth coverage missing',
        description: 'Need more information about the authentication flow and token refresh handling.',
        status: 'open',
      },
    ]);
    mocks.findingsRepo.countOpenGapsByProject.mockResolvedValue(1);

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: 'Trace the auth token refresh path' }],
      'gpt-4o-mini',
      'req-1'
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      id: 'gap-1',
      type: 'finding',
      category: 'gap',
    }));
  });

  it('extracts the user request from <userRequest> wrappers in long IDE messages', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh flow and token renewal.',
        categoriesList: '["auth"]',
        content: '## Auth\n- Auth refresh handled by middleware.',
      },
    ]);

    // Simulate a long IDE message where the actual request is wrapped in
    // <userRequest> at the very end — the old slice(0,2000) would cut it off.
    const longMessage = [
      '<environment_info>OS: Windows</environment_info>',
      '<workspace_info>',
      'Folders: d:\\Source\\my-project',
      '</workspace_info>',
      '<attachments>',
      '<attachment id="file.ts">',
      '...lots of file content padding out the message...',
      '</attachment>',
      '</attachments>',
      '<reminderInstructions>Use the replace_string_in_file tool.</reminderInstructions>',
      '<userRequest>',
      'Explain the token refresh flow in the auth module.',
      '</userRequest>',
    ].join('\n');

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: longMessage }],
      'gpt-4o-mini',
      'req-wrapper-1'
    );

    // The summary about auth should be selected because the extracted
    // query is "Explain the token refresh flow in the auth module."
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['summary-auth'])
    );
  });

  it('falls back to the tail of the last user message when no known wrapper matches', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh flow and token renewal.',
        categoriesList: '["auth"]',
        content: '## Auth\n- Auth refresh handled by middleware.',
      },
    ]);
    mocks.findingsRepo.findOpenGapsByProject.mockResolvedValue([]);

    // Long message with no known wrapper — the last 3000 chars contain the
    // relevant keywords at the end.
    const preamble = 'A'.repeat(5_000); // push the real content to the tail
    const realRequest = 'Please trace the auth token refresh path.';

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: preamble + '\n' + realRequest }],
      'gpt-4o-mini',
      'req-tail-1'
    );

    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(['summary-auth'])
    );
  });

  it('omits unrelated gap findings from the candidate pool', async () => {
    mocks.findingsRepo.findOpenGapsByProject.mockResolvedValue([
      {
        id: 'gap-2',
        title: 'Billing docs missing',
        description: 'Need more information about invoice retry rules.',
        status: 'open',
      },
    ]);
    mocks.findingsRepo.countOpenGapsByProject.mockResolvedValue(1);

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: 'Explain the websocket reconnect loop' }],
      'gpt-4o-mini',
      'req-2'
    );

    expect(result.candidates).toEqual([]);
  });

  it('extracts <userRequest> content correctly when the tag name appears inside the request text', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-tags',
        oneLineSummary: 'XML tag usage and wrapping conventions for IDE messages.',
        categoriesList: '["xml"]',
        content: '## XML\n- Use <userRequest> to wrap user queries.',
        createdAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-07-01T08:00:00.000Z',
      },
    ]);

    // The user's request contains a literal "</userRequest>" string which
    // would fool the simple lazy regex into stopping early. The depth-
    // counting fallback should correctly extract the full content.
    const longMessage = [
      '<environment_info>OS: Windows</environment_info>',
      '<workspace_info>Folders: d:\\Source\\my-project</workspace_info>',
      '<userRequest>',
      'How do I use the <userRequest> wrapper? When should I close it with </userRequest> in IDE messages?',
      '</userRequest>',
    ].join('\n');

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: longMessage }],
      'gpt-4o-mini',
      'req-depth-1'
    );

    // The XML summary should be selected because depth counting
    // extracted the full query mentioning "userRequest wrapper"
    expect(result.candidates.map((c) => c.id)).toEqual(
      expect.arrayContaining(['summary-tags'])
    );
  });

  it('strips boilerplate blocks before fallback tail extraction when no wrapper tag matches', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh flow and token renewal.',
        categoriesList: '["auth"]',
        content: '## Auth\n- Auth refresh handled by middleware.',
        createdAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-07-01T08:00:00.000Z',
      },
    ]);
    mocks.findingsRepo.findOpenGapsByProject.mockResolvedValue([]);

    // User query at the TOP, followed by a massive attachment block.
    // The old blind tail-slice would land on the X-padding inside the
    // attachment, missing the real query entirely. Boilerplate stripping
    // removes the attachment blocks so the tail lands on the query.
    const preamble = 'Refresh the auth token flow';
    const boilerplate = [
      '<attachments>',
      '<attachment id="big-file.ts">',
      'X'.repeat(5_000),
      '</attachment>',
      '</attachments>',
      '<reminderInstructions>Use the replace_string_in_file tool.</reminderInstructions>',
    ].join('\n');
    const longMessage = preamble + '\n' + boilerplate;

    const result = await selectContext(
      'project-1',
      [{ role: 'user', content: longMessage }],
      'gpt-4o-mini',
      'req-strip-1'
    );

    // The auth summary should be selected because boilerplate stripping
    // left "Refresh the auth token flow" as the extracted query text.
    expect(result.candidates.map((c) => c.id)).toEqual(
      expect.arrayContaining(['summary-auth'])
    );
  });
});