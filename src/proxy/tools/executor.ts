import { chunksRepo } from '../../db/repositories/chunks';
import { codeExtractsRepo } from '../../db/repositories/codeExtracts';
import { filesRepo } from '../../db/repositories/files';
import { categoriesRepo } from '../../db/repositories/categories';
import { findingsRepo, type FindingAction, type FindingStatus, type RelatedIds } from '../../db/repositories/findings';
import { summariesRepo } from '../../db/repositories/summaries';
import { implementFinding } from '../../findings/actionFinding';
import { getEffectiveContextConfig } from '../../config/configOverrides';
import { getSystemModelConfig } from '../../config/systemModels';
// Type-only import is erased at compile time, so it does not create a runtime
// cycle (`executor → upstream → agentLoop → executor`). The value imports of
// selectContext / resolveProviderAndModelForJob are done lazily inside
// selectContextForPhrase for the same reason.
import type { ResolvedProviderAndModel } from '../../context/selector';
import { assembleContextMessage } from '../../context/assembler';
import { projectsRepo } from '../../db/repositories/projects';
import { AppError, isAppError } from '../../utils/appErrors';
import { hashFact } from '../../utils/hashing';
import { logger } from '../../utils/logger';
import { recordStat, generateRunId } from '../../utils/stats';
import { estimateTokens } from '../../utils/tokens';
import type { ChatMessage } from '../../proxy/adapters/adapter';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_CATEGORY_CHUNK_LIMIT = 200;
const DEFAULT_CHUNK_CONFIDENCE = 0.75;
const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;
const SEARCH_SNIPPET_LENGTH = 240;
const FINDING_STATUSES = new Set<FindingStatus>([
  'open',
  'accepted',
  'dismissed',
  'implemented',
  'actioned',
  'false',
]);

export interface LearningToolExecutionResult {
  success: boolean;
  result: unknown;
  error?: string;
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return undefined;
}

function clampLimit(value: unknown): number {
  const parsed = parseNumber(value);
  if (parsed === undefined) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(parsed)));
}

function clampOffset(value: unknown): number {
  const parsed = parseNumber(value);
  if (parsed === undefined) return 0;
  return Math.max(0, Math.floor(parsed));
}

function matchesSearch(fields: Array<string | undefined>, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle) === true);
}

function paginate<T>(items: T[], limit: number, offset: number): T[] {
  return items.slice(offset, offset + limit);
}

function parseCategoriesList(raw: string | null | undefined): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function parseStoredStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function parseStringArrayField(value: unknown, fieldName: string, maxItems = 500): string[] {
  if (!Array.isArray(value)) {
    throw new AppError(`${fieldName} must be an array of strings.`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `${fieldName} must be an array of strings.`,
    });
  }

  if (value.length > maxItems) {
    throw new AppError(`${fieldName} must contain at most ${maxItems} items.`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `${fieldName} must contain at most ${maxItems} items.`,
    });
  }

  return value.map((item) => {
    const parsed = trimString(item);
    if (!parsed) {
      throw new AppError(`Each item in ${fieldName} must be a non-empty string.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `Each item in ${fieldName} must be a non-empty string.`,
      });
    }

    return parsed;
  });
}

function parseOptionalStringArray(value: unknown, fieldName: string, maxItems = 500): string[] | undefined {
  if (value === undefined) return undefined;
  return parseStringArrayField(value, fieldName, maxItems);
}

function buildPreview(text: string, maxLength = 400): {
  preview: string;
  truncated: boolean;
  totalLength: number;
} {
  if (text.length <= maxLength) {
    return {
      preview: text,
      truncated: false,
      totalLength: text.length,
    };
  }

  return {
    preview: text.slice(0, maxLength),
    truncated: true,
    totalLength: text.length,
  };
}

function buildSummaryDetail<T extends { categoriesList: string | null | undefined; sourceChunkIds: string | null | undefined }>(summary: T) {
  return {
    ...summary,
    categories: parseCategoriesList(summary.categoriesList),
    sourceChunkIds: parseStoredStringArray(summary.sourceChunkIds),
  };
}

function requireId(value: unknown, fieldName: string): string {
  const parsed = trimString(value);
  if (!parsed) {
    throw new AppError(`Missing required field: ${fieldName}`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `Missing required field: ${fieldName}`,
    });
  }

  return parsed;
}

function requireConfidence(value: unknown, fallback = DEFAULT_CHUNK_CONFIDENCE): number {
  const parsed = parseNumber(value) ?? fallback;
  if (parsed < 0 || parsed > 1) {
    throw new AppError('Confidence must be between 0 and 1.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'Confidence must be between 0 and 1.',
    });
  }

  return parsed;
}

function formatToolError(error: unknown): string {
  if (isAppError(error) && error.publicMessage) {
    return error.publicMessage;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Learning tool execution failed.';
}

async function requireChunk(projectId: string, chunkId: string) {
  const chunk = await chunksRepo.findById(chunkId);
  if (!chunk || chunk.projectId !== projectId) {
    throw new AppError('Chunk not found.', {
      statusCode: 404,
      code: 'learning_tool_not_found',
      publicMessage: 'Chunk not found.',
    });
  }

  return chunk;
}

async function requireSummary(projectId: string, summaryId: string) {
  const summary = await summariesRepo.findById(summaryId);
  if (!summary || summary.projectId !== projectId) {
    throw new AppError('Summary not found.', {
      statusCode: 404,
      code: 'learning_tool_not_found',
      publicMessage: 'Summary not found.',
    });
  }

  return summary;
}

async function requireFinding(projectId: string, findingId: string) {
  const finding = await findingsRepo.findById(findingId);
  if (!finding || finding.projectId !== projectId) {
    throw new AppError('Finding not found.', {
      statusCode: 404,
      code: 'learning_tool_not_found',
      publicMessage: 'Finding not found.',
    });
  }

  return finding;
}

async function buildChunkDetail(projectId: string, chunkId: string) {
  const chunk = await requireChunk(projectId, chunkId);
  const [files, codeExtracts] = await Promise.all([
    filesRepo.findByChunkId(chunkId),
    codeExtractsRepo.findByChunkId(chunkId),
  ]);

  return {
    ...chunk,
    files,
    codeExtracts,
  };
}

async function requireFile(projectId: string, params: Record<string, unknown>) {
  const fileId = trimString(params.fileId);
  if (fileId) {
    const file = await filesRepo.findByIdForProject(projectId, fileId);
    if (!file) {
      throw new AppError('File not found.', {
        statusCode: 404,
        code: 'learning_tool_not_found',
        publicMessage: 'File not found.',
      });
    }
    return file;
  }

  const fileName = trimString(params.fileName);
  if (!fileName) {
    throw new AppError('Provide fileId or fileName.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'Provide fileId or fileName.',
    });
  }

  const exact = await filesRepo.findByFileName(projectId, fileName);
  if (exact) return exact;

  const matches = await filesRepo.findByProjectFileHintsList(projectId, [fileName]);
  if (matches.length === 0) {
    throw new AppError('File not found.', {
      statusCode: 404,
      code: 'learning_tool_not_found',
      publicMessage: 'File not found.',
    });
  }

  if (matches.length > 1) {
    throw new AppError(`Multiple files matched "${fileName}". Use fileId for an exact match.`, {
      statusCode: 400,
      code: 'learning_tool_ambiguous_file',
      publicMessage: `Multiple files matched "${fileName}". Use fileId for an exact match.`,
    });
  }

  return matches[0]!;
}

async function buildFileDetail(projectId: string, fileId: string) {
  const file = await filesRepo.findByIdForProject(projectId, fileId);
  if (!file) {
    throw new AppError('File not found.', {
      statusCode: 404,
      code: 'learning_tool_not_found',
      publicMessage: 'File not found.',
    });
  }

  const [chunks, summaries] = await Promise.all([
    filesRepo.findChunksByFileId(file.id),
    filesRepo.findSummariesByFileId(file.id),
  ]);

  return {
    ...file,
    linkedChunkIds: chunks.map((chunk) => chunk.id),
    linkedSummaryIds: summaries.map((summary) => summary.id),
  };
}

function parseFindingActions(value: unknown): FindingAction[] | undefined {
  if (value === undefined) return undefined;

  if (!Array.isArray(value)) {
    throw new AppError('actions must be an array.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'actions must be an array.',
    });
  }

  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError(`actions[${index}] must be an object.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `actions[${index}] must be an object.`,
      });
    }

    const action = trimString((item as Record<string, unknown>).action);
    const targetType = trimString((item as Record<string, unknown>).targetType);
    const targetId = trimString((item as Record<string, unknown>).targetId);
    const updateText = trimString((item as Record<string, unknown>).updateText);

    if (!action || !targetType || !targetId) {
      throw new AppError(`actions[${index}] is missing action, targetType, or targetId.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `actions[${index}] is missing action, targetType, or targetId.`,
      });
    }

    if (action === 'done') {
      if (targetType !== 'finding') {
        throw new AppError(`actions[${index}] with action "done" must target a finding.`, {
          statusCode: 400,
          code: 'learning_tool_invalid_args',
          publicMessage: `actions[${index}] with action "done" must target a finding.`,
        });
      }

      return {
        action,
        targetType,
        targetId,
      } satisfies FindingAction;
    }

    if ((action !== 'delete' && action !== 'update') || (targetType !== 'chunk' && targetType !== 'summary' && targetType !== 'file')) {
      throw new AppError(`actions[${index}] is invalid.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `actions[${index}] is invalid.`,
      });
    }

    return {
      action,
      targetType,
      targetId,
      ...(updateText !== undefined ? { updateText } : {}),
    } satisfies FindingAction;
  });
}

