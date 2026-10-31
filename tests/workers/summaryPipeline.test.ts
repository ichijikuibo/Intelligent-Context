import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runCategorizer: vi.fn(),
  runCategoryDeduper: vi.fn(),
  runSummarizer: vi.fn(),
}));

vi.mock('../../src/workers/categorizer', () => ({
  runCategorizer: mocks.runCategorizer,
}));

vi.mock('../../src/workers/categoryDeduper', () => ({
  runCategoryDeduper: mocks.runCategoryDeduper,
}));

vi.mock('../../src/workers/summarizer', () => ({
  runSummarizer: mocks.runSummarizer,
}));

import { runCategorizedSummarizer } from '../../src/workers/summaryPipeline';

describe('runCategorizedSummarizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runCategoryDeduper.mockResolvedValue(0);
  });

  it('awaits categorization before summarization', async () => {
    let resolveCategorizer: (() => void) | undefined;
    mocks.runCategorizer.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveCategorizer = resolve;
      })
    );
    mocks.runSummarizer.mockResolvedValue(undefined);

    const provider = { providerName: 'OpenAI' };
    const runPromise = runCategorizedSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: provider as any,
      trigger: 'manual',
    });

    await Promise.resolve();
    expect(mocks.runSummarizer).not.toHaveBeenCalled();

    resolveCategorizer?.();
    await runPromise;

    expect(mocks.runCategoryDeduper).toHaveBeenCalledWith({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider,
      trigger: 'manual',
    });
    expect(mocks.runSummarizer).toHaveBeenCalledWith({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider,
      trigger: 'manual',
    });
  });

  it('does not summarize when categorization fails', async () => {
    mocks.runCategorizer.mockRejectedValue(new Error('categorizer failed'));

    await expect(runCategorizedSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: { providerName: 'OpenAI' } as any,
      trigger: 'scheduled',
    })).rejects.toThrow('categorizer failed');

    expect(mocks.runCategoryDeduper).not.toHaveBeenCalled();
    expect(mocks.runSummarizer).not.toHaveBeenCalled();
  });

  it('continues to summarization when the deduper fails', async () => {
    mocks.runCategorizer.mockResolvedValue(undefined);
    mocks.runCategoryDeduper.mockRejectedValue(new Error('deduper boom'));
    mocks.runSummarizer.mockResolvedValue(undefined);

    await runCategorizedSummarizer({
      projectId: 'project-1',
      model: 'gpt-4.1-mini',
      provider: { providerName: 'OpenAI' } as any,
      trigger: 'manual',
    });

    expect(mocks.runSummarizer).toHaveBeenCalledTimes(1);
  });
});