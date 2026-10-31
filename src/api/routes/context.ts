import { Router, type Request } from 'express';
import { chunksRepo } from '../../db/repositories/chunks';
import { summariesRepo } from '../../db/repositories/summaries';
import { selectionsRepo } from '../../db/repositories/selections';
import { categoriesRepo } from '../../db/repositories/categories';
import { projectsRepo } from '../../db/repositories/projects';
import { t } from '../../i18n';

type ProjectReq = Request<{ id: string }>;

export function createContextRouter(): Router {
  const router = Router({ mergeParams: true });

  // List learning chunks for a project
  router.get('/chunks', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    const project = await projectsRepo.findById(projectId);
    if (!project) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }
    const limit = Math.min(parseInt((req.query.limit as string) || '200', 10), 500);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const [chunks, total] = await Promise.all([
      chunksRepo.findByProject(projectId, { limit, offset }),
      chunksRepo.countByProject(projectId),
    ]);
    res.json({ chunks, total });
  });

  // Delete a specific chunk
  router.delete('/chunks/:cid', async (req, res) => {
    await chunksRepo.delete(req.params['cid']);
    res.status(204).end();
  });

  // List summaries for a project
  router.get('/summaries', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    const summaries = await summariesRepo.findByProject(projectId);
    res.json(summaries);
  });

  // Delete a summary
  router.delete('/summaries/:sid', async (req, res) => {
    await summariesRepo.delete(req.params['sid']);
    res.status(204).end();
  });

  // Category tree
  router.get('/categories', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    res.json(await categoriesRepo.tree(projectId));
  });

  // Context selection history
  router.get('/context-log', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 100);
    res.json(await selectionsRepo.findByProject(projectId, limit));
  });

  return router;
}
