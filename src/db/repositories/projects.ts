import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type Project, type NewProject } from '../schema';
import { categoriesRepo, seedProjectCategories } from './categories';
import { AppError } from '../../utils/appErrors';
import { createProjectConflictError, isDuplicateKeyError } from '../errors';
import type { PublicUser } from './users';

function tables() {
  return getSchema();
}

export const DEFAULT_PROJECT_ID = 'default-project';
export const DEFAULT_PROJECT_NAME = 'Default Project';
export const DEFAULT_PROJECT_ROOT = 'default';

async function ensureProjectCategories(projectId: string): Promise<void> {
  const existing = await categoriesRepo.findByProject(projectId);
  if (existing.length > 0) return;
  await seedProjectCategories(projectId);
}

export interface ProjectSettings {
  mainModel?: string;
  contextSelectorModel?: string;
  summarizerModel?: string;
  analyzerModel?: string;
  contextTokenBudget?: number;
  autoSummarizeThreshold?: number;
  embeddingModel?: string;
  defaultProvider?: string;
  summarizationLastRun?: number;
  analyzerLastRun?: number;
}

export interface CreateProjectData {
  id?: string;
  name: string;
  rootPath: string;
  pathPattern?: string | null;
  settings?: ProjectSettings;
  isDefault?: boolean;
}

