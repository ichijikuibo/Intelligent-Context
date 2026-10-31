import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  summariesRepo: {
    findById: vi.fn(),
  },
  findingsRepo: {
    findById: vi.fn(),
  },
  filesRepo: {
    findByIdForProject: vi.fn(),
    findChunksByFileId: vi.fn(),
    findSummariesByFileId: vi.fn(),
  },
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/db/repositories/summaries', () => ({ summariesRepo: mocks.summariesRepo }));
vi.mock('../../src/db/repositories/findings', () => ({ findingsRepo: mocks.findingsRepo }));
vi.mock('../../src/db/repositories/files', () => ({ filesRepo: mocks.filesRepo }));
vi.mock('../../src/utils/logger', () => ({ logger: mocks.logger }));

import { resolveKnowledgeReferences } from '../../src/chat/knowledgeContext';

describe('knowledgeContext.resolveKnowledgeReferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an attached summary with its categories and source chunks', async () => {
    mocks.summariesRepo.findById.mockResolvedValue({
      id: 'sum-1',
      projectId: 'project-1',
      title: 'Auth summary',
      content: 'Auth uses signed tokens.',
      oneLineSummary: 'Tokens',
      categoriesList: '["auth","security"]',
      sourceChunkIds: '["chunk-1","chunk-2"]',
      updatedAt: '2026-01-01',
    });

    const blocks = await resolveKnowledgeReferences('project-1', [{ type: 'summary', id: 'sum-1' }]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Attached summary: Auth summary (sum-1)');
    expect(blocks[0]).toContain('Categories: auth, security');
    expect(blocks[0]).toContain('Auth uses signed tokens.');
  });

  it('renders an attached finding with its actions and related ids', async () => {
    mocks.findingsRepo.findById.mockResolvedValue({
      id: 'find-1',
      projectId: 'project-1',
      title: 'Duplicate summaries',
      type: 'refactor',
      severity: 'medium',
      status: 'open',
      description: 'Two summaries overlap.',
      actions: [{ action: 'delete', targetType: 'summary', targetId: 'sum-2' }],
      relatedIds: { chunkIds: [], summaryIds: ['sum-1', 'sum-2'], findingIds: [] },
    });

    const blocks = await resolveKnowledgeReferences('project-1', [{ type: 'finding', id: 'find-1' }]);

    expect(blocks[0]).toContain('Attached finding: Duplicate summaries (find-1)');
    expect(blocks[0]).toContain('delete summary sum-2');
    expect(blocks[0]).toContain('summaries [sum-1, sum-2]');
  });

  it('renders a file with its linked chunks and summaries', async () => {
    mocks.filesRepo.findByIdForProject.mockResolvedValue({
      id: 'file-1',
      fileName: 'src/auth/context.ts',
      purpose: 'Auth context builder',
    });
    mocks.filesRepo.findChunksByFileId.mockResolvedValue([
      { id: 'chunk-1', fact: 'Auth uses tokens', category: 'auth', confidence: 0.9 },
    ]);
    mocks.filesRepo.findSummariesByFileId.mockResolvedValue([
      { id: 'sum-1', title: 'Auth summary', oneLineSummary: 'Tokens' },
    ]);

    const blocks = await resolveKnowledgeReferences('project-1', [{ type: 'file', id: 'file-1' }]);

    expect(blocks[0]).toContain('Attached file: src/auth/context.ts (file-1)');
    expect(blocks[0]).toContain('chunk-1 [auth, 90%] Auth uses tokens');
    expect(blocks[0]).toContain('sum-1 Auth summary: Tokens');
  });

  it('drops references to entities in another project', async () => {
    mocks.summariesRepo.findById.mockResolvedValue({ id: 'sum-1', projectId: 'other-project', title: 'x', content: '', categoriesList: '[]', sourceChunkIds: '[]' });

    const blocks = await resolveKnowledgeReferences('project-1', [{ type: 'summary', id: 'sum-1' }]);

    expect(blocks).toEqual([]);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('drops references to missing entities without throwing', async () => {
    mocks.filesRepo.findByIdForProject.mockResolvedValue(undefined);

    const blocks = await resolveKnowledgeReferences('project-1', [{ type: 'file', id: 'missing' }]);

    expect(blocks).toEqual([]);
  });
});