function parseRelatedIds(value: unknown): RelatedIds | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('relatedIds must be an object.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'relatedIds must be an object.',
    });
  }

  const obj = value as Record<string, unknown>;
  return {
    chunkIds: parseOptionalStringArray(obj.chunkIds, 'relatedIds.chunkIds', 500) ?? [],
    summaryIds: parseOptionalStringArray(obj.summaryIds, 'relatedIds.summaryIds', 500) ?? [],
    findingIds: parseOptionalStringArray(obj.findingIds, 'relatedIds.findingIds', 500) ?? [],
  };
}

// ── Search & context-selection tools ───────────────────────────────────────

function clampSearchLimit(value: unknown): number {
  const parsed = parseNumber(value);
  if (parsed === undefined) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(parsed)));
}

/** Build a single-line snippet centred on the first match of `needle`. */
function buildSearchSnippet(text: string, needle?: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!needle) return singleLine.slice(0, SEARCH_SNIPPET_LENGTH);

  const index = singleLine.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return singleLine.slice(0, SEARCH_SNIPPET_LENGTH);

  const start = Math.max(0, index - Math.floor(SEARCH_SNIPPET_LENGTH / 3));
  const snippet = singleLine.slice(start, start + SEARCH_SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${snippet}${start + SEARCH_SNIPPET_LENGTH < singleLine.length ? '…' : ''}`;
}

/**
 * `ic_search_categories` — list categories across unsummarized chunks and
 * summaries with counts, plus quick (id + summary-only) matches for a specific
 * category. Full content is fetched separately via `ic_get_*`.
 */
async function searchCategories(projectId: string, params: Record<string, unknown>) {
  const category = trimString(params.category);
  const limit = clampSearchLimit(params.limit);
  const offset = clampOffset(params.offset);

  const [unsummarized, summaries] = await Promise.all([
    chunksRepo.findUnsummarized(projectId),
    summariesRepo.findByProject(projectId),
  ]);

  const summariesByCategory = new Map<string, Array<{ id: string; oneLineSummary: string; title: string; categories: string[] }>>();
  for (const summary of summaries) {
    const categories = parseCategoriesList(summary.categoriesList);
    for (const slug of categories) {
      const bucket = summariesByCategory.get(slug) ?? [];
      bucket.push({
        id: summary.id,
        oneLineSummary: summary.oneLineSummary,
        title: summary.title,
        categories,
      });
      summariesByCategory.set(slug, bucket);
    }
  }

  const chunksByCategory = new Map<string, { count: number; items: Array<{ id: string; fact: string }> }>();
  for (const chunk of unsummarized) {
    const slug = chunk.category || 'general';
    const bucket = chunksByCategory.get(slug) ?? { count: 0, items: [] };
    bucket.count++;
    bucket.items.push({ id: chunk.id, fact: chunk.fact });
    chunksByCategory.set(slug, bucket);
  }

  // Distinct category list for discovery (chunks + summary tags).
  const allCategories = new Set<string>([
    ...chunksByCategory.keys(),
    ...summariesByCategory.keys(),
  ]);

  const categories = [...allCategories].sort().map((slug) => ({
    category: slug,
    unsummarizedChunkCount: chunksByCategory.get(slug)?.count ?? 0,
    summaryCount: summariesByCategory.get(slug)?.length ?? 0,
  }));

  const result: Record<string, unknown> = { total: categories.length, categories };

  if (category) {
    const slug = category.toLowerCase();
    const chunkBucket = chunksByCategory.get(slug);
    const summaryBucket = summariesByCategory.get(slug) ?? [];
    const chunkItems = (chunkBucket?.items ?? []).map((chunk) => ({
      id: chunk.id,
      snippet: buildSearchSnippet(chunk.fact),
    }));

    result['category'] = {
      category: slug,
      unsummarizedChunkTotal: chunkItems.length,
      summaryTotal: summaryBucket.length,
      limit,
      offset,
      unsummarizedChunks: paginate(chunkItems, limit, offset),
      summaries: paginate(
        summaryBucket.map((summary) => ({
          id: summary.id,
          oneLineSummary: summary.oneLineSummary || summary.title,
          categories: summary.categories,
        })),
        limit,
        offset
      ),
    };
  }

  return result;
}

/**
 * `ic_search` — keyword or regex search over chunk facts and summary
 * one-line/title fields only (never full summary content, to avoid flooding).
 * Returns id + quick snippet so the model can probe with `ic_get_*`.
 */
async function searchKnowledge(projectId: string, params: Record<string, unknown>) {
  const query = trimString(params.query ?? params.search);
  if (!query) {
    throw new AppError('query is required.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'query is required.',
    });
  }

  const useRegex = parseBoolean(params.regex) === true;
  const scopes = new Set<string>(
    parseOptionalStringArray(params.scope, 'scope', 10)?.map((s) => s.toLowerCase())
      ?? ['chunks', 'summaries']
  );
  const limit = clampSearchLimit(params.limit);
  const offset = clampOffset(params.offset);

  let matcher: (text: string) => boolean;
  if (useRegex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, 'i');
    } catch (err) {
      throw new AppError(`Invalid regex: ${String(err)}`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `Invalid regex: ${String(err)}`,
      });
    }
    matcher = (text) => pattern.test(text);
  } else {
    const needle = query.toLowerCase();
    matcher = (text) => text.toLowerCase().includes(needle);
  }

  const chunkMatches: Array<{ id: string; category: string; confidence: number; summarized: boolean; snippet: string }> = [];
  const summaryMatches: Array<{ id: string; title: string; oneLineSummary: string; categories: string[]; snippet: string }> = [];

  if (scopes.has('chunks')) {
    const chunks = await chunksRepo.findAllForEmbedding(projectId);
    for (const chunk of chunks) {
      if (!matcher(chunk.fact)) continue;
      chunkMatches.push({
        id: chunk.id,
        category: chunk.category,
        confidence: chunk.confidence,
        summarized: chunk.summarized,
        snippet: buildSearchSnippet(chunk.fact, useRegex ? undefined : query),
      });
    }
  }

  if (scopes.has('summaries')) {
    const summaries = await summariesRepo.findByProject(projectId);
    for (const summary of summaries) {
      const haystack = `${summary.title}\n${summary.oneLineSummary}`;
      if (!matcher(haystack)) continue;
      summaryMatches.push({
        id: summary.id,
        title: summary.title,
        oneLineSummary: summary.oneLineSummary,
        categories: parseCategoriesList(summary.categoriesList),
        snippet: buildSearchSnippet(summary.oneLineSummary || summary.title, useRegex ? undefined : query),
      });
    }
  }

  return {
    query,
    regex: useRegex,
    scope: [...scopes],
    chunkTotal: chunkMatches.length,
    summaryTotal: summaryMatches.length,
    limit,
    offset,
    chunks: paginate(chunkMatches, limit, offset),
    summaries: paginate(summaryMatches, limit, offset),
  };
}

/**
 * `ic_select_context` — run the normal context-selection pipeline against a
 * free-text phrase and return the selected context blocks. Always runs the LLM
 * descriptor selector (bypassing the frontend request-context mode and the
 * item/token bypass thresholds) using the dedicated ic-tools model when set.
 */
async function selectContextForPhrase(projectId: string, params: Record<string, unknown>): Promise<unknown> {
  const text = trimString(params.text ?? params.query ?? params.phrase);
  if (!text) {
    throw new AppError('text is required.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'text is required.',
    });
  }

  const includeBlocks = parseBoolean(params.includeBlocks) === true;
  const model = trimString(params.model);

  const [{ resolveProviderAndModelForJob }, { selectContext }] = await Promise.all([
    import('../../proxy/upstream'),
    import('../../context/selector'),
  ]);

  let providerOverride: ResolvedProviderAndModel | undefined;
  if (model) {
    const execution = await resolveProviderAndModelForJob(model, 'openai');
    if (execution) {
      providerOverride = execution;
    } else {
      logger.warn('ic_select_context requested an unresolved model — falling back to configured ic model', {
        projectId,
        model,
      });
    }
  }

  if (!providerOverride) {
    const icToolsModel = getSystemModelConfig().icTools;
    if (icToolsModel) {
      const execution = await resolveProviderAndModelForJob(icToolsModel, 'openai');
      if (execution) providerOverride = execution;
    }
  }

  const messages: ChatMessage[] = [{ role: 'user', content: text }];
  const selection = await selectContext(
    projectId,
    messages,
    providerOverride?.model ?? 'unknown',
    `ic-select-context-${generateRunId()}`,
    undefined,
    undefined,
    { forceSelector: true, providerOverride },
  );

  const project = await projectsRepo.findById(projectId);
  const block = assembleContextMessage(selection.candidates, project?.name ?? 'Project');

  return {
    method: selection.method,
    latencyMs: selection.latencyMs,
    candidateCount: selection.candidates.length,
    estimatedTokens: block ? estimateTokens(block) : 0,
    candidates: selection.candidates.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      category: candidate.category,
      oneLineSummary: candidate.oneLineSummary,
      similarity: candidate.similarity,
      estimatedTokens: estimateTokens(candidate.fullContent ?? candidate.content),
    })),
    ...(includeBlocks && block ? { contextBlock: block } : {}),
  };
}

async function listChunks(projectId: string, params: Record<string, unknown>) {
  const totalProjectChunks = await chunksRepo.countByProject(projectId);
  const chunks = await chunksRepo.findByProject(projectId, {
    limit: Math.max(totalProjectChunks, 1),
    offset: 0,
  });

  const category = trimString(params.category)?.toLowerCase();
  const minConfidence = parseNumber(params.minConfidence);
  const summarized = parseBoolean(params.summarized);
  const search = trimString(params.search);
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const filtered = chunks.filter((chunk) => {
    if (category && chunk.category.toLowerCase() !== category) return false;
    if (minConfidence !== undefined && chunk.confidence < minConfidence) return false;
    if (summarized !== undefined && chunk.summarized !== summarized) return false;
    return matchesSearch([chunk.fact, chunk.source, chunk.category], search);
  });

  return {
    total: filtered.length,
    limit,
    offset,
    items: paginate(filtered, limit, offset).map((chunk) => ({
      id: chunk.id,
      fact: chunk.fact,
      category: chunk.category,
      confidence: chunk.confidence,
      source: chunk.source,
      summarized: chunk.summarized,
      createdAt: chunk.createdAt,
    })),
  };
}

async function listFiles(projectId: string, params: Record<string, unknown>) {
  const totalProjectFiles = await filesRepo.countByProject(projectId);
  const files = await filesRepo.findByProject(projectId, {
    limit: Math.max(totalProjectFiles, 1),
    offset: 0,
  });

  const search = trimString(params.search);
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const filtered = files.filter((file) => matchesSearch([
    file.fileName,
    file.purpose,
  ], search));

  return {
    total: filtered.length,
    limit,
    offset,
    items: paginate(filtered, limit, offset),
  };
}

async function getFile(projectId: string, params: Record<string, unknown>) {
  const file = await requireFile(projectId, params);
  return buildFileDetail(projectId, file.id);
}

async function getFileChunks(projectId: string, params: Record<string, unknown>) {
  const file = await requireFile(projectId, params);
  const chunks = await filesRepo.findChunksByFileId(file.id);
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);
  const pagedChunks = paginate(chunks, limit, offset);

  return {
    file: {
      id: file.id,
      fileName: file.fileName,
      purpose: file.purpose,
    },
    total: chunks.length,
    limit,
    offset,
    items: await Promise.all(pagedChunks.map((chunk) => buildChunkDetail(projectId, chunk.id))),
  };
}

async function getFileSummaries(projectId: string, params: Record<string, unknown>) {
  const file = await requireFile(projectId, params);
  const summaries = await filesRepo.findSummariesByFileId(file.id);
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);
  const pagedSummaries = paginate(summaries, limit, offset);

  return {
    file: {
      id: file.id,
      fileName: file.fileName,
      purpose: file.purpose,
    },
    total: summaries.length,
    limit,
    offset,
    items: pagedSummaries.map((summary) => buildSummaryDetail(summary)),
  };
}

async function listSummaries(projectId: string, params: Record<string, unknown>) {
  const summaries = await summariesRepo.findByProject(projectId);
  const category = trimString(params.category)?.toLowerCase();
  const search = trimString(params.search);
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const filtered = summaries.filter((summary) => {
    const categories = parseCategoriesList(summary.categoriesList);
    if (category && !categories.some((value) => value.toLowerCase() === category)) {
      return false;
    }

    return matchesSearch([
      summary.title,
      summary.oneLineSummary,
      summary.content,
      ...categories,
    ], search);
  });

  return {
    total: filtered.length,
    limit,
    offset,
    items: paginate(filtered, limit, offset).map((summary) => {
      const preview = buildPreview(summary.content);
      return {
        id: summary.id,
        title: summary.title,
        oneLineSummary: summary.oneLineSummary,
        categories: parseCategoriesList(summary.categoriesList),
        version: summary.version,
        contentPreview: preview.preview,
        truncated: preview.truncated,
        totalLength: preview.totalLength,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      };
    }),
  };
}

async function getChunksByCategory(projectId: string, params: Record<string, unknown>) {
  const category = requireId(params.category, 'category');
  const limit = Math.min(MAX_CATEGORY_CHUNK_LIMIT, clampLimit(params.limit));
  const offset = clampOffset(params.offset);
  const total = await chunksRepo.countByCategory(projectId, category);
  const chunks = await chunksRepo.findByCategory(projectId, category, { limit, offset });
  const chunkIds = chunks.map((chunk) => chunk.id);

  const [filesByChunk, codeExtractsByChunk] = chunkIds.length > 0
    ? await Promise.all([
      filesRepo.findByChunkIds(chunkIds),
      codeExtractsRepo.findByChunkIds(chunkIds),
    ])
    : [
      new Map<string, Awaited<ReturnType<typeof filesRepo.findByChunkId>>>(),
      new Map<string, Awaited<ReturnType<typeof codeExtractsRepo.findByChunkId>>>(),
    ];

  return {
    category,
    total,
    limit,
    offset,
    items: chunks.map((chunk) => ({
      ...chunk,
      files: filesByChunk.get(chunk.id) ?? [],
      codeExtracts: codeExtractsByChunk.get(chunk.id) ?? [],
    })),
  };
}

async function listFindings(projectId: string, params: Record<string, unknown>) {
  const findings = await findingsRepo.findByProject(projectId);
  const type = trimString(params.type)?.toLowerCase();
  const severity = trimString(params.severity)?.toLowerCase();
  const status = trimString(params.status)?.toLowerCase();
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);

  const filtered = findings.filter((finding) => {
    if (type && finding.type.toLowerCase() !== type) return false;
    if (severity && finding.severity.toLowerCase() !== severity) return false;
    if (status && finding.status.toLowerCase() !== status) return false;
    return true;
  });

  return {
    total: filtered.length,
    limit,
    offset,
    items: paginate(filtered, limit, offset).map((finding) => {
      const description = buildPreview(finding.description);
      return {
        id: finding.id,
        type: finding.type,
        severity: finding.severity,
        status: finding.status,
        title: finding.title,
        descriptionPreview: description.preview,
        truncated: description.truncated,
        totalLength: description.totalLength,
        relatedIds: finding.relatedIds,
        createdAt: finding.createdAt,
        reviewedAt: finding.reviewedAt,
        actionsAppliedAt: finding.actionsAppliedAt,
      };
    }),
  };
}

async function updateChunk(projectId: string, params: Record<string, unknown>) {
  const chunkId = requireId(params.chunkId, 'chunkId');
  await requireChunk(projectId, chunkId);

  const fact = trimString(params.fact);
  const category = trimString(params.category);
  const confidence = params.confidence === undefined
    ? undefined
    : requireConfidence(params.confidence, DEFAULT_CHUNK_CONFIDENCE);

  if (fact === undefined && category === undefined && confidence === undefined) {
    throw new AppError('Provide at least one field to update.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'Provide at least one field to update.',
    });
  }

  if (fact !== undefined) {
    await chunksRepo.updateFact(chunkId, fact);
  }
  if (category !== undefined) {
    await chunksRepo.updateCategory(chunkId, category);
  }
  if (confidence !== undefined) {
    await chunksRepo.updateConfidence(chunkId, confidence);
  }

  return buildChunkDetail(projectId, chunkId);
}

async function updateSummary(projectId: string, params: Record<string, unknown>) {
  const summaryId = requireId(params.summaryId, 'summaryId');
  await requireSummary(projectId, summaryId);

  const title = trimString(params.title);
  const content = trimString(params.content);
  const oneLineSummary = trimString(params.oneLineSummary);
  const categories = parseOptionalStringArray(params.categories, 'categories', 100);
  const sourceChunkIds = parseOptionalStringArray(params.sourceChunkIds, 'sourceChunkIds', 500);

  if (
    title === undefined &&
    content === undefined &&
    oneLineSummary === undefined &&
    categories === undefined &&
    sourceChunkIds === undefined
  ) {
    throw new AppError('Provide at least one summary field to update.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'Provide at least one summary field to update.',
    });
  }

  const updated = await summariesRepo.update(summaryId, {
    ...(title !== undefined ? { title } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(oneLineSummary !== undefined ? { oneLineSummary } : {}),
    ...(categories !== undefined ? { categoriesList: JSON.stringify(categories) } : {}),
    ...(sourceChunkIds !== undefined ? { sourceChunkIds } : {}),
  });

  return updated ? buildSummaryDetail(updated) : updated;
}

async function updateFinding(projectId: string, params: Record<string, unknown>) {
  const findingId = requireId(params.findingId, 'findingId');
  const finding = await requireFinding(projectId, findingId);
  const status = trimString(params.status) as FindingStatus | undefined;

  if (!status || !FINDING_STATUSES.has(status)) {
    throw new AppError('Status is invalid.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'Status is invalid.',
    });
  }

  if (status === 'implemented') {
    return implementFinding(findingId);
  }

  return findingsRepo.updateStatus(finding.id, status, {
    reviewedAt: new Date(),
    ...(status === 'actioned' ? { actionsAppliedAt: new Date() } : {}),
  });
}

async function createChunk(projectId: string, params: Record<string, unknown>) {
  const fact = trimString(params.fact);
  const category = trimString(params.category);

  if (!fact || !category) {
    throw new AppError('fact and category are required.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'fact and category are required.',
    });
  }

  const confidence = requireConfidence(params.confidence, DEFAULT_CHUNK_CONFIDENCE);
  const source = trimString(params.source) ?? 'tool';

  return chunksRepo.insert({
    projectId,
    fact,
    category,
    confidence,
    source,
    hash: hashFact(fact),
  });
}

async function createSummary(projectId: string, params: Record<string, unknown>) {
  const title = trimString(params.title);
  const content = trimString(params.content);

  if (!title || !content) {
    throw new AppError('title and content are required.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'title and content are required.',
    });
  }

  const oneLineSummary = trimString(params.oneLineSummary);
  const categories = parseOptionalStringArray(params.categories, 'categories', 100);
  const sourceChunkIds = parseOptionalStringArray(params.sourceChunkIds, 'sourceChunkIds', 500) ?? [];

  const summary = await summariesRepo.insert({
    projectId,
    title,
    content,
    ...(oneLineSummary !== undefined ? { oneLineSummary } : {}),
    ...(categories !== undefined ? { categoriesList: JSON.stringify(categories) } : {}),
    sourceChunkIds,
  });

  return buildSummaryDetail(summary);
}

interface RecordLearningFile {
  name: string;
  purpose?: string;
}

interface RecordLearningCodeExtract {
  fileName?: string;
  language?: string;
  symbols?: string[];
  code?: string;
}

interface RecordLearningEntry {
  fact: string;
  category: string;
  confidence: number;
  isNew: boolean;
  filesUsed?: RecordLearningFile[];
  codeExtracts?: RecordLearningCodeExtract[];
}

const MIN_CONFIDENCE = 0.1;
/**
 * Fallback when `context.maxRecordLearnings` is missing or invalid.
 * The effective value is read per call so YAML / Settings UI changes
 * take effect without a restart.
 */
const FALLBACK_MAX_RECORD_LEARNINGS = 200;

function maxRecordLearnings(): number {
  const configured = getEffectiveContextConfig().maxRecordLearnings;
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : FALLBACK_MAX_RECORD_LEARNINGS;
}

function parseRecordLearningFile(value: unknown, index: number, entryIndex: number): RecordLearningFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(`learnings[${entryIndex}].filesUsed[${index}] must be an object.`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `learnings[${entryIndex}].filesUsed[${index}] must be an object.`,
    });
  }

  const record = value as Record<string, unknown>;
  const name = trimString(record.name);
  if (!name) {
    throw new AppError(`learnings[${entryIndex}].filesUsed[${index}].name is required.`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `learnings[${entryIndex}].filesUsed[${index}].name is required.`,
    });
  }

  const purpose = trimString(record.purpose) ?? '';
  return { name, purpose };
}

function parseRecordLearningCodeExtract(
  value: unknown,
  index: number,
  entryIndex: number,
): RecordLearningCodeExtract | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(`learnings[${entryIndex}].codeExtracts[${index}] must be an object.`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `learnings[${entryIndex}].codeExtracts[${index}] must be an object.`,
    });
  }

  const record = value as Record<string, unknown>;
  const fileName = trimString(record.fileName) ?? '';
  const language = trimString(record.language) ?? '';
  const code = typeof record.code === 'string' ? record.code.trim() : '';
  const rawSymbols = Array.isArray(record.symbols) ? record.symbols : [];
  const symbols = [...new Set(rawSymbols
    .filter((symbol): symbol is string => typeof symbol === 'string')
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length > 0))];

  if (symbols.length === 0 && code.length === 0) {
    // Extracts with no symbols/code carry no provenance; drop them silently.
    return null;
  }

  return {
    ...(fileName ? { fileName } : {}),
    ...(language ? { language } : {}),
    ...(symbols.length > 0 ? { symbols } : {}),
    ...(code ? { code } : {}),
  };
}

function parseRecordLearningEntry(value: unknown, index: number): RecordLearningEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(`learnings[${index}] must be an object.`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `learnings[${index}] must be an object.`,
    });
  }

  const record = value as Record<string, unknown>;
  const fact = trimString(record.fact);
  const category = trimString(record.category);
  if (!fact || !category) {
    throw new AppError(`learnings[${index}] requires non-empty "fact" and "category".`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `learnings[${index}] requires non-empty "fact" and "category".`,
    });
  }

  const confidence = requireConfidence(record.confidence, 0.9);
  const isNew = parseBoolean(record.isNew) ?? true;

  let filesUsed: RecordLearningFile[] | undefined;
  if (record.filesUsed !== undefined) {
    if (!Array.isArray(record.filesUsed)) {
      throw new AppError(`learnings[${index}].filesUsed must be an array.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `learnings[${index}].filesUsed must be an array.`,
      });
    }
    filesUsed = record.filesUsed.map((item, fileIdx) => parseRecordLearningFile(item, fileIdx, index));
    if (filesUsed.length === 0) filesUsed = undefined;
  }

  let codeExtracts: RecordLearningCodeExtract[] | undefined;
  if (record.codeExtracts !== undefined) {
    if (!Array.isArray(record.codeExtracts)) {
      throw new AppError(`learnings[${index}].codeExtracts must be an array.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `learnings[${index}].codeExtracts must be an array.`,
      });
    }
    codeExtracts = record.codeExtracts
      .map((item, codeIdx) => parseRecordLearningCodeExtract(item, codeIdx, index))
      .filter((extract): extract is RecordLearningCodeExtract => extract !== null);
    if (codeExtracts.length === 0) codeExtracts = undefined;
  }

  return {
    fact,
    category,
    confidence,
    isNew,
    ...(filesUsed ? { filesUsed } : {}),
    ...(codeExtracts ? { codeExtracts } : {}),
  };
}

async function persistLearningPayload(
  projectId: string,
  entry: RecordLearningEntry,
  sessionId: string | undefined,
  requestId: string | undefined,
): Promise<{
  status: 'created' | 'updated' | 'skipped';
  chunk: Awaited<ReturnType<typeof chunksRepo.findByHash>>;
  previousConfidence?: number;
}> {
  const hash = hashFact(entry.fact);
  const existing = await chunksRepo.findByHash(projectId, hash);

  if (existing) {
    if (!entry.isNew) {
      // Refinement of an existing fact — update category/confidence if they changed.
      let changed = false;
      if (entry.category && entry.category !== existing.category) {
        await chunksRepo.updateCategory(existing.id, entry.category);
        changed = true;
      }
      if (entry.confidence > existing.confidence) {
        await chunksRepo.updateConfidence(existing.id, entry.confidence);
        changed = true;
      }
      if (!changed) {
        return { status: 'skipped', chunk: existing };
      }
      return { status: 'updated', chunk: await chunksRepo.findById(existing.id) };
    }

    // Duplicate "new" fact — only bump confidence if the new value is higher.
    if (entry.confidence > existing.confidence) {
      await chunksRepo.updateConfidence(existing.id, entry.confidence);
      return { status: 'updated', chunk: await chunksRepo.findById(existing.id) };
    }
    return { status: 'skipped', chunk: existing };
  }

  if (!entry.isNew) {
    // "Not new" but no existing match — surface as a no-op so the model
    // doesn't get a free pass to skip storing. The fact is still useful
    // even if the model thinks it knew it, so we insert anyway.
  }

  const chunk = await chunksRepo.insert({
    projectId,
    sessionId,
    requestId,
    fact: entry.fact,
    category: entry.category,
    confidence: entry.confidence,
    source: 'tool',
    hash,
  });

  if (entry.filesUsed && entry.filesUsed.length > 0) {
    await filesRepo.insertMany(
      entry.filesUsed.map((file) => ({
        chunkId: chunk.id,
        fileName: file.name,
        purpose: file.purpose ?? '',
      })),
    );
  }

  if (entry.codeExtracts && entry.codeExtracts.length > 0) {
    await codeExtractsRepo.insertMany(
      entry.codeExtracts.map((extract) => ({
        chunkId: chunk.id,
        fileName: extract.fileName,
        language: extract.language,
        symbols: extract.symbols,
        code: extract.code,
      })),
    );
  }

  // Best-effort category link so the chunk surfaces in the category tree.
  const category = await categoriesRepo.findCategoryBySlug(projectId, entry.category);
  if (category) {
    await categoriesRepo.assignToChunk(chunk.id, category.id, entry.confidence);
  }

  return { status: 'created', chunk };
}

/**
 * `record_learning` — model-driven equivalent of the old inline `[LEARN_START]…[LEARN_END]`
 * trailer. Accepts a list of facts and writes them through the normal chunk pipeline
 * (create + dedupe + files/codeExtracts + category link). The dedupe key is the same
 * fact-hash that background summarization uses, so a chunk produced here is
 * indistinguishable from a chunk produced by the worker pipeline.
 *
 * The per-call batch size is capped by `context.maxRecordLearnings` (default 200).
 * Oversized batches are NOT rejected — the first N entries are processed and the
 * result carries `truncated`/`dropped`/`hint` fields so the model can persist the
 * remainder in a follow-up call instead of losing it.
 */
async function recordLearning(
  projectId: string,
  sessionId: string | undefined,
  requestId: string | undefined,
  params: Record<string, unknown>,
) {
  const rawLearnings = params.learnings;
  if (!Array.isArray(rawLearnings) || rawLearnings.length === 0) {
    throw new AppError('learnings must be a non-empty array.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'learnings must be a non-empty array.',
    });
  }

  const cap = maxRecordLearnings();
  const truncated = rawLearnings.length > cap;
  const accepted = truncated ? rawLearnings.slice(0, cap) : rawLearnings;
  const dropped = rawLearnings.length - accepted.length;

  const entries = accepted.map((value, index) => parseRecordLearningEntry(value, index));

  const results: Array<{
    fact: string;
    category: string;
    status: 'created' | 'updated' | 'skipped';
    chunkId?: string;
    reason?: string;
  }> = [];

  for (const entry of entries) {
    if (entry.confidence < MIN_CONFIDENCE) {
      results.push({
        fact: entry.fact,
        category: entry.category,
        status: 'skipped',
        reason: 'confidence below threshold',
      });
      continue;
    }

    try {
      const persisted = await persistLearningPayload(projectId, entry, sessionId, requestId);
      results.push({
        fact: entry.fact,
        category: entry.category,
        status: persisted.status,
        ...(persisted.chunk?.id ? { chunkId: persisted.chunk.id } : {}),
      });
    } catch (err) {
      logger.error('record_learning: failed to persist entry', {
        error: err instanceof Error ? err.message : String(err),
        fact: entry.fact.slice(0, 100),
        projectId,
      });
      results.push({
        fact: entry.fact,
        category: entry.category,
        status: 'skipped',
        reason: err instanceof Error ? err.message : 'persistence failed',
      });
    }
  }

  return {
    requested: rawLearnings.length,
    created: results.filter((r) => r.status === 'created').length,
    updated: results.filter((r) => r.status === 'updated').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
    ...(truncated
      ? {
          truncated: true,
          processed: entries.length,
          dropped,
          hint: `Only the first ${cap} learnings were processed (cap: context.maxRecordLearnings = ${cap}). Call the ic tool with action "record" again to persist the remaining ${dropped} learning(s) from this batch.`,
        }
      : {}),
  };
}

async function createFinding(projectId: string, params: Record<string, unknown>) {
  const type = trimString(params.type);
  const severity = trimString(params.severity);
  const title = trimString(params.title);
  const description = trimString(params.description);

  if (!type || !severity || !title || !description) {
    throw new AppError('type, severity, title, and description are required.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'type, severity, title, and description are required.',
    });
  }

  return findingsRepo.insert({
    projectId,
    type,
    severity,
    title,
    description,
    relatedIds: parseRelatedIds(params.relatedIds),
    actions: parseFindingActions(params.actions),
    status: 'open',
  });
}

function requireIdArray(value: unknown, fieldName: string, maxItems = 50): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(`Missing required field: ${fieldName} (must be a non-empty array).`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `Missing required field: ${fieldName} (must be a non-empty array).`,
    });
  }

  if (value.length > maxItems) {
    throw new AppError(`${fieldName} must contain at most ${maxItems} items.`, {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: `${fieldName} must contain at most ${maxItems} items.`,
    });
  }

  const ids: string[] = [];
  for (const item of value) {
    const parsed = trimString(item);
    if (!parsed) {
      throw new AppError(`Each item in ${fieldName} must be a non-empty string.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `Each item in ${fieldName} must be a non-empty string.`,
      });
    }
    ids.push(parsed);
  }

  return [...new Set(ids)]; // deduplicate
}

