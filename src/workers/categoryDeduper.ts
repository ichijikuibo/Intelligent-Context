import axios from 'axios';
import { chunksRepo } from '../db/repositories/chunks';
import { summariesRepo } from '../db/repositories/summaries';
import { logger } from '../utils/logger';
import { contentToText } from '../utils/messageContent';
import { withParamFallback, type ParamFallbackContext } from '../utils/paramFallback';
import { applyUpstreamRequestMiddleware } from '../proxy/requestMiddleware';
import type { ResolvedProvider } from '../proxy/upstream';
import type { LearningChunk, Summary } from '../db/schema';

export interface CategoryDeduperOptions {
  projectId: string;
  model: string;
  provider: ResolvedProvider;
  trigger?: 'manual' | 'scheduled';
}

export interface CategoryMerge {
  mainCategory: string;
  otherCategories: string[];
}

const DEDUPER_TIMEOUT_MS = 2 * 60_000;
const MAX_DEDUPER_OUTPUT_TOKENS = 2_000;
const MAX_EXAMPLE_CHARS = 200;
const MAX_CATEGORIES_IN_PROMPT = 200;

const GLOBAL_CATEGORY = 'global';

/**
 * Lowercase, hyphenate and collapse separators so "NHS CCP", "nhs_ccp" and
 * "nhs-ccp" all normalise to the same slug.
 */
export function normaliseCategory(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function truncate(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > MAX_EXAMPLE_CHARS
    ? `${singleLine.slice(0, MAX_EXAMPLE_CHARS)}…`
    : singleLine;
}

function buildCategoryDeduperPrompt(
  chunkCategories: Map<string, string>,
  summaryCategories: Map<string, string>
): string {
  const chunkLines = [...chunkCategories.entries()]
    .slice(0, MAX_CATEGORIES_IN_PROMPT)
    .map(([slug, example]) => `- ${slug}: ${truncate(example)}`)
    .join('\n');

  const summaryLines = [...summaryCategories.entries()]
    .slice(0, MAX_CATEGORIES_IN_PROMPT)
    .map(([slug, example]) => `- ${slug}: ${truncate(example)}`)
    .join('\n');

  return [
    'You are a knowledge-taxonomy editor for a software project.',
    'Below are (a) the categories used by unsummarized learning chunks and',
    '(b) the categories already covered by existing summaries.',
    '',
    'Find categories that refer to the SAME subject — synonyms, abbreviations,',
    'acronyms, spelling/hyphenation variants, singular/plural forms — and propose',
    'merging each set under a single "main" category.',
    '',
    'Rules:',
    '- Only merge categories that clearly describe the same subject. Never merge merely related subjects.',
    '- Strongly prefer an existing summary category as the main category when one matches.',
    '- Otherwise choose the clearest, most descriptive category from the list.',
    `- Never propose merging the "${GLOBAL_CATEGORY}" category.`,
    '- A category must not appear in both the main and other lists of the same entry.',
    '- Categories are lowercase hyphenated slugs.',
    '- If no merges are needed, return an empty array.',
    '- Return ONLY a JSON array. No prose, no markdown code fences.',
    '',
    'Output format:',
    '[{"main-category":"complex-care-pathways","other-categories":["ccp","nhs-ccp"]}]',
    '',
    '## Unsummarized chunk categories (with an example fact)',
    chunkLines || '(none)',
    '',
    '## Categories already covered by summaries (prefer these as main)',
    summaryLines || '(none)',
  ].join('\n');
}

/**
 * Extract the merge list from a model response, tolerating stray prose or
 * markdown fences around the JSON array.
 */
export function parseCategoryMerges(rawText: string): CategoryMerge[] {
  const stripped = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const merges: CategoryMerge[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const mainCategory = normaliseCategory(
      String(record['main-category'] ?? record.mainCategory ?? '')
    );
    const rawOthers = record['other-categories'] ?? record.otherCategories;
    if (!mainCategory || mainCategory === GLOBAL_CATEGORY || !Array.isArray(rawOthers)) {
      continue;
    }

    const otherCategories = [
      ...new Set(
        rawOthers
          .map((value) => normaliseCategory(String(value ?? '')))
          .filter(
            (slug) => slug.length > 0 && slug !== mainCategory && slug !== GLOBAL_CATEGORY
          )
      ),
    ];
    if (otherCategories.length === 0) continue;

    merges.push({ mainCategory, otherCategories });
  }

  return merges;
}

function collectChunkCategories(chunks: LearningChunk[]): {
  categories: Map<string, string>;
  byCategory: Map<string, LearningChunk[]>;
} {
  const categories = new Map<string, string>();
  const byCategory = new Map<string, LearningChunk[]>();

  for (const chunk of chunks) {
    const category = normaliseCategory(chunk.category || '') || 'general';
    if (category === GLOBAL_CATEGORY) continue;

    if (!categories.has(category)) categories.set(category, chunk.fact);

    const bucket = byCategory.get(category);
    if (bucket) bucket.push(chunk);
    else byCategory.set(category, [chunk]);
  }

  return { categories, byCategory };
}

async function collectSummaryCategories(projectId: string): Promise<Map<string, string>> {
  const summaries: Summary[] = await summariesRepo.findByProject(projectId);
  const result = new Map<string, string>();

  for (const summary of summaries) {
    const example = summary.oneLineSummary || summary.title;
    for (const raw of parseStringArray(summary.categoriesList)) {
      const category = normaliseCategory(raw);
      if (!category || category === GLOBAL_CATEGORY) continue;
      if (!result.has(category)) result.set(category, example);
    }
  }

  return result;
}

/** Follow a chain of merges to its terminal main category (cycle-safe). */
function resolveRoot(slug: string, parent: Map<string, string>): string {
  let current = slug;
  const seen = new Set<string>();
  while (parent.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parent.get(current)!;
  }
  return current;
}

async function callDeduperModel(prompt: string, opts: CategoryDeduperOptions): Promise<string> {
  const { adapter, baseUrl, apiKey } = opts.provider;
  const url = adapter.endpoint(baseUrl);
  const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey), {
    jobKey: `category-deduper:${opts.projectId}`,
    projectId: opts.projectId,
  });

  const request = {
    model: opts.model,
    messages: [{ role: 'user' as const, content: prompt }],
    max_tokens: MAX_DEDUPER_OUTPUT_TOKENS,
    temperature: 0.1,
  };

  const ctx: ParamFallbackContext = {
    projectId: opts.projectId,
    model: opts.model,
    providerName: opts.provider.providerName,
    providerType: opts.provider.providerType,
    url,
    requestHeaders: headers,
  };

  const { result } = await withParamFallback(request, adapter, ctx, async (payload) => {
    const response = await axios.post(url, payload, {
      headers,
      timeout: DEDUPER_TIMEOUT_MS,
    });
    return adapter.parseResponse(response.data);
  });

  return contentToText(result.choices?.[0]?.message?.content);
}

