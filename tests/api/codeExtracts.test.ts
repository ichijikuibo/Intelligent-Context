import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

const mocks = vi.hoisted(() => ({
  codeExtractsRepo: {
    findByProject: vi.fn(),
    countByProject: vi.fn(),
    findByIdForProject: vi.fn(),
    deleteById: vi.fn(),
  },
  projectsRepo: {
    findById: vi.fn(),
  },
  t: vi.fn((_: unknown, key: string) => key),
}));

vi.mock('../../src/db/repositories/codeExtracts', () => ({
  codeExtractsRepo: mocks.codeExtractsRepo,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/i18n', () => ({
  t: mocks.t,
}));

import { createCodeExtractsRouter } from '../../src/api/routes/codeExtracts';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/projects/:id/code-extracts', createCodeExtractsRouter());
  return app;
}

describe('createCodeExtractsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectsRepo.findById.mockResolvedValue({ id: 'project-1', name: 'Project One' });
    mocks.codeExtractsRepo.findByProject.mockResolvedValue([]);
    mocks.codeExtractsRepo.countByProject.mockResolvedValue(0);
    mocks.codeExtractsRepo.findByIdForProject.mockResolvedValue(undefined);
    mocks.codeExtractsRepo.deleteById.mockResolvedValue(undefined);
  });

  it('returns a project-scoped list of code extracts', async () => {
    mocks.codeExtractsRepo.findByProject.mockResolvedValue([
      {
        id: 'extract-1',
        chunkId: 'chunk-1',
        fileName: 'src/auth/context.ts',
        language: 'ts',
        symbolsJson: '["buildAuthContext"]',
        code: '',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        deletedAt: null,
      },
    ]);
    mocks.codeExtractsRepo.countByProject.mockResolvedValue(1);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/code-extracts');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        codeExtracts: [
          {
            id: 'extract-1',
            chunkId: 'chunk-1',
            fileName: 'src/auth/context.ts',
            language: 'ts',
            symbolsJson: '["buildAuthContext"]',
            code: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            deletedAt: null,
          },
        ],
        total: 1,
      });
    });

    expect(mocks.codeExtractsRepo.findByProject).toHaveBeenCalledWith('project-1', { limit: 50, offset: 0 });
    expect(mocks.codeExtractsRepo.countByProject).toHaveBeenCalledWith('project-1');
  });

  it('returns 404 when listing a missing project', async () => {
    mocks.projectsRepo.findById.mockResolvedValue(undefined);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/code-extracts');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'api.error.projectNotFound' });
    });
  });

  it('deletes a project-scoped code extract', async () => {
    mocks.codeExtractsRepo.findByIdForProject.mockResolvedValue({
      id: 'extract-1',
      chunkId: 'chunk-1',
      fileName: 'src/auth/context.ts',
      language: 'ts',
      symbolsJson: '[]',
      code: 'const x = 1;',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
      projectId: 'project-1',
    });

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/code-extracts/extract-1', {
        method: 'DELETE',
      });

      expect(response.status).toBe(204);
    });

    expect(mocks.codeExtractsRepo.findByIdForProject).toHaveBeenCalledWith('project-1', 'extract-1');
    expect(mocks.codeExtractsRepo.deleteById).toHaveBeenCalledWith('extract-1');
  });

  it('returns 404 when deleting a code extract outside the selected project', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/code-extracts/extract-1', {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'api.error.codeExtractNotFound' });
    });

    expect(mocks.codeExtractsRepo.deleteById).not.toHaveBeenCalled();
  });
});