async function getChunks(projectId: string, params: Record<string, unknown>) {
  const chunkIds = requireIdArray(params.chunkIds, 'chunkIds');

  const results = await Promise.allSettled(
    chunkIds.map(async (chunkId) => {
      const chunk = await requireChunk(projectId, chunkId);
      const [files, codeExtracts] = await Promise.all([
        filesRepo.findByChunkId(chunkId),
        codeExtractsRepo.findByChunkId(chunkId),
      ]);
      return { ...chunk, files, codeExtracts };
    })
  );

  return {
    items: results.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : { id: chunkIds[index], error: formatToolError(result.reason) }
    ),
  };
}

async function getSummaries(projectId: string, params: Record<string, unknown>) {
  const summaryIds = requireIdArray(params.summaryIds, 'summaryIds');

  const results = await Promise.allSettled(
    summaryIds.map(async (summaryId) => {
      const summary = await requireSummary(projectId, summaryId);
      return buildSummaryDetail(summary);
    })
  );

  return {
    items: results.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : { id: summaryIds[index], error: formatToolError(result.reason) }
    ),
  };
}

async function getFindings(projectId: string, params: Record<string, unknown>) {
  const findingIds = requireIdArray(params.findingIds, 'findingIds');

  const results = await Promise.allSettled(
    findingIds.map(async (findingId) => {
      return requireFinding(projectId, findingId);
    })
  );

  return {
    items: results.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : { id: findingIds[index], error: formatToolError(result.reason) }
    ),
  };
}

