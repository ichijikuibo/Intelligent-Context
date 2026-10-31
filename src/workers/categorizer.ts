import { chunksRepo } from '../db/repositories/chunks';
import { categoriesRepo } from '../db/repositories/categories';
import { logger } from '../utils/logger';
import type { LearningChunk } from '../db/schema';

const CATEGORY_SLUG_ALIASES: Record<string, string> = {
  'user-preference': 'user-preferences',
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  architecture: ['pattern', 'structure', 'module', 'layer', 'component', 'service', 'repository', 'controller', 'mvc', 'api', 'interface', 'design'],
  conventions: ['naming', 'convention', 'style', 'format', 'prefer', 'always', 'never', 'standard', 'consistent', 'camelcase', 'pascalcase'],
  dependencies: ['library', 'package', 'npm', 'dependency', 'framework', 'version', 'install', 'require', 'import', 'uses', 'stack'],
  gotchas: ['gotcha', 'bug', 'issue', 'problem', 'avoid', 'warning', 'careful', 'broken', 'workaround', 'limitation', 'constraint', 'deprecated'],
  'user-preference': ['prefer', 'want', 'like', 'dislike', 'concise', 'verbose', 'style', 'format', 'output'],
  'api-design': ['endpoint', 'route', 'rest', 'graphql', 'request', 'response', 'schema', 'dto', 'swagger', 'openapi'],
};

function classifyChunk(chunk: LearningChunk): string {
  if (chunk.category && chunk.category !== 'general') return chunk.category;

  const factLower = chunk.fact.toLowerCase();
  let best = 'general';
  let bestScore = 0;

  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = keywords.reduce((s, kw) => s + (factLower.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }

  return best;
}

export async function runCategorizer(projectId: string): Promise<void> {
  const [chunks, catTree] = await Promise.all([
    chunksRepo.findUnsummarized(projectId),
    categoriesRepo.findByProject(projectId),
  ]);
  const catBySlug = new Map(catTree.map((c) => [c.slug, c.id]));

  let updated = 0;
  let linked = 0;

  for (const chunk of chunks) {
    const slug = classifyChunk(chunk);

    if (slug !== chunk.category) {
      await chunksRepo.updateCategory(chunk.id, slug);
      updated++;
    }

    const catId = catBySlug.get(CATEGORY_SLUG_ALIASES[slug] ?? slug);
    if (!catId) continue;

    try {
      await categoriesRepo.assignToChunk(chunk.id, catId);
      linked++;
    } catch {
      // Already assigned — ignore
    }
  }

  if (updated > 0 || linked > 0) {
    logger.debug('Categorizer assigned categories', { projectId, updated, linked });
  }
}
