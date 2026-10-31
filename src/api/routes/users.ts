import { Router } from 'express';
import { hashPassword } from '../../auth/credentials';
import { normalizeModelGrants, requireAuthenticated, requireRole } from '../../auth/context';
import { projectMembersRepo } from '../../db/repositories/projectMembers';
import { projectsRepo } from '../../db/repositories/projects';
import { usersRepo, type UserRole } from '../../db/repositories/users';

const VALID_ROLES = new Set<UserRole>(['admin', 'power_user', 'user']);

/**
 * Read the requested model grants from a request body.
 *
 * Values are trimmed, de-duplicated and pruned of entries already covered by a
 * broader grant, so `['OCA-*', 'OCA-deepseek-v4']` is stored as `['OCA-*']`.
 * Returns `undefined` when the field was not supplied (leave unchanged).
 */
function readAllowedModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return normalizeModelGrants(value);
}

/** Same treatment for the user's own visibility preference. */
function readHiddenModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return normalizeModelGrants(value);
}

export function createUsersRouter(): Router {
  const router = Router();

  router.use(requireAuthenticated());
  router.use(requireRole('admin'));

  router.get('/', async (_req, res) => {
    const [users, projects] = await Promise.all([usersRepo.findAll(), projectsRepo.findAll()]);
    const projectMap = new Map(projects.map((project) => [project.id, project]));

    const payload = await Promise.all(
      users.map(async (user) => {
        const memberships = await projectMembersRepo.listByUser(user.id);
        return {
          ...usersRepo.toPublicUser(user),
          projectIds: memberships.map((membership) => membership.projectId),
          projects: memberships
            .map((membership) => projectMap.get(membership.projectId))
            .filter(Boolean)
            .map((project) => ({ id: project!.id, name: project!.name })),
        };
      })
    );

    res.json(payload);
  });

  router.post('/', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'user') as UserRole;
    const isApproved = req.body?.isApproved !== false;
    const isDisabled = req.body?.isDisabled === true;
    const accessAllProjects = req.body?.accessAllProjects === true || role === 'admin';
    const accessAllModels = req.body?.accessAllModels === true || role === 'admin';
    const allowedModels = readAllowedModels(req.body?.allowedModels) ?? [];
    const hiddenModels = readHiddenModels(req.body?.hiddenModels) ?? [];
    const projectIds = Array.isArray(req.body?.projectIds)
      ? req.body.projectIds.filter((value: unknown): value is string => typeof value === 'string')
      : [];

    if (!email || !password || !VALID_ROLES.has(role)) {
      res.status(400).json({ error: 'Email, password, and role are required.' });
      return;
    }

    const user = await usersRepo.create({
      email,
      passwordHash: hashPassword(password),
      role,
      isApproved,
      isDisabled,
      accessAllProjects,
      accessAllModels,
      allowedModels,
      hiddenModels,
    });

    if (!accessAllProjects) {
      await projectMembersRepo.replaceForUser(user.id, projectIds);
    }

    res.status(201).json(usersRepo.toPublicUser(user));
  });

  router.put('/:id', async (req, res) => {
    const existing = await usersRepo.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const role = req.body?.role === undefined ? undefined : (String(req.body.role) as UserRole);
    if (role !== undefined && !VALID_ROLES.has(role)) {
      res.status(400).json({ error: 'Invalid role.' });
      return;
    }

    // Admins are never restricted: promoting someone to admin clears any
    // per-model limits instead of leaving a stale grant list behind.
    const nextRole = role ?? existing.role;
    const becomesAdmin = nextRole === 'admin';

    const updates = {
      role,
      isApproved: req.body?.isApproved,
      isDisabled: req.body?.isDisabled,
      accessAllProjects: req.body?.accessAllProjects,
      accessAllModels: becomesAdmin ? true : req.body?.accessAllModels,
      allowedModels: becomesAdmin ? [] : readAllowedModels(req.body?.allowedModels),
      hiddenModels: readHiddenModels(req.body?.hiddenModels),
      passwordHash:
        typeof req.body?.password === 'string' && req.body.password.length > 0
          ? hashPassword(req.body.password)
          : undefined,
    };

    const updated = await usersRepo.update(req.params.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    if (req.body?.accessAllProjects === true || updated.role === 'admin') {
      await projectMembersRepo.replaceForUser(updated.id, []);
    } else if (Array.isArray(req.body?.projectIds)) {
      const projectIds = req.body.projectIds.filter((value: unknown): value is string => typeof value === 'string');
      await projectMembersRepo.replaceForUser(updated.id, projectIds);
    }

    res.json(usersRepo.toPublicUser(updated));
  });

  return router;
}