import type { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { projectMembersRepo } from '../../db/repositories/projectMembers';
import { projectsRepo } from '../../db/repositories/projects';
import { logger } from '../../utils/logger';
import type { ChatMessage } from '../adapters/adapter';
import { contentToText } from '../../utils/messageContent';
import { recordClientInfo } from '../clientInfo';

declare global {
  // Augment Express request with detected project
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      projectId?: string;
      projectName?: string;
      projectRoot?: string;
      /** How the project was detected (header / body-hint / pattern / first / default) */
      projectSource?: string;
    }
  }
}

/**
 * Extract file paths from message content strings.
 * Matches absolute paths (C:\..., /home/...) and relative paths (./..., ../...).
 */
function extractFilePaths(messages: ChatMessage[]): string[] {
  const results: string[] = [];
  const pathRe = /(?:[a-zA-Z]:[\\/]|\/|\.\.?[\\/])\S+/g;

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = contentToText(msg.content);
    for (const match of text.matchAll(pathRe)) {
      const trimmed = match[0].replace(/[,;)}\]]+$/, '');
      results.push(trimmed);
    }
  }

  return results;
}

/**
 * Try to match extracted file paths against projects with pathPattern configured.
 * Returns the first matching project, or undefined.
 */
async function matchByPathPattern(paths: string[]): Promise<ReturnType<typeof projectsRepo.findById>> {
  const candidates = await projectsRepo.findAllWithPathPatterns();
  if (candidates.length === 0) return undefined;

  // Sort by pattern specificity: longer patterns first (more specific match)
  const ranked = [...candidates].sort(
    (a, b) => (b.pathPattern?.length ?? 0) - (a.pathPattern?.length ?? 0)
  );

  for (const project of ranked) {
    const pattern = project.pathPattern;
    if (!pattern) continue;

    try {
      const re = new RegExp(pattern, 'i');
      for (const filePath of paths) {
        if (re.test(filePath)) {
          logger.info('Project detected via path pattern', {
            pattern,
            filePath,
            project: project.name,
          });
          return project;
        }
      }
    } catch {
      // If pattern is an invalid regex, treat as literal substring match
      for (const filePath of paths) {
        if (filePath.toLowerCase().includes(pattern.toLowerCase())) {
          logger.info('Project detected via path pattern (literal)', {
            pattern,
            filePath,
            project: project.name,
          });
          return project;
        }
      }
    }
  }

  return undefined;
}

async function matchByPathPatternForUser(
  paths: string[],
  req: Request
): Promise<Awaited<ReturnType<typeof projectsRepo.findById>> | undefined> {
  if (!req.user) {
    return matchByPathPattern(paths);
  }

  const candidates = await projectsRepo.findAllWithPathPatternsForUser(req.user);
  if (candidates.length === 0) return undefined;

  const ranked = [...candidates].sort(
    (a, b) => (b.pathPattern?.length ?? 0) - (a.pathPattern?.length ?? 0)
  );

  for (const project of ranked) {
    const pattern = project.pathPattern;
    if (!pattern) continue;

    try {
      const re = new RegExp(pattern, 'i');
      for (const filePath of paths) {
        if (re.test(filePath)) {
          return project;
        }
      }
    } catch {
      for (const filePath of paths) {
        if (filePath.toLowerCase().includes(pattern.toLowerCase())) {
          return project;
        }
      }
    }
  }

  return undefined;
}

async function assignProject(req: Request, project: Awaited<ReturnType<typeof projectsRepo.findById>>, source: string): Promise<void> {
  if (!project) return;
  req.projectId = project.id;
  req.projectName = project.name;
  req.projectRoot = project.rootPath;
  req.projectSource = source;
  recordClientInfo(req, project.name);
}

/**
 * Match a client-supplied workspace name against existing projects.
 * This is a softer signal than the root path — it only matches projects that
 * already exist and never auto-creates one.
 */
async function matchByProjectName(
  name: string,
  req: Request
): Promise<Awaited<ReturnType<typeof projectsRepo.findById>> | undefined> {
  const matched = await projectsRepo.findByName(name);
  if (!matched) return undefined;

  if (!(await canAccessProject(req, matched.id))) {
    logger.info('Project name hint matched a project the user cannot access', { name });
    return undefined;
  }

  logger.info('Project detected via name hint', { name, project: matched.name });
  return matched;
}

