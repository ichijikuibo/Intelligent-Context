import { Router, type Request } from 'express';
import { codeExtractsRepo } from '../../db/repositories/codeExtracts';
import { projectsRepo } from '../../db/repositories/projects';
import { t } from '../../i18n';

type ProjectReq = Request<{ id: string }>;
type ProjectCodeExtractReq = Request<{ id: string; eid: string }>;

export function createCodeExtractsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    const project = await projectsRepo.findById(projectId);
    if (!project) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }

    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const [codeExtracts, total] = await Promise.all([
      codeExtractsRepo.findByProject(projectId, { limit, offset }),
      codeExtractsRepo.countByProject(projectId),
    ]);

    res.json({ codeExtracts, total });
  });

  router.delete('/:eid', async (req: ProjectCodeExtractReq, res) => {
    const codeExtract = await codeExtractsRepo.findByIdForProject(req.params.id, req.params.eid);
    if (!codeExtract) {
      res.status(404).json({ error: t(req, 'api.error.codeExtractNotFound') });
      return;
    }

    await codeExtractsRepo.deleteById(req.params.eid);
    res.status(204).end();
  });

  return router;
}