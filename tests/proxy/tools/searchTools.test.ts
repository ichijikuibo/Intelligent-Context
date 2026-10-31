import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chunksRepo: {
    findUnsummarized: vi.fn(),
    findAllForEmbedding: vi.fn(),
  },
  summariesRepo: {
    findByProject: vi.fn(),
  },
  projectsRepo: {
    findById: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  stats: {
    recordStat: vi.fn(),
    generateRunId: vi.fn(() => 'run-1'),
  },
  resolveProviderAndModelForJob: vi.fn(),
  selectContext: vi.fn(),
  getSystemModelConfig: vi.fn(),
}));

vi.mock('../../../src/db/repositories/chunks', () => ({ chunksRepo: mocks.chunksRepo }));
vi.mock('../../../src/db/repositories/summaries', () => ({ summariesRepo: mocks.summariesRepo }));
vi.mock('../../../src/db/repositories/projects', () => ({ projectsRepo: mocks.projectsRepo }));
vi.mock('../../../src/db/repositories/files', () => ({ filesRepo: {} }));
vi.mock('../../../src/db/repositories/codeExtracts', () => ({ codeExtractsRepo: {} }));
vi.mock('../../../src/db/repositories/categories', () => ({ categoriesRepo: {} }));
vi.mock('../../../src/db/repositories/findings', () => ({
  findingsRepo: {},
}));
vi.mock('../../../src/findings/actionFinding', () => ({ implementFinding: vi.fn() }));
vi.mock('../../../src/config/configOverrides', () => ({
  getEffectiveContextConfig: vi.fn(() => ({ maxRecordLearnings: 200 })),
}));
vi.mock('../../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));
vi.mock('../../../src/utils/logger', () => ({ logger: mocks.logger }));
vi.mock('../../../src/utils/stats', () => ({
  recordStat: mocks.stats.recordStat,
  generateRunId: mocks.stats.generateRunId,
}));

// Dynamic imports used inside selectContextForPhrase.
vi.mock('../../../src/proxy/upstream', () => ({
  resolveProviderAndModelForJob: mocks.resolveProviderAndModelForJob,
}));
vi.mock('../../../src/context/selector', () => ({
  selectContext: mocks.selectContext,
}));
vi.mock('../../../src/context/assembler', () => ({
  assembleContextMessage: vi.fn(() => '## Project Context\n- something'),
}));

import { executeLearningTool } from '../../../src/proxy/tools/executor';

function chunk(id: string, category: string, fact: string, summarized = false) {
  return {
    id,
    projectId: 'project-1',
    fact,
    category,
    confidence: 0.8,
    source: 'extraction',
    hash: `h-${id}`,
    summarized,
    createdAt: '2026-06-21T17:00:00.000Z',
  };
}

function summary(id: string, categories: string[], oneLine: string, title = 'Title', content = 'BODY') {
  return {
    id,
    projectId: 'project-1',
    title,
    content,
    oneLineSummary: oneLine,
    categoriesList: JSON.stringify(categories),
    sourceChunkIds: '[]',
    version: 1,
    createdAt: '2026-06-21T17:00:00.000Z',
    updatedAt: '2026-06-21T17:00:00.000Z',
  };
}

describe('ic_list_categories tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      chunk('1', 'ccp', 'Complex care pathway step one'),
      chunk('2', 'ccp', 'Complex care pathway step two'),
      chunk('3', 'nhs-ccp', 'NHS CCP claim form reference'),
      chunk('4', 'global', 'Dates use ISO format'),
    ]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      summary('s1', ['complex-care-pathways', 'nhs-ccp'], 'How complex care pathways work'),
      summary('s2', ['global'], 'Project-wide conventions'),
    ]);
  });

  it('lists distinct categories with chunk and summary counts', async () => {
    const result = await executeLearningTool('ic_list_categories', {}, { projectId: 'project-1' });
    expect(result.success).toBe(true);

    const payload = result.result as { total: number; categories: Array<{ category: string; unsummarizedChunkCount: number; summaryCount: number }> };
    const bySlug = Object.fromEntries(payload.categories.map((c) => [c.category, c]));
    expect(bySlug['ccp']).toEqual({ category: 'ccp', unsummarizedChunkCount: 2, summaryCount: 0 });
    expect(bySlug['complex-care-pathways']).toEqual({ category: 'complex-care-pathways', unsummarizedChunkCount: 0, summaryCount: 1 });
    expect(bySlug['global']).toEqual({ category: 'global', unsummarizedChunkCount: 1, summaryCount: 1 });
  });

  it('returns id + summary-only matches for a requested category', async () => {
    const result = await executeLearningTool('ic_list_categories', { category: 'ccp' }, { projectId: 'project-1' });
    const payload = result.result as {
      category: {
        unsummarizedChunkTotal: number;
        unsummarizedChunks: Array<{ id: string; snippet: string }>;
        summaryTotal: number;
      };
    };

    expect(payload.category.unsummarizedChunkTotal).toBe(2);
    expect(payload.category.unsummarizedChunks.map((c) => c.id)).toEqual(['1', '2']);
    expect(payload.category.unsummarizedChunks[0]).toHaveProperty('snippet');
  });

  it('matches a summary by one of its category tags', async () => {
    const result = await executeLearningTool('ic_list_categories', { category: 'complex-care-pathways' }, { projectId: 'project-1' });
    const payload = result.result as { category: { summaryTotal: number; summaries: Array<{ id: string }> } };
    expect(payload.category.summaryTotal).toBe(1);
    expect(payload.category.summaries[0]?.id).toBe('s1');
  });
});

