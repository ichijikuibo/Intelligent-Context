import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chunksRepo: {
    findUnsummarized: vi.fn(),
    updateCategory: vi.fn(),
  },
  categoriesRepo: {
    findByProject: vi.fn(),
    assignToChunk: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('../../src/db/repositories/chunks', () => ({
  chunksRepo: mocks.chunksRepo,
}));

vi.mock('../../src/db/repositories/categories', () => ({
  categoriesRepo: mocks.categoriesRepo,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import { runCategorizer } from '../../src/workers/categorizer';

describe('runCategorizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chunksRepo.findUnsummarized.mockResolvedValue([
      {
        id: 'chunk-1',
        category: 'general',
        fact: 'The user prefers concise output in responses.',
      },
    ]);
    mocks.categoriesRepo.findByProject.mockResolvedValue([
      { id: 'cat-user-pref', slug: 'user-preferences' },
    ]);
    mocks.chunksRepo.updateCategory.mockResolvedValue(undefined);
    mocks.categoriesRepo.assignToChunk.mockResolvedValue(undefined);
  });

  it('persists inferred categories onto unsummarized chunks before linking them', async () => {
    await runCategorizer('project-1');

    expect(mocks.chunksRepo.findUnsummarized).toHaveBeenCalledWith('project-1');
    expect(mocks.chunksRepo.updateCategory).toHaveBeenCalledWith('chunk-1', 'user-preference');
    expect(mocks.categoriesRepo.assignToChunk).toHaveBeenCalledWith('chunk-1', 'cat-user-pref');
  });
});