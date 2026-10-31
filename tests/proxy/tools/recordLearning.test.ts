import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chunksRepo: {
    findByHash: vi.fn(),
    insert: vi.fn(),
    findById: vi.fn(),
    updateCategory: vi.fn(),
    updateConfidence: vi.fn(),
  },
  filesRepo: {
    insertMany: vi.fn().mockResolvedValue(undefined),
  },
  codeExtractsRepo: {
    insertMany: vi.fn().mockResolvedValue(undefined),
  },
  categoriesRepo: {
    findCategoryBySlug: vi.fn(),
    assignToChunk: vi.fn().mockResolvedValue(undefined),
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
  getEffectiveContextConfig: vi.fn(),
}));

vi.mock('../../../src/config/configOverrides', () => ({
  getEffectiveContextConfig: mocks.getEffectiveContextConfig,
}));

vi.mock('../../../src/db/repositories/chunks', () => ({
  chunksRepo: mocks.chunksRepo,
}));

vi.mock('../../../src/db/repositories/files', () => ({
  filesRepo: mocks.filesRepo,
}));

vi.mock('../../../src/db/repositories/codeExtracts', () => ({
  codeExtractsRepo: mocks.codeExtractsRepo,
}));

vi.mock('../../../src/db/repositories/categories', () => ({
  categoriesRepo: mocks.categoriesRepo,
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../../src/utils/stats', () => ({
  recordStat: mocks.stats.recordStat,
  generateRunId: mocks.stats.generateRunId,
}));

import { executeLearningTool } from '../../../src/proxy/tools/executor';
import { hashFact } from '../../../src/utils/hashing';

