import { Router, type Request } from 'express';
import { filesRepo } from '../../db/repositories/files';
import { projectsRepo } from '../../db/repositories/projects';
import { t } from '../../i18n';
import type { Summary } from '../../db/schema';

type ProjectReq = Request<{ id: string }>;

function parseLimit(value: unknown, fallback = 50): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 200);
}

function parseOffset(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

function parseCategoriesList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function buildSummaryPreview(summary: Summary) {
  const preview = summary.content.length > 400 ? `${summary.content.slice(0, 400)}...` : summary.content;
  return {
    id: summary.id,
    title: summary.title,
    oneLineSummary: summary.oneLineSummary,
    categories: parseCategoriesList(summary.categoriesList),
    version: summary.version,
    contentPreview: preview,
    truncated: summary.content.length > 400,
    totalLength: summary.content.length,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

export function createFilesRouter(): Router {
  const router = Router({ mergeParams: true });

  // List files for a project
  router.get('/', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    const project = await projectsRepo.findById(projectId);
    if (!project) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const [files, total] = await Promise.all([
      filesRepo.findByProject(projectId, { limit, offset }),
      filesRepo.countByProject(projectId),
    ]);
    res.json({ files, total });
  });

  router.get('/:fid', async (req: ProjectReq & Request<{ fid: string }>, res) => {
    const projectId = req.params.id;
    const file = await filesRepo.findByIdForProject(projectId, req.params.fid);
    if (!file) {
      res.status(404).json({ error: t(req, 'api.error.fileNotFound') });
      return;
    }
    res.json({ file });
  });

  router.get('/:fid/chunks', async (req: ProjectReq & Request<{ fid: string }>, res) => {
    const projectId = req.params.id;
    const file = await filesRepo.findByIdForProject(projectId, req.params.fid);
    if (!file) {
      res.status(404).json({ error: t(req, 'api.error.fileNotFound') });
      return;
    }

    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const chunks = await filesRepo.findChunksByFileId(file.id);
    const items = chunks.slice(offset, offset + limit);

    res.json({
      file,
      total: chunks.length,
      limit,
      offset,
      items,
    });
  });

  router.get('/:fid/summaries', async (req: ProjectReq & Request<{ fid: string }>, res) => {
    const projectId = req.params.id;
    const file = await filesRepo.findByIdForProject(projectId, req.params.fid);
    if (!file) {
      res.status(404).json({ error: t(req, 'api.error.fileNotFound') });
      return;
    }

    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const summaries = await filesRepo.findSummariesByFileId(file.id);
    const items = summaries.slice(offset, offset + limit).map((summary) => buildSummaryPreview(summary));

    res.json({
      file,
      total: summaries.length,
      limit,
      offset,
      items,
    });
  });

  // Delete a specific file
  router.delete('/:fid', async (req, res) => {
    const file = await filesRepo.findById(req.params['fid']);
    if (!file) {
      res.status(404).json({ error: t(req, 'api.error.fileNotFound') });
      return;
    }
    await filesRepo.deleteById(req.params['fid']);
    res.status(204).end();
  });

  return router;
}
