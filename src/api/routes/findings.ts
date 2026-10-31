import { Router, type Request } from 'express';
import { findingsRepo } from '../../db/repositories/findings';
import { implementFinding } from '../../findings/actionFinding';
import { z } from 'zod';
import { formatZodError } from '../../i18n';

type ProjectReq = Request<{ id: string }>;
type FindingReq = Request<{ id: string; fid: string }>;

const UpdateFindingSchema = z.object({
  status: z.enum(['open', 'accepted', 'dismissed', 'implemented', 'actioned', 'false']),
});

export function createFindingsRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    res.json(await findingsRepo.findByProject(projectId));
  });

  router.put('/:fid', async (req: FindingReq, res) => {
    const parsed = UpdateFindingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const finding = await findingsRepo.findById(req.params.fid);
    if (!finding || finding.projectId !== req.params.id) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }

    if (parsed.data.status === 'implemented') {
      await implementFinding(req.params.fid);
    } else if (parsed.data.status === 'actioned') {
      await findingsRepo.updateStatus(req.params.fid, parsed.data.status, {
        reviewedAt: new Date(),
        actionsAppliedAt: new Date(),
      });
    } else {
      await findingsRepo.updateStatus(req.params.fid, parsed.data.status, {
        reviewedAt: new Date(),
      });
    }
    res.json({ ok: true });
  });

  return router;
}