export interface ExecuteLearningToolOptions {
  projectId: string;
  sessionId?: string;
  requestId?: string;
}

export async function executeLearningTool(
  toolName: string,
  params: Record<string, unknown>,
  options: ExecuteLearningToolOptions | string,
  legacySessionId?: string,
  legacyRequestId?: string,
): Promise<LearningToolExecutionResult> {
  // Back-compat: existing callers pass `(toolName, params, projectId)`.
  // New callers pass `(toolName, params, { projectId, sessionId, requestId })`.
  let projectId: string;
  let sessionId: string | undefined;
  let requestId: string | undefined;

  if (typeof options === 'string') {
    projectId = options;
    sessionId = legacySessionId;
    requestId = legacyRequestId;
  } else {
    projectId = options.projectId;
    sessionId = options.sessionId;
    requestId = options.requestId;
  }

  logger.info('IC tool called', {
    tool: toolName,
    projectId,
    sessionId,
    requestId,
  });

  const startedAt = Date.now();
  let result: LearningToolExecutionResult;

  try {
    result = await dispatchIcToolCall(toolName, params, projectId, sessionId, requestId);
  } catch (error) {
    result = {
      success: false,
      result: null,
      error: formatToolError(error),
    };
  }

  // Always-recorded telemetry: one row per IC tool operation so retrieval,
  // learning, and mutation activity is visible in the management UI.
  recordIcToolStat({ toolName, params, projectId, sessionId, requestId, result, durationMs: Date.now() - startedAt });

  return result;
}

