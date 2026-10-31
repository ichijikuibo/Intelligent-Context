import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  chunksRepo: {
    findUnsummarized: vi.fn(),
    updateCategoryForIds: vi.fn(),
  },
  summariesRepo: {
    findByProject: vi.fn(),
  },
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

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import { runCategoryDeduper, parseCategoryMerges } from '../../src/workers/categoryDeduper';

function makeProvider(content: unknown) {
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
            message: { role: 'assistant' as const, content },
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

function makeChunk(id: string, category: string, fact = `Fact ${id}`) {
  return {
    id,
    projectId: 'project-1',
    sessionId: null,
    requestId: null,
    fact,
    category,
    confidence: 0.8,
    source: 'extraction',
    hash: `hash-${id}`,
    tokensUsed: 10,
    summarized: false,
    createdAt: '2026-06-21T17:00:00.000Z',
  };
}

const MERGE_JSON =
  '[{"main-category":"complex-care-pathways","other-categories":["ccp","nhs-ccp"]}]';

describe('parseCategoryMerges', () => {
  it('parses a bare JSON array and normalises slugs', () => {
    const merges = parseCategoryMerges(MERGE_JSON);
    expect(merges).toEqual([
      { mainCategory: 'complex-care-pathways', otherCategories: ['ccp', 'nhs-ccp'] },
    ]);
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const merges = parseCategoryMerges(`Here you go:\n\`\`\`json\n${MERGE_JSON}\n\`\`\``);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.mainCategory).toBe('complex-care-pathways');
  });

  it('drops entries that try to merge the global category or self-merge', () => {
    const merges = parseCategoryMerges(
      '[{"main-category":"global","other-categories":["ccp"]},' +
        '{"main-category":"ccp","other-categories":["ccp",""]}]'
    );
    expect(merges).toEqual([]);
  });

  it('returns an empty list for malformed output', () => {
    expect(parseCategoryMerges('no json here')).toEqual([]);
  });
});

describe('runCategoryDeduper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summariesRepo.findByProject.mockResolvedValue([]);
    mocks.chunksRepo.updateCategoryForIds.mockResolvedValue(undefined);
    mocks.axiosPost.mockResolvedValue({ data: {} });
  });

  it('reassigns merged chunk categories to the main category', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'ccp'),
      makeChunk('2', 'ccp'),
      makeChunk('3', 'nhs-ccp'),
      makeChunk('4', 'unrelated'),
    ]);

    const reassigned = await runCategoryDeduper({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(MERGE_JSON),
      trigger: 'manual',
    });

    expect(reassigned).toBe(3);
    expect(mocks.chunksRepo.updateCategoryForIds).toHaveBeenCalledWith(
      ['1', '2', '3'],
      'complex-care-pathways'
    );
    // The unrelated category must not be rewritten.
    expect(mocks.chunksRepo.updateCategoryForIds).toHaveBeenCalledTimes(1);
  });

  it('prefers an existing summary category as the main category', async () => {
    mocks.summariesRepo.findByProject.mockResolvedValue([
      {
        id: 'summary-1',
        projectId: 'project-1',
        title: 'Complex care pathways',
        content: 'body',
        oneLineSummary: 'Care pathways for patients with complex needs',
        categoriesList: JSON.stringify(['complex-care-pathways']),
        sourceChunkIds: '[]',
        toc: '[]',
        version: 1,
        createdAt: '2026-06-21T17:00:00.000Z',
        updatedAt: '2026-06-21T17:00:00.000Z',
      },
    ]);
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'ccp'),
      makeChunk('2', 'nhs-ccp'),
    ]);

    await runCategoryDeduper({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(MERGE_JSON),
      trigger: 'manual',
    });

    const prompt = mocks.axiosPost.mock.calls[0]?.[1]?.messages?.[0]?.content as string;
    expect(prompt).toContain('complex-care-pathways');
    expect(prompt).toContain('ccp');
    expect(mocks.chunksRepo.updateCategoryForIds).toHaveBeenCalledWith(
      ['1', '2'],
      'complex-care-pathways'
    );
  });

  it('resolves chained merges to a single terminal category', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'ccp'),
      makeChunk('2', 'nhs-ccp'),
    ]);

    const reassigned = await runCategoryDeduper({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(
        '[{"main-category":"nhs-ccp","other-categories":["ccp"]},' +
          '{"main-category":"complex-care-pathways","other-categories":["nhs-ccp"]}]'
      ),
      trigger: 'manual',
    });

    expect(reassigned).toBe(2);
    expect(mocks.chunksRepo.updateCategoryForIds).toHaveBeenCalledWith(
      ['1', '2'],
      'complex-care-pathways'
    );
  });

  it('does nothing when every chunk already shares one category', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'ccp'),
      makeChunk('2', 'ccp'),
    ]);

    const reassigned = await runCategoryDeduper({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(MERGE_JSON),
      trigger: 'manual',
    });

    expect(reassigned).toBe(0);
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('never merges chunk categories that only exist on the global category', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([makeChunk('1', 'global')]);

    const reassigned = await runCategoryDeduper({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(MERGE_JSON),
      trigger: 'manual',
    });

    expect(reassigned).toBe(0);
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('swallows model failures and leaves chunk categories untouched', async () => {
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      makeChunk('1', 'ccp'),
      makeChunk('2', 'nhs-ccp'),
    ]);
    mocks.axiosPost.mockRejectedValue(new Error('upstream 500'));

    const reassigned = await runCategoryDeduper({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: makeProvider(MERGE_JSON),
      trigger: 'manual',
    });

    expect(reassigned).toBe(0);
    expect(mocks.chunksRepo.updateCategoryForIds).not.toHaveBeenCalled();
  });
});
