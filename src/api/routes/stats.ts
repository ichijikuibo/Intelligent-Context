import { Router, type Request } from 'express';
import { statsRepo } from '../../db/repositories/stats';

type ProjectReq = Request<{ id: string }>;
type StatReq = Request<{ id: string; sid: string }>;

function parseTypeList(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const types = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return types.length > 0 ? types : undefined;
}

export function createStatsRouter(): Router {
  const router = Router({ mergeParams: true });

  // List recent stats for the project, optionally filtered by type/types.
  router.get('/', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    const type = typeof req.query.type === 'string' && req.query.type.length > 0
      ? req.query.type
      : undefined;
    const types = parseTypeList(req.query.types);
    const limit = Number(req.query.limit) || 100;
    const offset = Number(req.query.offset) || 0;

    const [stats, total, typeCounts] = await Promise.all([
      statsRepo.findByProject(projectId, { type, types, limit, offset }),
      statsRepo.countForProject(projectId, type, types),
      statsRepo.countByType(projectId, types),
    ]);

    res.json({ stats, total, typeCounts });
  });

  // Single stats row (includes the full body) for the detail view.
  router.get('/:sid', async (req: StatReq, res) => {
    const stat = await statsRepo.findById(req.params.sid);
    if (!stat || stat.projectId !== req.params.id) {
      res.status(404).json({ error: 'Stat not found' });
      return;
    }

    res.json(stat);
  });

  return router;
}