async function dispatchIcToolCall(
  toolName: string,
  params: Record<string, unknown>,
  projectId: string,
  sessionId: string | undefined,
  requestId: string | undefined,
): Promise<LearningToolExecutionResult> {
  switch (toolName) {
      case 'ic_list_categories':
        return { success: true, result: await searchCategories(projectId, params) };
      case 'ic_search':
        return { success: true, result: await searchKnowledge(projectId, params) };
      case 'ic_select_context':
        return { success: true, result: await selectContextForPhrase(projectId, params) };
      case 'ic_list_chunks':
        return { success: true, result: await listChunks(projectId, params) };
      case 'ic_list_summaries':
        return { success: true, result: await listSummaries(projectId, params) };
      case 'ic_list_findings':
        return { success: true, result: await listFindings(projectId, params) };
      case 'ic_list_files':
        return { success: true, result: await listFiles(projectId, params) };
      case 'ic_get_chunks_by_category':
        return { success: true, result: await getChunksByCategory(projectId, params) };
      case 'ic_get_chunk':
        return { success: true, result: await buildChunkDetail(projectId, requireId(params.chunkId, 'chunkId')) };
      case 'ic_get_summary': {
        const summaryId = requireId(params.summaryId, 'summaryId');
        const summary = await requireSummary(projectId, summaryId);
        return {
          success: true,
          result: buildSummaryDetail(summary),
        };
      }
      case 'ic_get_file_info': {
        return { success: true, result: await getFile(projectId, params) };
      }
      case 'ic_get_finding':
        return { success: true, result: await requireFinding(projectId, requireId(params.findingId, 'findingId')) };
      case 'ic_get_chunks':
        return { success: true, result: await getChunks(projectId, params) };
      case 'ic_get_summaries':
        return { success: true, result: await getSummaries(projectId, params) };
      case 'ic_get_file_chunks':
        return { success: true, result: await getFileChunks(projectId, params) };
      case 'ic_get_file_summaries':
        return { success: true, result: await getFileSummaries(projectId, params) };
      case 'ic_get_findings':
        return { success: true, result: await getFindings(projectId, params) };
      case 'ic_update_chunk':
        return { success: true, result: await updateChunk(projectId, params) };
      case 'ic_delete_chunk': {
        const chunkId = requireId(params.chunkId, 'chunkId');
        await requireChunk(projectId, chunkId);
        await chunksRepo.softDelete(chunkId);
        return { success: true, result: { deleted: true, chunkId } };
      }
      case 'ic_update_summary':
        return { success: true, result: await updateSummary(projectId, params) };
      case 'ic_delete_summary': {
        const summaryId = requireId(params.summaryId, 'summaryId');
        await requireSummary(projectId, summaryId);
        await summariesRepo.softDelete(summaryId);
        return { success: true, result: { deleted: true, summaryId } };
      }
      case 'ic_update_finding':
        return { success: true, result: await updateFinding(projectId, params) };
      case 'ic_create_finding':
        return { success: true, result: await createFinding(projectId, params) };
      case 'ic_create_chunk':
        return { success: true, result: await createChunk(projectId, params) };
      case 'ic':
        return { success: true, result: await executeIcOps(projectId, sessionId, requestId, params) };
      case 'record_learning':
        return { success: true, result: await recordLearning(projectId, sessionId, requestId, params) };
      default:
        return {
          success: false,
          result: null,
          error: `Unsupported learning tool: ${toolName}`,
        };
  }
}

