import { Router } from 'express';
import { projectsRepo } from '../../db/repositories/projects';
import { projectMembersRepo } from '../../db/repositories/projectMembers';
import { z } from 'zod';
import { formatZodError, t } from '../../i18n';

const CreateProjectSchema = z.object({
  name: z.string().min(1),
  rootPath: z.string().min(1),
  pathPattern: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  pathPattern: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export function createProjectsRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const projects = (await projectsRepo.findAllForUser(req.user)).map((p) => ({
      ...p,
      settings: projectsRepo.getSettings(p),
    }));
    res.json(projects);
  });

  router.post('/', async (req, res) => {
    if (!req.user || !req.userRole || (req.userRole !== 'admin' && req.userRole !== 'power_user')) {
      res.status(403).json({ error: 'You do not have access to this action.' });
      return;
    }

    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }
    const project = await projectsRepo.create(parsed.data);
    if (!req.user.accessAllProjects && req.user.role !== 'admin') {
      await projectMembersRepo.grant(project.id, req.user.id);
    }
    res.status(201).json({ ...project, settings: projectsRepo.getSettings(project) });
  });

  router.get('/:id', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const project = await projectsRepo.findById(req.params.id);
    if (!project || !(await projectMembersRepo.canAccessProject(req.user, req.params.id))) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }
    res.json({ ...project, settings: projectsRepo.getSettings(project) });
  });

  router.put('/:id', async (req, res) => {
    if (!req.user || !req.userRole || (req.userRole !== 'admin' && req.userRole !== 'power_user')) {
      res.status(403).json({ error: 'You do not have access to this action.' });
      return;
    }

    if (!(await projectMembersRepo.canAccessProject(req.user, req.params.id))) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }

    const parsed = UpdateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }
    const updated = await projectsRepo.update(req.params.id, parsed.data as any);
    if (!updated) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }
    res.json({ ...updated, settings: projectsRepo.getSettings(updated) });
  });

  router.delete('/:id', async (req, res) => {
    if (!req.user || !req.userRole || (req.userRole !== 'admin' && req.userRole !== 'power_user')) {
      res.status(403).json({ error: 'You do not have access to this action.' });
      return;
    }

    const project = await projectsRepo.findById(req.params.id);
    if (!project || !(await projectMembersRepo.canAccessProject(req.user, req.params.id))) {
      res.status(404).json({ error: t(req, 'api.error.projectNotFound') });
      return;
    }
    await projectsRepo.delete(req.params.id);
    res.status(204).end();
  });

  return router;
}