describe('record_learning tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveContextConfig.mockReturnValue({ maxRecordLearnings: 200 });
    mocks.chunksRepo.findByHash.mockResolvedValue(undefined);
    mocks.chunksRepo.insert.mockImplementation(async (data) => ({
      id: `chunk-${Math.random()}`,
      projectId: data.projectId,
      fact: data.fact,
      category: data.category,
      confidence: data.confidence,
      source: data.source,
      hash: data.hash,
      createdAt: new Date().toISOString(),
    }));
    mocks.chunksRepo.findById.mockImplementation(async (id) => ({
      id,
      projectId: 'project-1',
      fact: 'stored fact',
      category: 'general',
      confidence: 0.9,
    }));
    mocks.categoriesRepo.findCategoryBySlug.mockResolvedValue(null);
  });

  it('creates a new chunk for a new fact', async () => {
    const result = await executeLearningTool('record_learning', {
      learnings: [
        { fact: 'Uses Express 4 for the proxy server.', category: 'dependencies', confidence: 0.95, isNew: true },
      ],
    }, { projectId: 'project-1', sessionId: 'sess-1', requestId: 'req-1' });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ requested: 1, created: 1, updated: 0, skipped: 0 });
    expect(mocks.chunksRepo.insert).toHaveBeenCalledTimes(1);
    expect(mocks.chunksRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        fact: 'Uses Express 4 for the proxy server.',
        category: 'dependencies',
        confidence: 0.95,
        source: 'tool',
        hash: hashFact('Uses Express 4 for the proxy server.'),
      })
    );

    expect(mocks.stats.recordStat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'sess-1',
        requestId: 'req-1',
        type: 'ic_record_learning',
        direction: 'output',
        meta: expect.objectContaining({ tool: 'record_learning', action: 'record_learning', success: true }),
      })
    );
  });

  it('records one always-recorded stat per consolidated ic op', async () => {
    await executeLearningTool('ic', {
      ops: [
        { action: 'list', type: 'chunk' },
        { action: 'record', data: { learnings: [{ fact: 'Another fact.', category: 'general', confidence: 0.9, isNew: true }] } },
        { action: 'create', type: 'chunk', data: { fact: 'Created via ic.', category: 'general', confidence: 0.9 } },
      ],
    }, { projectId: 'project-1', sessionId: 'sess-1', requestId: 'req-1' });

    const recordedTypes = mocks.stats.recordStat.mock.calls.map((call) => call[0].type);
    expect(recordedTypes).toEqual(['ic_retrieval', 'ic_record_learning', 'ic_write']);
    expect(mocks.stats.recordStat).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ic_retrieval',
        meta: expect.objectContaining({ tool: 'ic', action: 'list', dataType: 'chunk' }),
      })
    );
    expect(mocks.stats.recordStat).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ic_write',
        meta: expect.objectContaining({ tool: 'ic', action: 'create', dataType: 'chunk' }),
      })
    );
  });

  it('skips a fact with confidence below 0.1', async () => {
    const result = await executeLearningTool('record_learning', {
      learnings: [
        { fact: 'Speculative observation.', category: 'general', confidence: 0.05, isNew: true },
      ],
    }, { projectId: 'project-1' });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ requested: 1, created: 0, skipped: 1 });
    expect(mocks.chunksRepo.insert).not.toHaveBeenCalled();
  });

  it('updates an existing chunk when a duplicate fact is reported as new with higher confidence', async () => {
    mocks.chunksRepo.findByHash.mockResolvedValue({
      id: 'existing-1',
      projectId: 'project-1',
      fact: 'Auth uses signed session tokens.',
      category: 'auth',
      confidence: 0.7,
    });

    const result = await executeLearningTool('record_learning', {
      learnings: [
        { fact: 'Auth uses signed session tokens.', category: 'auth', confidence: 0.9, isNew: true },
      ],
    }, { projectId: 'project-1' });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ requested: 1, created: 0, updated: 1, skipped: 0 });
    expect(mocks.chunksRepo.updateConfidence).toHaveBeenCalledWith('existing-1', 0.9);
    expect(mocks.chunksRepo.insert).not.toHaveBeenCalled();
  });

  it('skips a duplicate fact when the new confidence is not higher', async () => {
    mocks.chunksRepo.findByHash.mockResolvedValue({
      id: 'existing-1',
      projectId: 'project-1',
      fact: 'Auth uses signed session tokens.',
      category: 'auth',
      confidence: 0.9,
    });

    const result = await executeLearningTool('record_learning', {
      learnings: [
        { fact: 'Auth uses signed session tokens.', category: 'auth', confidence: 0.5, isNew: true },
      ],
    }, { projectId: 'project-1' });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ requested: 1, skipped: 1 });
    expect(mocks.chunksRepo.updateConfidence).not.toHaveBeenCalled();
  });

  it('stores filesUsed and codeExtracts along with the chunk', async () => {
    await executeLearningTool('record_learning', {
      learnings: [
        {
          fact: 'Selector uses an LLM reranker.',
          category: 'context',
          confidence: 0.85,
          isNew: true,
          filesUsed: [{ name: 'src/context/selector.ts', purpose: 'reranks candidates' }],
          codeExtracts: [{ fileName: 'src/context/selector.ts', symbols: ['selectDescriptorsWithLLM'] }],
        },
      ],
    }, { projectId: 'project-1' });

    expect(mocks.filesRepo.insertMany).toHaveBeenCalledWith([
      { chunkId: expect.any(String), fileName: 'src/context/selector.ts', purpose: 'reranks candidates' },
    ]);
    expect(mocks.codeExtractsRepo.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        fileName: 'src/context/selector.ts',
        symbols: ['selectDescriptorsWithLLM'],
      }),
    ]);
  });

  it('links the chunk to its category tree when a matching category exists', async () => {
    mocks.categoriesRepo.findCategoryBySlug.mockResolvedValue({ id: 'cat-1' });

    await executeLearningTool('record_learning', {
      learnings: [
        { fact: 'Worker pool is per-project.', category: 'scheduler', confidence: 0.9, isNew: true },
      ],
    }, { projectId: 'project-1' });

    expect(mocks.categoriesRepo.assignToChunk).toHaveBeenCalledWith(
      expect.any(String),
      'cat-1',
      0.9,
    );
  });

  it('rejects an empty learnings array', async () => {
    const result = await executeLearningTool('record_learning', {
      learnings: [],
    }, { projectId: 'project-1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-empty array/);
  });

  it('rejects an entry missing category', async () => {
    const result = await executeLearningTool('record_learning', {
      learnings: [{ fact: 'No category.', confidence: 0.5 }],
    }, { projectId: 'project-1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/category/);
  });

  it('processes batches larger than the configured cap up to the cap and reports the remainder', async () => {
    mocks.getEffectiveContextConfig.mockReturnValue({ maxRecordLearnings: 2 });

    const result = await executeLearningTool('record_learning', {
      learnings: [
        { fact: 'Fact one.', category: 'general', confidence: 0.9, isNew: true },
        { fact: 'Fact two.', category: 'general', confidence: 0.9, isNew: true },
        { fact: 'Fact three.', category: 'general', confidence: 0.9, isNew: true },
      ],
    }, { projectId: 'project-1' });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      requested: 3,
      created: 2,
      truncated: true,
      processed: 2,
      dropped: 1,
    });
    expect((result.result as { hint?: string }).hint).toMatch(/remaining 1 learning/);
    expect(mocks.chunksRepo.insert).toHaveBeenCalledTimes(2);
    expect(mocks.chunksRepo.insert).not.toHaveBeenCalledWith(
      expect.objectContaining({ fact: 'Fact three.' })
    );
  });
});