// ── IC tool telemetry ──────────────────────────────────────────────────────
// Records one stats row per IC tool operation.  These rows are always
// recorded (regardless of IC_STATS_ENABLED) so the management UI can show
// which knowledge the model pulled in and what it recorded.

const IC_RETRIEVAL_TOOL_PREFIXES = ['ic_list_', 'ic_get_'];
const IC_WRITE_TOOL_PREFIXES = ['ic_create_', 'ic_update_', 'ic_delete_'];

interface IcStatTarget {
  type: string;
  action: string;
  dataType?: string;
  ids?: string[];
}

function statTypeForIcAction(action: string): string {
  switch (action) {
    case 'get':
    case 'list':
      return 'ic_retrieval';
    case 'record':
      return 'ic_record_learning';
    case 'create':
    case 'update':
    case 'delete':
      return 'ic_write';
    default:
      return 'ic_tool';
  }
}

function statTypeForIcToolName(toolName: string): string {
  if (toolName === 'record_learning') return 'ic_record_learning';
  if (IC_RETRIEVAL_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return 'ic_retrieval';
  if (IC_WRITE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return 'ic_write';
  return 'ic_tool';
}

function normalizeStatIds(op: Record<string, unknown>): string[] | undefined {
  const raw = op.ids ?? op.id;
  if (Array.isArray(raw)) {
    const ids = raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return [raw];
  }
  return undefined;
}

function classifyIcToolCall(toolName: string, params: Record<string, unknown>): IcStatTarget[] {
  // The consolidated `ic` tool carries an `ops` array; emit one target per op
  // so retrieval and learning calls are recorded distinctly.
  if (toolName === 'ic' && Array.isArray(params.ops)) {
    const targets = params.ops.flatMap<IcStatTarget>((rawOp) => {
      if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) return [];
      const op = rawOp as Record<string, unknown>;
      const action = typeof op.action === 'string' ? op.action : 'unknown';
      const dataType = typeof op.type === 'string' ? op.type : undefined;
      return [{
        type: statTypeForIcAction(action),
        action,
        ...(dataType ? { dataType } : {}),
        ...(normalizeStatIds(op) ? { ids: normalizeStatIds(op) } : {}),
      }];
    });

    if (targets.length > 0) return targets;
  }

  return [{ type: statTypeForIcToolName(toolName), action: toolName }];
}

function recordIcToolStat(input: {
  toolName: string;
  params: Record<string, unknown>;
  projectId: string;
  sessionId?: string;
  requestId?: string;
  result: LearningToolExecutionResult;
  durationMs: number;
}): void {
  const { toolName, params, projectId, sessionId, requestId, result, durationMs } = input;

  const targets = classifyIcToolCall(toolName, params);

  // Per-op results for the consolidated `ic` tool mirror the op order.
  const opResults = toolName === 'ic'
    && result.result
    && typeof result.result === 'object'
    && Array.isArray((result.result as { ops?: unknown }).ops)
      ? (result.result as { ops: Array<{ success?: boolean; error?: string }> }).ops
      : undefined;

  const runId = requestId ?? generateRunId();

  targets.forEach((target, index) => {
    const opResult = opResults?.[index];
    const success = opResult ? opResult.success === true : result.success;
    const error = opResult?.error ?? result.error;

    recordStat({
      projectId,
      sessionId,
      requestId,
      model: 'ic-tool',
      runId,
      type: target.type,
      direction: 'output',
      meta: {
        tool: toolName,
        action: target.action,
        ...(target.dataType ? { dataType: target.dataType } : {}),
        ...(target.ids ? { ids: target.ids.slice(0, 10) } : {}),
        success,
        durationMs,
        ...(success || !error ? {} : { error }),
      },
    });
  });
}

// ── Single `ic` tool ops dispatcher ──

interface IcOp {
  action: string;
  type?: string;
  ids?: string | string[];
  id?: string;
  data?: Record<string, unknown>;
}

function parseIcOps(params: Record<string, unknown>): IcOp[] {
  const raw = params.ops;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError('ops must be a non-empty array.', {
      statusCode: 400,
      code: 'learning_tool_invalid_args',
      publicMessage: 'ops must be a non-empty array.',
    });
  }

  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError(`ops[${i}] must be an object.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `ops[${i}] must be an object.`,
      });
    }
    const op = entry as Record<string, unknown>;
    const action = trimString(op.action);
    if (!action) {
      throw new AppError(`ops[${i}].action is required.`, {
        statusCode: 400,
        code: 'learning_tool_invalid_args',
        publicMessage: `ops[${i}].action is required.`,
      });
    }
    const rawIds = op.ids;
    const resolvedIds: string | string[] | undefined = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === 'string')
      : typeof rawIds === 'string'
        ? rawIds
        : undefined;

    return {
      action,
      type: trimString(op.type),
      ids: resolvedIds,
      id: trimString(op.id),
      data: op.data && typeof op.data === 'object' && !Array.isArray(op.data)
        ? (op.data as Record<string, unknown>)
        : undefined,
    };
  });
}

async function executeIcOps(
  projectId: string,
  sessionId: string | undefined,
  requestId: string | undefined,
  params: Record<string, unknown>,
): Promise<{ ops: Array<{ action: string; type?: string; success: boolean; result: unknown; error?: string }> }> {
  const ops = parseIcOps(params);
  const results: Array<{ action: string; type?: string; success: boolean; result: unknown; error?: string }> = [];

  for (const op of ops) {
    try {
      switch (op.action) {
        case 'get': {
          const ids = resolveIds(op);
          if (!ids || ids.length === 0) {
            results.push({ action: 'get', type: op.type, success: false, result: null, error: 'No ids provided.' });
            continue;
          }
          if (ids.length === 1 && useSingleGet(op.type)) {
            results.push({ action: 'get', type: op.type, success: true, result: await dispatchSingleGet(projectId, op.type!, ids[0]!) });
          } else {
            results.push({ action: 'get', type: op.type, success: true, result: await dispatchMultiGet(projectId, op.type!, ids) });
          }
          continue;
        }
        case 'list': {
          const listParams = { ...(op.data ?? {}) };
          results.push({ action: 'list', type: op.type, success: true, result: await dispatchList(projectId, op.type, listParams) });
          continue;
        }
        case 'create': {
          const createParams = { ...(op.data ?? {}) };
          results.push({ action: 'create', type: op.type, success: true, result: await dispatchCreate(projectId, op.type, createParams) });
          continue;
        }
        case 'update': {
          if (!op.id) {
            results.push({ action: 'update', type: op.type, success: false, result: null, error: 'id is required for update.' });
            continue;
          }
          const updateParams = { ...(op.data ?? {}), [`${op.type}Id`]: op.id };
          if (op.type === 'finding') {
            const status = trimString(op.data?.status);
            results.push({ action: 'update', type: 'finding', success: true, result: await updateFinding(projectId, { ...updateParams, status }) });
          } else if (op.type === 'chunk') {
            results.push({ action: 'update', type: 'chunk', success: true, result: await updateChunk(projectId, updateParams) });
          } else if (op.type === 'summary') {
            results.push({ action: 'update', type: 'summary', success: true, result: await updateSummary(projectId, updateParams) });
          } else {
            results.push({ action: 'update', type: op.type, success: false, result: null, error: `Unsupported type for update: ${op.type}` });
          }
          continue;
        }
        case 'delete': {
          if (!op.id) {
            results.push({ action: 'delete', type: op.type, success: false, result: null, error: 'id is required for delete.' });
            continue;
          }
          if (op.type === 'chunk') {
            const chunkId = op.id;
            await requireChunk(projectId, chunkId);
            await chunksRepo.softDelete(chunkId);
            results.push({ action: 'delete', type: 'chunk', success: true, result: { deleted: true, chunkId } });
          } else if (op.type === 'summary') {
            const summaryId = op.id;
            await requireSummary(projectId, summaryId);
            await summariesRepo.softDelete(summaryId);
            results.push({ action: 'delete', type: 'summary', success: true, result: { deleted: true, summaryId } });
          } else {
            results.push({ action: 'delete', type: op.type, success: false, result: null, error: `Unsupported type for delete: ${op.type}` });
          }
          continue;
        }
        case 'record': {
          const recordParams = { learnings: op.data?.learnings ?? [] };
          results.push({ action: 'record', success: true, result: await recordLearning(projectId, sessionId, requestId, recordParams) });
          continue;
        }
        default:
          results.push({ action: op.action, type: op.type, success: false, result: null, error: `Unsupported action: ${op.action}` });
      }
    } catch (err) {
      results.push({ action: op.action, type: op.type, success: false, result: null, error: formatToolError(err) });
    }
  }

  return { ops: results };
}

function resolveIds(op: IcOp): string[] | undefined {
  const rawIds = op.ids ?? op.id;
  if (!rawIds) return undefined;
  if (typeof rawIds === 'string') return [rawIds];
  if (Array.isArray(rawIds)) return rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  return undefined;
}

function useSingleGet(type?: string): boolean {
  return type !== 'file';
}

async function dispatchSingleGet(projectId: string, type: string, id: string): Promise<unknown> {
  switch (type) {
    case 'chunk': return buildChunkDetail(projectId, id);
    case 'summary': return buildSummaryDetail(await requireSummary(projectId, id));
    case 'finding': return requireFinding(projectId, id);
    case 'file': return buildFileDetail(projectId, id);
    default: throw new AppError(`Unsupported get type: ${type}`, {
      statusCode: 400, code: 'learning_tool_invalid_args',
      publicMessage: `Unsupported type: ${type}`,
    });
  }
}

async function dispatchMultiGet(projectId: string, type: string, ids: string[]): Promise<unknown> {
  switch (type) {
    case 'chunk': return getChunks(projectId, { chunkIds: ids });
    case 'summary': return getSummaries(projectId, { summaryIds: ids });
    case 'finding': return getFindings(projectId, { findingIds: ids });
    default: throw new AppError(`Unsupported get type: ${type}`, {
      statusCode: 400, code: 'learning_tool_invalid_args',
      publicMessage: `Unsupported type: ${type}`,
    });
  }
}

async function dispatchList(projectId: string, type: string | undefined, params: Record<string, unknown>): Promise<unknown> {
  switch (type) {
    case 'chunk': return listChunks(projectId, params);
    case 'summary': return listSummaries(projectId, params);
    case 'finding': return listFindings(projectId, params);
    case 'file': return listFiles(projectId, params);
    default: throw new AppError(`Unsupported list type: ${type}`, {
      statusCode: 400, code: 'learning_tool_invalid_args',
      publicMessage: `Unsupported type: ${type}`,
    });
  }
}

async function dispatchCreate(projectId: string, type: string | undefined, params: Record<string, unknown>): Promise<unknown> {
  switch (type) {
    case 'chunk': return createChunk(projectId, params);
    case 'summary': return createSummary(projectId, params);
    case 'finding': return createFinding(projectId, params);
    default: throw new AppError(`Unsupported create type: ${type}`, {
      statusCode: 400, code: 'learning_tool_invalid_args',
      publicMessage: `Unsupported type: ${type}`,
    });
  }
}