export const projectsRepo = {
  async findAll(): Promise<Project[]> {
    const { projects } = tables();
    return selectAll(db().select().from(projects));
  },

  async findAllForUser(user: Pick<PublicUser, 'id' | 'role' | 'accessAllProjects'>): Promise<Project[]> {
    if (user.role === 'admin' || user.accessAllProjects) {
      return this.findAll();
    }

    const { projects, projectMembers } = tables();
    const memberships = await selectAll(db().select().from(projectMembers).where(eq(projectMembers.userId, user.id)));
    const allowedIds = new Set(memberships.map((membership: { projectId: string }) => membership.projectId));
    if (allowedIds.size === 0) return [];

    const allProjects = await selectAll(db().select().from(projects));
    return allProjects.filter((project: Project) => allowedIds.has(project.id));
  },

  async findById(id: string): Promise<Project | undefined> {
    const { projects } = tables();
    return selectOne(db().select().from(projects).where(eq(projects.id, id)));
  },

  async findByRootPath(rootPath: string): Promise<Project | undefined> {
    const { projects } = tables();
    return selectOne(db()
      .select()
      .from(projects)
      .where(eq(projects.rootPath, rootPath)));
  },

  /**
   * Case-insensitive lookup by project name. Used as a softer project-detection
   * signal when an IDE reports a workspace name but no root path (e.g. the
   * Intelligent Context VS Code extension's `X-IC-Project-Name` header).
   */
  async findByName(name: string): Promise<Project | undefined> {
    const trimmed = name.trim();
    if (!trimmed) return undefined;

    const { projects } = tables();
    const lower = trimmed.toLowerCase();
    const all = await selectAll(db().select().from(projects));
    return all.find((p: Project) => p.name.toLowerCase() === lower);
  },

  async findDefault(): Promise<Project | undefined> {
    const { projects } = tables();
    return selectOne(db()
      .select()
      .from(projects)
      .where(eq(projects.isDefault, true)));
  },

  async create(data: CreateProjectData): Promise<Project> {
    const now = new Date();
    const { projects } = tables();
    const project: NewProject = {
      id: data.id ?? uuidv4(),
      name: data.name,
      rootPath: data.rootPath,
      pathPattern: data.pathPattern ?? null,
      isDefault: data.isDefault ?? false,
      settings: JSON.stringify(data.settings ?? {}),      
      createdAt: now,
      updatedAt: now,
      summarizationLastRun: undefined,
      analyzerLastRun: undefined,
    } as NewProject;

    try {
      await execute(db().insert(projects).values(project));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw createProjectConflictError(data.rootPath, error);
      }
      throw error;
    }

    markDirty();

    await ensureProjectCategories(project.id);

    return (await this.findById(project.id))!;
  },

  async update(id: string, data: { name?: string; pathPattern?: string | null; settings?: ProjectSettings }): Promise<Project | undefined> {
    const { projects } = tables();
    const updates: Partial<NewProject> = { updatedAt: new Date() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.pathPattern !== undefined) updates.pathPattern = data.pathPattern;
    if (data.settings !== undefined) updates.settings = JSON.stringify(data.settings);

    await execute(db().update(projects).set(updates).where(eq(projects.id, id)));
    markDirty();
    return this.findById(id);
  },

  async delete(id: string): Promise<void> {
    const { projects } = tables();
    await execute(db().delete(projects).where(eq(projects.id, id)));
    markDirty();
  },

  getSettings(project: Project): ProjectSettings {
    try {
      return JSON.parse(project.settings) as ProjectSettings;
    } catch {
      return {};
    }
  },

  async ensureDefaultProject(): Promise<Project> {
    const currentDefault = await this.findDefault();
    if (currentDefault) {
      await ensureProjectCategories(currentDefault.id);
      return currentDefault;
    }

    const existingRoot = await this.findByRootPath(DEFAULT_PROJECT_ROOT);
    if (existingRoot) {
      const { projects } = tables();
      await execute(db()
        .update(projects)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(projects.id, existingRoot.id)));
      markDirty();

      const refreshed = (await this.findById(existingRoot.id)) ?? existingRoot;
      await ensureProjectCategories(refreshed.id);
      return refreshed;
    }

    try {
      return await this.create({
        id: DEFAULT_PROJECT_ID,
        name: DEFAULT_PROJECT_NAME,
        rootPath: DEFAULT_PROJECT_ROOT,
        isDefault: true,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'project_conflict') {
        const project = (await this.findDefault()) ?? (await this.findByRootPath(DEFAULT_PROJECT_ROOT));
        if (project) {
          await ensureProjectCategories(project.id);
          return project;
        }
      }
      throw error;
    }
  },

  /** Find or create a project by root path. Returns existing or newly created project. */
  async upsertByRootPath(rootPath: string, name?: string): Promise<Project> {
    if (rootPath === DEFAULT_PROJECT_ROOT) {
      return this.ensureDefaultProject();
    }

    const existing = await this.findByRootPath(rootPath);
    if (existing) return existing;

    const inferredName =
      name ?? rootPath.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown-project';

    try {
      return await this.create({ name: inferredName, rootPath });
    } catch (error) {
      if (error instanceof AppError && error.code === 'project_conflict') {
        const raced = await this.findByRootPath(rootPath);
        if (raced) return raced;
      }
      throw error;
    }
  },

  /** Find all projects that have a pathPattern defined. */
  async findAllWithPathPatterns(): Promise<Project[]> {
    const { projects } = tables();
    return (await selectAll(db()
      .select()
      .from(projects)))
      .filter((p: Project) => p.pathPattern != null && p.pathPattern.length > 0);
  },

  async findAllWithPathPatternsForUser(user: Pick<PublicUser, 'id' | 'role' | 'accessAllProjects'>): Promise<Project[]> {
    const projects = await this.findAllForUser(user);
    return projects.filter((project) => project.pathPattern != null && project.pathPattern.length > 0);
  },
  async updateSummarizationLastRun(projectId: string): Promise<void> {
    const { projects } = tables();
    await execute(db()
      .update(projects)
      .set({ summarizationLastRun: new Date().toISOString() })
      .where(eq(projects.id, projectId)));
    markDirty();
  },

  async updateAnalyzerLastRun(projectId: string): Promise<void> {
    const { projects } = tables();
    await execute(db()
      .update(projects)
      .set({ analyzerLastRun: new Date().toISOString() })
      .where(eq(projects.id, projectId)));
    markDirty();
  },
};
