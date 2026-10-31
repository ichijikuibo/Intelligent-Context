import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type Category, type NewCategory } from '../schema';

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
  children: CategoryNode[];
}

/** Seed categories defined here so projects.ts can import them. */
export const DEFAULT_CATEGORIES: Array<{
  name: string;
  slug: string;
  color: string;
  children: Array<{ name: string; slug: string }>;
}> = [
  {
    name: 'Architecture & Patterns',
    slug: 'architecture',
    color: '#6366f1',
    children: [
      { name: 'Module Structure', slug: 'module-structure' },
      { name: 'Data Flow', slug: 'data-flow' },
      { name: 'Design Patterns', slug: 'design-patterns' },
    ],
  },
  {
    name: 'Conventions & Style',
    slug: 'conventions',
    color: '#22c55e',
    children: [
      { name: 'Naming Conventions', slug: 'naming' },
      { name: 'Code Organization', slug: 'code-org' },
      { name: 'Testing Patterns', slug: 'testing' },
    ],
  },
  {
    name: 'Dependencies & Stack',
    slug: 'dependencies',
    color: '#f59e0b',
    children: [
      { name: 'Core Libraries', slug: 'core-libs' },
      { name: 'Build Tools', slug: 'build-tools' },
      { name: 'Infrastructure', slug: 'infrastructure' },
    ],
  },
  {
    name: 'Gotchas & Constraints',
    slug: 'gotchas',
    color: '#ef4444',
    children: [
      { name: 'Known Bugs', slug: 'bugs' },
      { name: 'Performance Limits', slug: 'performance' },
      { name: 'Compatibility Issues', slug: 'compatibility' },
    ],
  },
  {
    name: 'User Preferences',
    slug: 'user-preferences',
    color: '#8b5cf6',
    children: [
      { name: 'Tool Preferences', slug: 'tools' },
      { name: 'Communication Style', slug: 'communication' },
      { name: 'Process Preferences', slug: 'process' },
    ],
  },
];

export async function seedProjectCategories(projectId: string): Promise<void> {
  const { categories } = getSchema();
  const d = db();

  for (const top of DEFAULT_CATEGORIES) {
    const parentId = uuidv4();
    await execute(d.insert(categories).values({
      id: parentId,
      projectId,
      parentId: null,
      name: top.name,
      slug: top.slug,
      color: top.color,
    } as NewCategory));

    for (const child of top.children) {
      await execute(d.insert(categories).values({
        id: uuidv4(),
        projectId,
        parentId,
        name: child.name,
        slug: child.slug,
      } as NewCategory));
    }
  }
  markDirty();
}

export const categoriesRepo = {
  async findByProject(projectId: string): Promise<Category[]> {
    const { categories } = getSchema();
    return selectAll(db()
      .select()
      .from(categories)
      .where(eq(categories.projectId, projectId)));
  },

  async tree(projectId: string): Promise<CategoryNode[]> {
    const all = await this.findByProject(projectId);
    const map = new Map<string, CategoryNode>();

    for (const c of all) {
      map.set(c.id, {
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        color: c.color,
        children: [],
      });
    }

    const roots: CategoryNode[] = [];
    for (const c of all) {
      if (c.parentId && map.has(c.parentId)) {
        map.get(c.parentId)!.children.push(map.get(c.id)!);
      } else if (!c.parentId) {
        roots.push(map.get(c.id)!);
      }
    }
    return roots;
  },

  async assignToChunk(
    chunkId: string,
    categoryId: string,
    confidence = 1.0
  ): Promise<void> {
    const { chunkCategories } = getSchema();
    const d = db();
    // Insert or ignore duplicate
    try {
      await execute(d.insert(chunkCategories)
        .values({ chunkId, categoryId, assignedBy: 'auto', confidence }));
      markDirty();
    } catch {
      // Already exists — ignore
    }
  },

  async findCategoryBySlug(projectId: string, slug: string): Promise<Category | undefined> {
    const { categories } = getSchema();
    return selectOne(db()
      .select()
      .from(categories)
      .where(and(eq(categories.projectId, projectId), eq(categories.slug, slug))));
  },
};