async function canAccessProject(req: Request, projectId: string): Promise<boolean> {
  if (!req.user) return true;
  return projectMembersRepo.canAccessProject(req.user, projectId);
}

export async function projectDetectMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Option A: Explicit header (set by IDE extension or curl)
  const rootHeader =
    (req.headers['x-project-root'] as string | undefined) ||
    (req.headers['x-workspace-root'] as string | undefined);

  if (rootHeader) {
    const normalised = path.normalize(rootHeader);
    const existing = await projectsRepo.findByRootPath(normalised);
    if (existing) {
      if (!(await canAccessProject(req, existing.id))) {
        res.status(403).json({ error: { message: 'You do not have access to this project.', type: 'auth_error' } });
        return;
      }

      await assignProject(req, existing, 'header');
      next();
      return;
    }

    if (!req.user || req.user.role === 'admin' || req.user.role === 'power_user') {
      const project = await projectsRepo.upsertByRootPath(normalised);
      if (req.user && !req.user.accessAllProjects && req.user.role !== 'admin') {
        await projectMembersRepo.grant(project.id, req.user.id);
      }
      await assignProject(req, project, 'header');
      next();
      return;
    }

    req.projectSource = 'unmatched-header';
    recordClientInfo(req, null);
    next();
    return;
  }

  // Option B: Body contains a hint (some tools send workspace path)
  const body = req.body as Record<string, unknown> | undefined;
  const bodyRoot =
    (body?.workspace_root as string | undefined) ||
    (body?.project_root as string | undefined);

  if (bodyRoot) {
    const normalised = path.normalize(bodyRoot);
    const existing = await projectsRepo.findByRootPath(normalised);
    if (existing) {
      if (!(await canAccessProject(req, existing.id))) {
        res.status(403).json({ error: { message: 'You do not have access to this project.', type: 'auth_error' } });
        return;
      }

      await assignProject(req, existing, 'body-hint');
      next();
      return;
    }

    if (!req.user || req.user.role === 'admin' || req.user.role === 'power_user') {
      const project = await projectsRepo.upsertByRootPath(normalised);
      if (req.user && !req.user.accessAllProjects && req.user.role !== 'admin') {
        await projectMembersRepo.grant(project.id, req.user.id);
      }
      await assignProject(req, project, 'body-hint');
      next();
      return;
    }

    req.projectSource = 'unmatched-body-hint';
    recordClientInfo(req, null);
    next();
    return;
  }

  // Option B2: Workspace name hint (softer than root path). IDE extensions such
  // as the Intelligent Context VS Code extension send the workspace name via
  // `X-IC-Project-Name` because the path can differ between machines/containers.
  const projectNameHint = req.headers['x-ic-project-name'] as string | undefined;
  if (projectNameHint && projectNameHint.trim()) {
    const matched = await matchByProjectName(projectNameHint.trim(), req);
    if (matched) {
      await assignProject(req, matched, 'name-hint');
      next();
      return;
    }
    logger.info('Project name hint did not match an existing project', {
      projectNameHint,
    });
  }

  // Option B3: Heuristic — match file paths in messages against project pathPattern
  const messages = (body?.messages as ChatMessage[] | undefined) ?? [];
  const filePaths = extractFilePaths(messages);
  if (filePaths.length > 0) {
    const matched = await matchByPathPatternForUser(filePaths, req);
    if (matched) {
      await assignProject(req, matched, 'pattern');
      next();
      return;
    }
  }

  // Option C: Fall back to the seeded default project only when this user can access it.
  const defaultProject = await projectsRepo.ensureDefaultProject();
  const canUseDefault = await canAccessProject(req, defaultProject.id);
  if (canUseDefault) {
    logger.info('No project detected; using default project');
    await assignProject(req, defaultProject, 'default');
  } else {
    logger.info('No project detected and default project is not accessible; proxying without context');
    req.projectSource = 'none';
    recordClientInfo(req, null);
  }
  next();
}