/**
 * Ask the model to identify synonym/abbreviation categories and reassign the
 * affected unsummarized chunks onto a single main category.
 *
 * Only unsummarized chunks are touched — existing summaries are left to a
 * later (analyzer) stage. Never throws: any failure is logged and reported as
 * "0 chunks reassigned" so the summary pipeline can continue.
 *
 * @returns the number of chunks whose category was rewritten.
 */
export async function runCategoryDeduper(opts: CategoryDeduperOptions): Promise<number> {
  try {
    const unsummarized = await chunksRepo.findUnsummarized(opts.projectId);
    if (unsummarized.length === 0) return 0;

    const { categories: chunkCategories, byCategory } = collectChunkCategories(unsummarized);
    // Nothing to merge unless at least two distinct chunk categories exist.
    if (chunkCategories.size < 2) return 0;

    const summaryCategories = await collectSummaryCategories(opts.projectId);
    const prompt = buildCategoryDeduperPrompt(chunkCategories, summaryCategories);

    let rawText: string;
    try {
      rawText = await callDeduperModel(prompt, opts);
    } catch (err) {
      logger.warn('Category deduper model call failed', {
        projectId: opts.projectId,
        error: String(err),
      });
      return 0;
    }

    const merges = parseCategoryMerges(rawText);
    if (merges.length === 0) return 0;

    // Flatten the merge list into a source -> main mapping and resolve chains
    // (a -> b, b -> c must land everything on c).
    const parent = new Map<string, string>();
    for (const merge of merges) {
      for (const other of merge.otherCategories) {
        if (!parent.has(other)) parent.set(other, merge.mainCategory);
      }
    }

    // Group every affected chunk by its terminal main category so each
    // category is rewritten with a single bulk statement.
    const idsByRoot = new Map<string, string[]>();
    for (const [category, chunks] of byCategory.entries()) {
      const root = resolveRoot(category, parent);
      if (root === category) continue;

      const ids = idsByRoot.get(root) ?? [];
      ids.push(...chunks.map((chunk) => chunk.id));
      idsByRoot.set(root, ids);
      logger.info('Category deduper merged chunk category', {
        projectId: opts.projectId,
        from: category,
        into: root,
        chunks: chunks.length,
      });
    }

    let reassigned = 0;
    for (const [root, ids] of idsByRoot.entries()) {
      await chunksRepo.updateCategoryForIds(ids, root);
      reassigned += ids.length;
    }

    if (reassigned > 0) {
      logger.info('Category deduper complete', {
        projectId: opts.projectId,
        merges: merges.length,
        reassigned,
      });
    }

    return reassigned;
  } catch (err) {
    logger.warn('Category deduper failed', {
      projectId: opts.projectId,
      error: String(err),
    });
    return 0;
  }
}
