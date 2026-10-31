import { Router } from 'express';
import { backgroundTaskRunsRepo } from '../../db/repositories/backgroundTaskRuns';
import { requireAuthenticated, requireRole } from '../../auth/context';

export function createTaskRunsRouter(): Router {
  const router = Router();

  // List recent task runs (for the task-log tab)
  router.get('/', requireAuthenticated(), requireRole('admin'), async (_req, res) => {
    const limit = Math.min(Number(_req.query.limit) || 50, 200);
    const runs = await backgroundTaskRunsRepo.findRecent(limit);
    res.json(runs);
  });

  // Count unread notifications
  router.get('/unread-count', requireAuthenticated(), requireRole('admin'), async (_req, res) => {
    const count = await backgroundTaskRunsRepo.countUnread();
    res.json({ count });
  });

  // Mark a single notification as read
  router.post('/:id/mark-read', requireAuthenticated(), requireRole('admin'), async (req, res) => {
    const id = req.params['id'] as string;
    if (!id) {
      res.status(400).json({ error: 'ID is required.' });
      return;
    }
    await backgroundTaskRunsRepo.markRead(id);
    res.json({ ok: true });
  });

  // Mark all notifications as read
  router.post('/mark-all-read', requireAuthenticated(), requireRole('admin'), async (_req, res) => {
    await backgroundTaskRunsRepo.markAllRead();
    res.json({ ok: true });
  });

  return router;
}