describe('ic_search tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chunksRepo.findAllForEmbedding.mockResolvedValue([
      chunk('1', 'ccp', 'The CCP pathway uses a claim form', true),
      chunk('2', 'auth', 'Tokens are signed with HS256', false),
    ]);
    mocks.summariesRepo.findByProject.mockResolvedValue([
      summary('s1', ['ccp'], 'CCP claim form handling'),
      summary('s2', ['auth'], 'Auth internals', 'Auth internals', 'This body mentions the word claim but must not match'),
    ]);
  });

  it('matches chunk facts and summary headings only', async () => {
    const result = await executeLearningTool('ic_search', { query: 'claim' }, { projectId: 'project-1' });
    const payload = result.result as {
      chunkTotal: number;
      summaryTotal: number;
      chunks: Array<{ id: string; summarized: boolean }>;
      summaries: Array<{ id: string }>;
    };

    expect(payload.chunkTotal).toBe(1);
    expect(payload.chunks[0]).toMatchObject({ id: '1', summarized: true });
    // s2's body contains "claim" but its title/one-line do not → excluded.
    expect(payload.summaryTotal).toBe(1);
    expect(payload.summaries[0]?.id).toBe('s1');
  });

  it('supports regular-expression queries', async () => {
    const result = await executeLearningTool('ic_search', { query: 'HS\\d+', regex: true }, { projectId: 'project-1' });
    const payload = result.result as { chunkTotal: number; chunks: Array<{ id: string }> };
    expect(payload.chunkTotal).toBe(1);
    expect(payload.chunks[0]?.id).toBe('2');
  });

  it('reports invalid regex as an error result', async () => {
    const result = await executeLearningTool('ic_search', { query: '(', regex: true }, { projectId: 'project-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid regex');
  });

  it('honours the scope filter', async () => {
    const result = await executeLearningTool('ic_search', { query: 'ccp', scope: ['summaries'] }, { projectId: 'project-1' });
    const payload = result.result as { chunkTotal: number; summaryTotal: number };
    expect(payload.chunkTotal).toBe(0);
    expect(payload.summaryTotal).toBe(1);
  });
});

describe('ic_select_context tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectsRepo.findById.mockResolvedValue({ id: 'project-1', name: 'Demo' });
    mocks.getSystemModelConfig.mockReturnValue({ icTools: 'ic-model' });
    mocks.resolveProviderAndModelForJob.mockResolvedValue({
      adapter: {},
      baseUrl: 'https://example.test',
      apiKey: 'k',
      providerName: 'p',
      providerType: 'openai',
      model: 'ic-model',
    });
    mocks.selectContext.mockResolvedValue({
      method: 'descriptor+llm',
      latencyMs: 12,
      candidates: [
        { id: 's1', type: 'summary', category: 'ccp', oneLineSummary: 'CCP', content: 'x', fullContent: 'full', categories: ['ccp'], similarity: 0.9 },
      ],
    });
  });

  it('always forces the selector and uses the dedicated ic model', async () => {
    const result = await executeLearningTool('ic_select_context', { text: 'how does the claim form work' }, { projectId: 'project-1' });
    expect(result.success).toBe(true);

    expect(mocks.selectContext).toHaveBeenCalledWith(
      'project-1',
      [{ role: 'user', content: 'how does the claim form work' }],
      'ic-model',
      expect.stringContaining('ic-select-context-'),
      undefined,
      undefined,
      expect.objectContaining({ forceSelector: true, providerOverride: expect.objectContaining({ model: 'ic-model' }) }),
    );

    const payload = result.result as { candidateCount: number; candidates: Array<{ id: string }>; contextBlock?: string };
    expect(payload.candidateCount).toBe(1);
    expect(payload.candidates[0]?.id).toBe('s1');
    // includeBlocks defaults to false.
    expect(payload.contextBlock).toBeUndefined();
  });

  it('includes the assembled context block when requested', async () => {
    const result = await executeLearningTool('ic_select_context', { text: 'x', includeBlocks: true }, { projectId: 'project-1' });
    const payload = result.result as { contextBlock?: string };
    expect(payload.contextBlock).toContain('Project Context');
  });

  it('uses an explicit model override when provided', async () => {
    await executeLearningTool('ic_select_context', { text: 'x', model: 'custom-model' }, { projectId: 'project-1' });
    expect(mocks.resolveProviderAndModelForJob).toHaveBeenCalledWith('custom-model', 'openai');
  });

  it('requires text', async () => {
    const result = await executeLearningTool('ic_select_context', {}, { projectId: 'project-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('text is required');
  });
});
