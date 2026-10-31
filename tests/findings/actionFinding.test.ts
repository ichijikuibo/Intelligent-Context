import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chunksRepo: {
    findById: vi.fn(),
    softDelete: vi.fn(),
    updateFact: vi.fn(),
  },
  summariesRepo: {
    findById: vi.fn(),
    softDelete: vi.fn(),
    update: vi.fn(),
  },
  filesRepo: {
    findByIdForProject: vi.fn(),
    softDeleteById: vi.fn(),
    update: vi.fn(),
  },
  findingsRepo: {
    findById: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../src/db/repositories/chunks', () => ({
  chunksRepo: mocks.chunksRepo,
}));

vi.mock('../../src/db/repositories/summaries', () => ({
  summariesRepo: mocks.summariesRepo,
}));

vi.mock('../../src/db/repositories/files', () => ({
  filesRepo: mocks.filesRepo,
}));

vi.mock('../../src/db/repositories/findings', () => ({
  findingsRepo: mocks.findingsRepo,
}));

import { actionFinding, implementFinding } from '../../src/findings/actionFinding';

describe('actionFinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('soft deletes chunk targets', async () => {
    mocks.chunksRepo.findById.mockResolvedValue({ id: 'chunk-1', projectId: 'project-1' });

    const result = await actionFinding({
      id: 'finding-1',
      projectId: 'project-1',
      actions: [{ action: 'delete', targetType: 'chunk', targetId: 'chunk-1' }],
    });

    expect(result).toEqual({ applied: 1 });
    expect(mocks.chunksRepo.softDelete).toHaveBeenCalledWith('chunk-1');
  });

  it('updates summary targets using the finding payload', async () => {
    mocks.summariesRepo.findById.mockResolvedValue({ id: 'summary-1', projectId: 'project-1' });
    mocks.summariesRepo.update.mockResolvedValue({ id: 'summary-1' });

    await actionFinding({
      id: 'finding-2',
      projectId: 'project-1',
      actions: [{
        action: 'update',
        targetType: 'summary',
        targetId: 'summary-1',
        updateText: 'Updated summary content',
      }],
    });

    expect(mocks.summariesRepo.update).toHaveBeenCalledWith('summary-1', {
      content: 'Updated summary content',
    });
  });

  it('marks finding targets as implemented when actioned as done', async () => {
    mocks.findingsRepo.findById.mockResolvedValue({
      id: 'finding-previous',
      projectId: 'project-1',
      actions: [],
      actionsAppliedAt: null,
    });
    mocks.findingsRepo.updateStatus.mockResolvedValue({
      id: 'finding-previous',
      status: 'implemented',
    });

    const result = await actionFinding({
      id: 'finding-4',
      projectId: 'project-1',
      actions: [{ action: 'done', targetType: 'finding', targetId: 'finding-previous' }],
    });

    expect(result).toEqual({ applied: 1 });
    expect(mocks.findingsRepo.updateStatus).toHaveBeenCalledWith(
      'finding-previous',
      'implemented',
      expect.objectContaining({ reviewedAt: expect.any(Date) })
    );
  });

  it('marks findings implemented only once after actions run', async () => {
    mocks.findingsRepo.findById.mockResolvedValue({
      id: 'finding-3',
      projectId: 'project-1',
      actions: [{ action: 'delete', targetType: 'file', targetId: 'file-1' }],
      actionsAppliedAt: null,
    });
    mocks.filesRepo.findByIdForProject.mockResolvedValue({ id: 'file-1', projectId: 'project-1' });
    mocks.findingsRepo.updateStatus.mockResolvedValue({ id: 'finding-3', status: 'implemented' });

    await implementFinding('finding-3');

    expect(mocks.filesRepo.softDeleteById).toHaveBeenCalledWith('file-1');
    expect(mocks.findingsRepo.updateStatus).toHaveBeenCalledWith(
      'finding-3',
      'implemented',
      expect.objectContaining({ actionsAppliedAt: expect.any(Date) })
    );
  });
});