import axios from 'axios';
import { chunksRepo } from '../db/repositories/chunks';
import { findingsRepo } from '../db/repositories/findings';
import { summariesRepo } from '../db/repositories/summaries';
import { filesRepo } from '../db/repositories/files';
import { codeExtractsRepo } from '../db/repositories/codeExtracts';
import { selectionsRepo } from '../db/repositories/selections';
import { embeddingsRepo } from '../db/repositories/embeddings';
import { fillBudget, computeContextBudget, estimateCandidateInjectionTokens, modelMaxTokens } from './budget';
import { estimateTokens } from '../utils/tokens';
import { cosineSimilarity } from '../utils/similarity';
import { getEffectiveContextConfig } from '../config/configOverrides';
import { getSystemModelConfig } from '../config/systemModels';
import { resolveProviderAndModelForJob } from '../proxy/upstream';
import { openaiAdapter } from '../proxy/adapters/openai';
import { logger } from '../utils/logger';
import { recordStat, generateRunId } from '../utils/stats';
import { renderTocPrefix } from './toc';
import { renderCompactSummaryContext } from './summaryInjection';
import type { Adapter, ChatMessage, ProxyRequest } from '../proxy/adapters/adapter';
import { contentToText } from '../utils/messageContent';
import { withParamFallback } from '../utils/paramFallback';
import { applyUpstreamRequestMiddleware } from '../proxy/requestMiddleware';

export interface ContextCandidate {
  id: string;
  type: 'chunk' | 'summary' | 'finding';
  /** Lightweight content used for context selection (one-line summary + categories) */
  content: string;
  /** Full content injected into the main model when this candidate is selected */
  fullContent: string;
  compactContent?: string;
  category?: string;
  /** All categories for category-match boosting (domain-specific + generic) */
  categories: string[];
  similarity: number;
  guaranteed?: boolean;
  createdAt?: string;
  updatedAt?: string;
  oneLineSummary?: string;
  [key: string]: unknown;
}

export interface SelectionResult {
  candidates: ContextCandidate[];
  method: string;
  latencyMs: number;
}

export interface ContextSelectionOverrides {
  /**
   * Run the LLM descriptor selector even when the item/token bypass
   * thresholds would normally skip it. Used by the explicit
   * `ic_select_context` tool so a model can always trigger selection.
   */
  forceSelector?: boolean;
  /**
   * Resolved provider/model to use for the descriptor selection instead of
   * the configured `contextSelector` system model.
   */
  providerOverride?: ResolvedProviderAndModel;
}

/** Minimal shape of a resolved provider/model execution. */
export interface ResolvedProviderAndModel {
  adapter: Adapter;
  baseUrl: string;
  apiKey: string;
  providerName: string;
  providerType: string;
  model: string;
}

export interface GathererSummaryDescriptor {
  id: string;
  oneLineSummary: string;
  previewBullets?: string[];
  categories: string[];
  createdAt?: string;
  updatedAt?: string;
  priority: 'file-linked' | 'global' | 'candidate';
  linkedFileIds: string[];
}

export interface GathererFileDescriptor {
  id: string;
  fileName: string;
  purpose: string;
  chunkCount: number;
  summaryCount: number;
  linkedSummaryIds: string[];
}

export interface GathererCategoryDescriptor {
  id: string;
  chunkCount: number;
  newestChunkCreatedAt?: string;
  oldestChunkCreatedAt?: string;
}

export interface GathererFindingDescriptor {
  id: string;
  title: string;
  severity?: string;
}

export interface GathererContextSelection {
  queryText: string;
  referencedFiles: GathererFileDescriptor[];
  prioritySummaryIds: string[];
  summaryDescriptors: GathererSummaryDescriptor[];
  unsummarizedCategories: GathererCategoryDescriptor[];
  relevantFindings: GathererFindingDescriptor[];
  shouldRefreshSummaries: boolean;
  summaryRefreshReasons: string[];
}

interface SummarySelectionEntry {
  id: string;
  candidate: ContextCandidate;
  heuristicText: string;
}

interface CategorySelectionEntry {
  id: string;
  candidates: ContextCandidate[];
  selectorContent: string;
  heuristicText: string;
  newestChunkCreatedAt?: string;
  oldestChunkCreatedAt?: string;
}

type TimestampValue = string | Date | null | undefined;

interface PreparedContextPool {
  guaranteedCandidates: ContextCandidate[];
  globalSummaryCandidates: ContextCandidate[];
  matchedFindingCandidates: ContextCandidate[];
  summaryEntries: SummarySelectionEntry[];
  categoryEntries: CategorySelectionEntry[];
}

interface DescriptorSelectionIds {
  summaryIds: string[];
  categoryIds: string[];
  method: string;
}

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: split on whitespace/punctuation, filter stop words
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
    'could', 'may', 'might', 'this', 'that', 'these', 'those', 'i', 'you',
    'he', 'she', 'it', 'we', 'they', 'what', 'how', 'why', 'when', 'where',
    'can', 'please', 'just', 'my', 'your', 'its', 'our',
  ]);

  return text
    .toLowerCase()
    .split(/[\s\W]+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 30);
}

function parseCategoriesList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c: unknown) => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

// ── Query-text extraction ────────────────────────────────────────────────────

/**
 * Known XML wrappers that contain the user's actual request.
 * Ordered by specificity — first match wins.
 */
const KNOWN_REQUEST_TAGS = [
  'userRequest',
  'user_request',
  'query',
  'prompt',
  'user_query',
  'user_prompt',
  'request',
  'userInput',
  'user_input',
];

/**
 * Extract the inner text of an XML tag from a string.
 * Handles multi-line content and optional attributes on the opening tag.
 *
 * Uses a two-pass strategy:
 * 1. Fast regex for the common case (works for 99 % of messages).
 * 2. Depth-counting fallback when the regex result looks suspicious
 *    (e.g. the extracted content itself contains `<tagName` — a sign
 *    the lazy regex stopped too early because `</tagName>` appeared
 *    inside the user's actual request text).
 */
function extractXmlContent(text: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = text.match(re);
  if (match && match[1].trim().length > 0) {
    const inner = match[1].trim();
    // If the extracted content contains an opening tag with the same
    // name it likely means the lazy regex stopped at a premature close
    // tag inside the user's request. Fall through to depth counting.
    const nestedOpen = new RegExp(`<${tagName}[\\s>]`, 'i');
    if (!nestedOpen.test(inner)) return inner;
  }

  // Depth-counting fallback — walks opening/closing tags to find the
  // correct matching pair, handling cases where the tag name appears
  // inside the content (e.g. the user is asking about the tag itself).
  const openRe = new RegExp(`<${tagName}[^>]*>`, 'gi');
  const closeRe = new RegExp(`<\\/${tagName}>`, 'gi');

  const positions: Array<{ index: number; isOpen: boolean }> = [];
  let m: RegExpExecArray | null;

  openRe.lastIndex = 0;
  while ((m = openRe.exec(text)) !== null) {
    positions.push({ index: m.index, isOpen: true });
  }
  closeRe.lastIndex = 0;
  while ((m = closeRe.exec(text)) !== null) {
    positions.push({ index: m.index, isOpen: false });
  }

  positions.sort((a, b) => a.index - b.index);

  let depth = 0;
  let startIndex = -1;
  for (const pos of positions) {
    if (pos.isOpen) {
      if (depth === 0) startIndex = pos.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && startIndex >= 0) {
        const openTagEnd = text.indexOf('>', startIndex) + 1;
        const content = text.slice(openTagEnd, pos.index).trim();
        return content.length > 0 ? content : null;
      }
    }
  }

  return null;
}

/**
 * Known IDE message boilerplate XML blocks to strip before fallback
 * text extraction. Removing these leaves mostly the user's actual
 * request, making the tail-slice heuristic far more accurate.
 */
const BOILERPLATE_BLOCK_TAGS = [
  'environment_info',
  'workspace_info',
  'attachments',
  'userMemory',
  'sessionMemory',
  'repoMemory',
  'memoryInstructions',
  'memoryScopes',
  'memoryGuidelines',
  'project_context',
  'editorContext',
  'reminderInstructions',
  'instructions',
  'outputFormatting',
  'toolUseInstructions',
  'skills',
  'agents',
  // <context> is intentionally omitted — it is both an XML block
  // and a common English word; stripping it eagerly can mangle
  // legitimate query text like "provide context about X".
];

/**
 * Strip known IDE message boilerplate XML blocks from text.
 * After removing these blocks the remaining text is predominantly the
 * user's actual request, making fallback extraction much more accurate
 * than blindly slicing the last 3 000 characters.
 */
function stripBoilerplateBlocks(text: string): string {
  let result = text;
  // Iterate until stable — some blocks may contain nested blocks
  // that only become matchable after an outer pass.
  let prev = '';
  while (prev !== result) {
    prev = result;
    for (const block of BOILERPLATE_BLOCK_TAGS) {
      const re = new RegExp(`<${block}[^>]*>[\\s\\S]*?<\\/${block}>`, 'gi');
      result = result.replace(re, '');
    }
  }
  return result.trim();
}

/**
 * Build the query text used for context selection.
 *
 * 1. Extract content from known request wrappers (e.g. `<userRequest>`) in
 *    the last user message — this is the most reliable signal.
 * 2. If no wrapper matches but the last message is short enough, use it whole.
 * 3. If no wrapper matches and the message is long, strip known IDE boilerplate
 *    blocks (workspace info, attachments, memory blocks) and take the tail of
 *    what remains. This is much more accurate than the old blind tail-slice
 *    which would pick up attachment content when the user's query was at the
 *    top of the message.
 * 4. Fallback: raw tail-slice of the original message.
 * 5. Absolute fallback: concatenate last-3 user messages, capped at 2 000 chars.
 */
export function extractQueryText(messages: ChatMessage[]): string {
  const userTexts = messages
    .filter((m) => m.role === 'user')
    .map((m) => contentToText(m.content));

  if (userTexts.length === 0) return '';

  const lastIdx = userTexts.length - 1;
  const lastText = userTexts[lastIdx];

  // 1. Known wrapper extraction on the last message
  for (const tag of KNOWN_REQUEST_TAGS) {
    const extracted = extractXmlContent(lastText, tag);
    if (extracted) return extracted;
  }

  // 2. Last message is short enough — use it whole
  if (lastText.length <= 3_000) return lastText;

  // 3. Strip boilerplate blocks, then take the tail of what remains.
  //    IDE messages are dominated by workspace/environment/attachment
  //    XML. Removing those first leaves the user's actual request so
  //    the tail-slice lands on meaningful text.
  const stripped = stripBoilerplateBlocks(lastText);
  if (stripped.length > 0) {
    if (stripped.length <= 3_000) return stripped;
    const tail = stripped.slice(-3_000).trim();
    if (tail.length > 0) return tail;
  }

  // 4. Fallback: raw tail of the original message (boilerplate
  //    stripping may have been too aggressive and removed everything).
  const rawTail = lastText.slice(-3_000).trim();
  if (rawTail.length > 0) return rawTail;

  // 5. Absolute fallback (shouldn't normally be reached)
  return userTexts.slice(-3).join('\n').slice(0, 2_000);
}

// ── File-path extraction for guaranteed context ──────────────────────────────

function extractReferencedFilePaths(messages: ChatMessage[]): string[] {
  const results = new Set<string>();
  const pathRe = /(?:[a-zA-Z]:[\\/]|\/|\.\.?[\\/])\S+/g;

  function visit(value: unknown, seen: Set<unknown>): void {
    if (value == null) return;

    if (typeof value === 'string') {
      for (const match of value.matchAll(pathRe)) {
        const trimmed = match[0].replace(/[,;)}\]]+$/, '').replace(/^['"]+|['"]+$/g, '');
        if (trimmed.length > 0) results.add(trimmed);
      }
      return;
    }

    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, seen);
      return;
    }

    for (const nested of Object.values(value as Record<string, unknown>)) {
      visit(nested, seen);
    }
  }

  for (const message of messages) {
    if (message.role !== 'user') continue;
    visit(message.content, new Set<unknown>());
  }

  return [...results];
}

async function prepareContextPool(
  projectId: string,
  requestMessages: ChatMessage[],
  queryText: string
): Promise<PreparedContextPool> {
  const queryKeywords = extractKeywords(queryText);
  const [unsummarizedResult, summariesResult, gapFindingsResult] = await Promise.allSettled([
    chunksRepo.findUnsummarized(projectId, { newestFirst: true }),
    summariesRepo.findByProject(projectId),
    findingsRepo.findOpenGapsByProject(projectId),
  ]);

  if (unsummarizedResult.status === 'rejected') {
    logger.warn('Failed to fetch unsummarized chunks', { projectId, error: String(unsummarizedResult.reason) });
  }
  if (summariesResult.status === 'rejected') {
    logger.warn('Failed to fetch summaries', { projectId, error: String(summariesResult.reason) });
  }
  if (gapFindingsResult.status === 'rejected') {
    logger.warn('Failed to fetch gap findings', { projectId, error: String(gapFindingsResult.reason) });
  }

  const unsummarizedChunks = unsummarizedResult.status === 'fulfilled' ? unsummarizedResult.value : [];
  const summaries = summariesResult.status === 'fulfilled' ? summariesResult.value : [];
  const gapFindings = gapFindingsResult.status === 'fulfilled' ? gapFindingsResult.value : [];
  const unsummarizedChunkIds = unsummarizedChunks.map((chunk) => chunk.id);
  const unsummarizedFilesByChunk = unsummarizedChunkIds.length > 0
    ? await filesRepo.findByChunkIds(unsummarizedChunkIds)
    : new Map();

  const referencedPaths = extractReferencedFilePaths(requestMessages);
  const matchedFiles = referencedPaths.length > 0
    ? await filesRepo.findByProjectFileHintsList(projectId, referencedPaths)
    : [];
  const matchedFileIds = matchedFiles.map((file) => file.id);
  const summariesByFile = matchedFileIds.length > 0
    ? await filesRepo.findSummariesByFileIds(matchedFileIds)
    : new Map();

  const guaranteedSummaryCandidates = new Map<string, ContextCandidate>();
  const fileIdsWithSummaryCoverage: string[] = [];

  for (const file of matchedFiles) {
    const linkedSummaries = summariesByFile.get(file.id) ?? [];
    if (linkedSummaries.length === 0) continue;

    fileIdsWithSummaryCoverage.push(file.id);
    for (const summary of linkedSummaries) {
      if (guaranteedSummaryCandidates.has(summary.id)) continue;
      guaranteedSummaryCandidates.set(
        summary.id,
        buildSummaryCandidate(summary, { guaranteed: true, similarity: 1 })
      );
    }
  }

  const suppressedChunksByCoveredFile = fileIdsWithSummaryCoverage.length > 0
    ? await filesRepo.findChunksByFileIds(fileIdsWithSummaryCoverage)
    : new Map();
  const suppressedChunkIds = new Set<string>();
  for (const chunks of suppressedChunksByCoveredFile.values()) {
    for (const chunk of chunks) suppressedChunkIds.add(chunk.id);
  }

  const fallbackFileIds = matchedFiles
    .filter((file) => (summariesByFile.get(file.id) ?? []).length === 0)
    .map((file) => file.id);
  const fallbackChunksByFile = fallbackFileIds.length > 0
    ? await filesRepo.findChunksByFileIds(fallbackFileIds)
    : new Map();
  const guaranteedChunkIds = [...new Set(
    [...fallbackChunksByFile.values()].flatMap((chunks) => chunks.map((chunk: { id: string }) => chunk.id))
  )];

  const codeExtractChunkIds = [...new Set([...unsummarizedChunkIds, ...guaranteedChunkIds])];
  const codeExtractsByChunk = codeExtractChunkIds.length > 0
    ? await codeExtractsRepo.findByChunkIds(codeExtractChunkIds)
    : new Map();
  const guaranteedChunks = guaranteedChunkIds.length > 0
    ? await chunksRepo.findByIds(guaranteedChunkIds)
    : [];
  const guaranteedFilesByChunk = guaranteedChunkIds.length > 0
    ? await filesRepo.findByChunkIds(guaranteedChunkIds)
    : new Map();

  const guaranteedCandidates = [
    ...guaranteedSummaryCandidates.values(),
    ...guaranteedChunks.map((chunk) =>
      buildChunkCandidate(
        chunk,
        guaranteedFilesByChunk.get(chunk.id) ?? unsummarizedFilesByChunk.get(chunk.id) ?? [],
        codeExtractsByChunk.get(chunk.id) ?? [],
        1,
        {
          guaranteed: true,
        }
      )
    ),
  ];
  const guaranteedChunkIdSet = new Set(
    guaranteedCandidates
      .filter((candidate) => candidate.type === 'chunk')
      .map((candidate) => candidate.id)
  );

  const categoryBuckets = new Map<string, ContextCandidate[]>();
  for (const chunk of unsummarizedChunks) {
    if (guaranteedChunkIdSet.has(chunk.id) || suppressedChunkIds.has(chunk.id)) continue;
    if (!chunk.category || chunk.category === 'global') continue;

    const bucket = categoryBuckets.get(chunk.category) ?? [];
    bucket.push(buildChunkCandidate(
      chunk,
      unsummarizedFilesByChunk.get(chunk.id) ?? [],
      codeExtractsByChunk.get(chunk.id) ?? [],
      0.35
    ));
    categoryBuckets.set(chunk.category, bucket);
  }

  const categoryEntries = [...categoryBuckets.entries()]
    .map(([categoryId, candidates]) => ({
      id: categoryId,
      candidates,
      selectorContent: `${categoryId} (${candidates.length} unsummarized learnings)`,
      heuristicText: `${categoryId}\n${candidates.map((candidate) => candidate.content).join('\n')}`,
      newestChunkCreatedAt: getNewestTimestamp(candidates.map((candidate) => candidate.createdAt)),
      oldestChunkCreatedAt: getOldestTimestamp(candidates.map((candidate) => candidate.createdAt)),
    }))
    .sort((left, right) => (
      compareTimestampsDesc(left.newestChunkCreatedAt, right.newestChunkCreatedAt) ||
      left.id.localeCompare(right.id)
    ));

  const globalSummaryCandidates: ContextCandidate[] = [];
  const summaryEntries: SummarySelectionEntry[] = [];

  for (const summary of summaries) {
    const candidate = buildSummaryCandidate(summary);
    if (candidate.categories.includes('global')) {
      globalSummaryCandidates.push(candidate);
      continue;
    }

    summaryEntries.push({
      id: summary.id,
      candidate,
      heuristicText: `${candidate.content}\n${candidate.fullContent}`,
    });
  }

  const matchedFindingCandidates = gapFindings.flatMap((finding) => {
    const score = scoreKeywordMatches(`${finding.title}\n${finding.description}`, queryKeywords);
    return score > 0 ? [buildGapFindingCandidate(finding, 0.6 + score * 0.1)] : [];
  });

  return {
    guaranteedCandidates,
    globalSummaryCandidates,
    matchedFindingCandidates,
    summaryEntries,
    categoryEntries,
  };
}

export async function prepareGathererContextSelection(
  projectId: string,
  requestMessages: ChatMessage[],
): Promise<GathererContextSelection | null> {
  const queryText = extractQueryText(requestMessages).trim();
  if (!queryText) return null;

  const queryKeywords = extractKeywords(queryText);
  const [unsummarizedResult, summariesResult, gapFindingsResult] = await Promise.allSettled([
    chunksRepo.findUnsummarized(projectId, { newestFirst: true }),
    summariesRepo.findByProject(projectId),
    findingsRepo.findOpenGapsByProject(projectId),
  ]);

  if (unsummarizedResult.status === 'rejected') {
    logger.warn('Failed to fetch unsummarized chunks for gatherer selection', { projectId, error: String(unsummarizedResult.reason) });
  }
  if (summariesResult.status === 'rejected') {
    logger.warn('Failed to fetch summaries for gatherer selection', { projectId, error: String(summariesResult.reason) });
  }
  if (gapFindingsResult.status === 'rejected') {
    logger.warn('Failed to fetch gap findings for gatherer selection', { projectId, error: String(gapFindingsResult.reason) });
  }

  const unsummarizedChunks = unsummarizedResult.status === 'fulfilled' ? unsummarizedResult.value : [];
  const summaries = summariesResult.status === 'fulfilled' ? summariesResult.value : [];
  const gapFindings = gapFindingsResult.status === 'fulfilled' ? gapFindingsResult.value : [];

  const referencedPaths = extractReferencedFilePaths(requestMessages);
  const matchedFiles = referencedPaths.length > 0
    ? await filesRepo.findByProjectFileHintsList(projectId, referencedPaths)
    : [];
  const matchedFileIds = matchedFiles.map((file) => file.id);
  const summariesByFile = matchedFileIds.length > 0
    ? await filesRepo.findSummariesByFileIds(matchedFileIds)
    : new Map();

  const fileIdsWithSummaryCoverage = matchedFiles
    .filter((file) => (summariesByFile.get(file.id) ?? []).length > 0)
    .map((file) => file.id);
  const suppressedChunksByCoveredFile = fileIdsWithSummaryCoverage.length > 0
    ? await filesRepo.findChunksByFileIds(fileIdsWithSummaryCoverage)
    : new Map();
  const suppressedChunkIds = new Set<string>();
  for (const chunks of suppressedChunksByCoveredFile.values()) {
    for (const chunk of chunks) suppressedChunkIds.add(chunk.id);
  }

  const linkedFileIdsBySummaryId = new Map<string, string[]>();
  const prioritySummaryIds: string[] = [];
  const prioritySeen = new Set<string>();

  const referencedFiles = matchedFiles.map((file) => {
    const linkedSummaries = summariesByFile.get(file.id) ?? [];
    const linkedSummaryIds = linkedSummaries.map((summary: { id: string }) => summary.id);

    for (const summaryId of linkedSummaryIds) {
      if (!prioritySeen.has(summaryId)) {
        prioritySeen.add(summaryId);
        prioritySummaryIds.push(summaryId);
      }

      const existing = linkedFileIdsBySummaryId.get(summaryId) ?? [];
      if (!existing.includes(file.id)) {
        existing.push(file.id);
      }
      linkedFileIdsBySummaryId.set(summaryId, existing);
    }

    return {
      id: file.id,
      fileName: file.fileName,
      purpose: file.purpose,
      chunkCount: file.chunkCount,
      summaryCount: file.summaryCount,
      linkedSummaryIds,
    } satisfies GathererFileDescriptor;
  });

  const summaryDescriptors = summaries
    .map((summary) => {
      const categories = parseCategoriesList(summary.categoriesList);
      const linkedFileIds = linkedFileIdsBySummaryId.get(summary.id) ?? [];
      const priority: GathererSummaryDescriptor['priority'] = linkedFileIds.length > 0
        ? 'file-linked'
        : categories.includes('global')
          ? 'global'
          : 'candidate';

      return {
        id: summary.id,
        oneLineSummary: summary.oneLineSummary ?? summary.content.slice(0, 150),
        previewBullets: extractBulletPreviews(summary.content, 3),
        categories,
        createdAt: normalizeTimestamp(summary.createdAt),
        updatedAt: normalizeTimestamp(summary.updatedAt),
        priority,
        linkedFileIds,
      } satisfies GathererSummaryDescriptor;
    })
    .sort((left, right) =>
      gathererSummaryPriorityRank(left.priority) - gathererSummaryPriorityRank(right.priority) ||
      compareTimestampsDesc(left.updatedAt, right.updatedAt) ||
      left.id.localeCompare(right.id)
    );

  for (const descriptor of summaryDescriptors) {
    if (descriptor.priority !== 'global') continue;
    if (!prioritySeen.has(descriptor.id)) {
      prioritySeen.add(descriptor.id);
      prioritySummaryIds.push(descriptor.id);
    }
  }

  const categoryBuckets = new Map<string, Array<{ id: string; createdAt?: TimestampValue }>>();
  for (const chunk of unsummarizedChunks) {
    if (suppressedChunkIds.has(chunk.id)) continue;
    if (!chunk.category || chunk.category === 'global') continue;

    const bucket = categoryBuckets.get(chunk.category) ?? [];
    bucket.push({ id: chunk.id, createdAt: chunk.createdAt });
    categoryBuckets.set(chunk.category, bucket);
  }

  const unsummarizedCategories = [...categoryBuckets.entries()]
    .map(([categoryId, chunks]) => ({
      id: categoryId,
      chunkCount: chunks.length,
      newestChunkCreatedAt: getNewestTimestamp(chunks.map((chunk) => chunk.createdAt)),
      oldestChunkCreatedAt: getOldestTimestamp(chunks.map((chunk) => chunk.createdAt)),
    } satisfies GathererCategoryDescriptor))
    .sort((left, right) =>
      compareTimestampsDesc(left.newestChunkCreatedAt, right.newestChunkCreatedAt) ||
      left.id.localeCompare(right.id)
    );

  const relevantFindings = gapFindings
    .filter((finding) => scoreKeywordMatches(`${finding.title}\n${finding.description}`, queryKeywords) > 0)
    .map((finding) => ({
      id: finding.id,
      title: finding.title,
      severity: typeof finding.severity === 'string' ? finding.severity : undefined,
    } satisfies GathererFindingDescriptor));

  const summaryRefreshReasons: string[] = [];
  if (referencedFiles.some((file) => file.summaryCount === 0 && file.chunkCount > 0)) {
    summaryRefreshReasons.push('Referenced files matched stored chunks but do not have linked summaries yet.');
  }
  if (unsummarizedCategories.length > 0) {
    summaryRefreshReasons.push('Unsummarized category backlog remains and should be refreshed into summaries.');
  }

  return {
    queryText,
    referencedFiles,
    prioritySummaryIds,
    summaryDescriptors,
    unsummarizedCategories,
    relevantFindings,
    shouldRefreshSummaries: summaryRefreshReasons.length > 0,
    summaryRefreshReasons,
  };
}

export async function selectContext(
  projectId: string,
  requestMessages: ChatMessage[],
  model: string,
  requestId: string,
  userId?: string,
  sessionId?: string,
  overrides?: ContextSelectionOverrides
): Promise<SelectionResult> {
  const t0 = Date.now();
  const ctx = getEffectiveContextConfig();

  // Extract the user's actual request from known wrappers, or fall back
  // to the tail of the last user message (where the request lives in long
  // IDE messages full of workspace / attachment boilerplate).
  const queryText = extractQueryText(requestMessages);

  if (!queryText.trim()) {
    return { candidates: [], method: 'none', latencyMs: Date.now() - t0 };
  }

  const pool = await prepareContextPool(projectId, requestMessages, queryText);

  const hasAutoCandidates =
    pool.guaranteedCandidates.length > 0 ||
    pool.globalSummaryCandidates.length > 0 ||
    pool.matchedFindingCandidates.length > 0;
  const hasSelectableDescriptors = pool.summaryEntries.length > 0 || pool.categoryEntries.length > 0;

  if (!hasAutoCandidates && !hasSelectableDescriptors) {
    return { candidates: [], method: 'none', latencyMs: Date.now() - t0 };
  }

  let finalMethod = 'descriptor+auto';
  let selectedSummaryIds: string[] = [];
  let selectedCategoryIds: string[] = [];

  if (hasSelectableDescriptors) {
    const bypass = overrides?.forceSelector ? false : shouldBypassSelector(pool);
    if (bypass) {
      selectedSummaryIds = pool.summaryEntries.map((entry) => entry.id);
      selectedCategoryIds = pool.categoryEntries.map((entry) => entry.id);
      finalMethod = 'descriptor+bypass';
    } else {
      const descriptorSelection = await selectDescriptorsWithLLM(
        queryText,
        pool,
        projectId,
        sessionId,
        overrides?.providerOverride
      );
      selectedSummaryIds = descriptorSelection.summaryIds;
      selectedCategoryIds = descriptorSelection.categoryIds;
      finalMethod = descriptorSelection.method;
    }
  }

  const summaryCandidateMap = new Map(pool.summaryEntries.map((entry) => [entry.id, entry.candidate]));
  const categoryCandidateMap = new Map(pool.categoryEntries.map((entry) => [entry.id, entry.candidates]));

  const ranked = dedupeCandidates([
    ...pool.guaranteedCandidates,
    ...pool.globalSummaryCandidates,
    ...pool.matchedFindingCandidates,
    ...selectedSummaryIds
      .map((summaryId) => summaryCandidateMap.get(summaryId))
      .filter((candidate): candidate is ContextCandidate => candidate !== undefined),
    ...selectedCategoryIds.flatMap((categoryId) => categoryCandidateMap.get(categoryId) ?? []),
  ]);

  // Remove near-duplicate chunks using stored embedding vectors before
  // fillBudget, freeing up tokens for more diverse candidates.
  const deduped = await semanticallyDedupeChunks(ranked, projectId);

  if (deduped.length === 0) {
    return { candidates: [], method: 'none', latencyMs: Date.now() - t0 };
  }

  const budget = computeContextBudget(
    modelMaxTokens(model),
    requestMessages
  );
  const budgetCapped = Math.min(budget, ctx.tokenBudget);
  const selected = fillBudget(deduped, budgetCapped).map((c) => ({
    ...c,
    similarity: (c as ContextCandidate).similarity ?? 0,
  })) as ContextCandidate[];

  const latencyMs = Date.now() - t0;

  // Log selection asynchronously (fire-and-forget — never unhandled rejection)
  setImmediate(() => {
    selectionsRepo.insert({
      projectId,
      userId,
      requestId,
      selectedChunkIds: selected.filter((c) => c.type === 'chunk').map((c) => c.id),
      selectedSummaryIds: selected.filter((c) => c.type === 'summary').map((c) => c.id),
      totalTokensInjected: selected.reduce((s, c) => s + estimateTokens(c.fullContent), 0),
      selectionMethod: finalMethod,
      selectionLatencyMs: latencyMs,
    }).catch((err) => {
      logger.warn('Failed to record context selection', {
        projectId,
        requestId,
        error: String(err),
      });
    });
  });

  logger.debug('Context selected', {
    projectId,
    count: selected.length,
    method: finalMethod,
    latencyMs,
  });

  return { candidates: selected, method: finalMethod, latencyMs };
}

// ── LLM Reranking ───────────────────────────────────────────────────────────

/**
 * Stage 2: Use a fast/cheap model to choose relevant summary IDs and
 * unsummarized category IDs. Guaranteed file-linked chunks and global summaries
 * are handled outside this step.
 */
async function selectDescriptorsWithLLM(
  queryText: string,
  pool: PreparedContextPool,
  projectId: string,
  sessionId?: string,
  providerOverride?: ResolvedProviderAndModel,
): Promise<DescriptorSelectionIds> {
  const heuristicSelection = selectDescriptorsHeuristically(queryText, pool);
  if (pool.summaryEntries.length === 0 && pool.categoryEntries.length === 0) {
    return heuristicSelection;
  }

  const models = getSystemModelConfig();
  const execution = providerOverride
    ?? (models.contextSelector
      ? await resolveProviderAndModelForJob(models.contextSelector, 'openai')
      : null);
  if (!execution) {
    logger.debug('No context selector model/provider available — using descriptor heuristics');
    return heuristicSelection;
  }

  const { adapter, baseUrl, apiKey, model: contextSelectorModel } = execution;

  const categoryLines = pool.categoryEntries.length > 0
    ? pool.categoryEntries.map((entry) =>
        JSON.stringify({
          id: entry.id,
          chunkCount: entry.candidates.length,
          label: entry.selectorContent,
          newestChunkCreatedAt: normalizeTimestamp(entry.newestChunkCreatedAt) ?? null,
          oldestChunkCreatedAt: normalizeTimestamp(entry.oldestChunkCreatedAt) ?? null,
        })
      ).join('\n')
    : '(none)';

  const summaryLines = pool.summaryEntries.length > 0
    ? pool.summaryEntries.map((entry) =>
        JSON.stringify({
          id: entry.id,
          categories: entry.candidate.categories,
          oneLineSummary: entry.candidate.content.slice(0, 240),
          createdAt: normalizeTimestamp(entry.candidate.createdAt) ?? null,
          updatedAt: normalizeTimestamp(entry.candidate.updatedAt ?? entry.candidate.createdAt) ?? null,
        })
      ).join('\n')
    : '(none)';

  const prompt = [
    'You are a context relevance ranker. Given a user query, choose which summary IDs and unsummarized category IDs should be expanded into injected project context.',
    '',
    'CRITICAL OUTPUT RULES — read first:',
    '- Do NOT think, reason step by step, or add any commentary. Keep all reasoning internal and minimal. This should be a quick task',
    '- Output ONLY the JSON object on the first line of your response. No prose, no markdown fences, no explanations.',
    '- The JSON must be parseable by JSON.parse() exactly as written.',
    '',
    `User query: """${queryText.slice(0, 1500)}"""`,
    '',
    'IMPORTANT:',
    '- File-linked learnings from files explicitly referenced in the request are already handled separately.',
    '- Global summaries are already attached automatically and do not need to be selected here.',
    '- Selecting a category means ALL unsummarized learnings in that category will be injected.',
    '- Use timestamp metadata as a freshness signal. When two items are similarly relevant, prefer newer information for current-behavior questions, but do not pick fresh yet irrelevant items.',
    '',
    'Unsummarized categories:',
    categoryLines,
    '',
    'Summaries:',
    summaryLines,
    '',
    'Return a JSON object with two arrays of string IDs:',
    '- "categoryIds": relevant category IDs, most relevant first',
    '- "summaryIds": relevant summary IDs, most relevant first',
    '',
    'Be selective — quality over quantity. Exclude items not relevant to the query.',
    'If the request is vague simply select the most general summaries and categories, don\'t waste tokens on irrelevant details or make guesses.',
    'Output ONLY valid JSON, nothing else.',
  ].join('\n');

  const runId = generateRunId();
  const summaryCount = pool.summaryEntries.length;
  const categoryCount = pool.categoryEntries.length;
  const guaranteedCount = pool.guaranteedCandidates.length;
  const globalSummaryCount = pool.globalSummaryCandidates.length;
  const findingCount = pool.matchedFindingCandidates.length;

  try {
    const url = adapter.endpoint(baseUrl);
    const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey), {
      sessionId,
      projectId,
    });

    // Build a request that is friendly to cheap, fast "reranker" models.
    //
    // Key constraints we work around here:
    //   1. `max_tokens: 500` was too tight for reasoning models — they burn
    //      the whole budget on internal thinking and return an empty string.
    //      Bumped to 2000 so any brief reasoning plus the JSON fits, but the
    //      hard `stop` token below still bounds the final answer.
    //   2. `temperature: 0` is rejected by some reasoning models (gpt-5,
    //      o-series). Drop it — these models are deterministic by default
    //      and the JSON output mode already removes sampling noise.
    //   3. For OpenAI-compatible providers, attach `response_format:
    //      json_object` so the model returns parseable JSON with no
    //      markdown fences to strip. The Anthropic adapter would forward
    //      this as an unknown field and 400, so we gate on adapter type.
    //   4. Wrap the call in withParamFallback so a 400 mentioning
    //      `temperature` or `max_tokens` triggers an automatic retry
    //      without those parameters.
    const request: ProxyRequest = {
      model: contextSelectorModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      // Cut the response as soon as the JSON object closes — prevents
      // reasoning tails, prose, or trailing whitespace.
      stop: ['\n\n'],
      // Determinism without needing `temperature`; ignored by adapters
      // that don't recognise it (the param fallback handles 400s).
      ...(adapter === openaiAdapter
        ? { response_format: { type: 'json_object' as const }, seed: 0 }
        : {}),
    };

    // Record input before the API call
    recordStat({
      projectId,
      model: contextSelectorModel,
      runId,
      type: 'knowledge_filtering',
      direction: 'input',
      meta: {
        numCandidates: summaryCount + categoryCount,
        numSummariesAvailable: summaryCount,
        numCategoriesAvailable: categoryCount,
        numGuaranteedChunks: guaranteedCount,
        numGlobalSummaries: globalSummaryCount,
        numFindingsAvailable: findingCount,
        queryText: queryText.slice(0, 500),
      },
      body: prompt,
    });

    const { result: response } = await withParamFallback(
      request,
      adapter,
      {
        projectId,
        requestId: `context-selector-${runId}`,
        model: contextSelectorModel,
        providerName: execution.providerName,
        providerType: execution.providerType,
        url,
        requestHeaders: headers,
      },
      async (payload) => {
        const res = await axios.post(url, payload, {
          headers,
          timeout: 45_000,
        });
        return res;
      }
    );

    const parsed = adapter.parseResponse(response.data);
    const rawText: string = contentToText(parsed.choices?.[0]?.message?.content) ?? '';

    // Record output — the raw JSON response from the reranker
    const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    recordStat({
      projectId,
      model: contextSelectorModel,
      runId,
      type: 'knowledge_filtering',
      direction: 'output',
      meta: {
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
      },
      tokens: usage?.completion_tokens,
      body: rawText,
    });

    if (!rawText.trim()) {
      logger.warn('Context selector model returned empty response');
      return heuristicSelection;
    }

    // Parse JSON response — handle ```json fences and other wrappers
    let result: { summaryIds?: string[]; categoryIds?: string[] };
    try {
      result = JSON.parse(rawText);
    } catch {
      const cleaned = rawText.replace(/```json\s*|\s*```/g, '').trim();
      try {
        result = JSON.parse(cleaned);
      } catch {
        logger.warn('Failed to parse context selector response', { raw: rawText.slice(0, 200) });
        return heuristicSelection;
      }
    }

    const validSummaryIds = new Set(pool.summaryEntries.map((entry) => entry.id));
    const validCategoryIds = new Set(pool.categoryEntries.map((entry) => entry.id));

    const selectedSummaryIds = (result.summaryIds || []).filter(
      (id): id is string => typeof id === 'string' && validSummaryIds.has(id)
    );
    const selectedCategoryIds = (result.categoryIds || []).filter(
      (id): id is string => typeof id === 'string' && validCategoryIds.has(id)
    );

    logger.debug('LLM selected descriptor context', {
      summaries: selectedSummaryIds.length,
      categories: selectedCategoryIds.length,
      availableSummaries: summaryCount,
      availableCategories: categoryCount,
      model: contextSelectorModel,
    });

    return {
      summaryIds: selectedSummaryIds,
      categoryIds: selectedCategoryIds,
      method: 'descriptor+llm',
    };
  } catch (err) {
    logger.warn('LLM descriptor selection failed, falling back to heuristics', {
      error: String(err),
    });
    return heuristicSelection;
  }
}

function selectDescriptorsHeuristically(
  queryText: string,
  pool: PreparedContextPool,
): DescriptorSelectionIds {
  const keywords = extractKeywords(queryText);

  const summaryIds = pool.summaryEntries
    .map((entry) => ({
      id: entry.id,
      score: scoreKeywordMatches(entry.heuristicText, keywords),
      recency: entry.candidate.updatedAt ?? entry.candidate.createdAt,
    }))
    .filter((entry) => entry.score > 0)
    .sort(compareScoredEntries)
    .map((entry) => entry.id);

  const categoryIds = pool.categoryEntries
    .map((entry) => ({
      id: entry.id,
      score: scoreKeywordMatches(entry.heuristicText, keywords),
      recency: entry.newestChunkCreatedAt,
    }))
    .filter((entry) => entry.score > 0)
    .sort(compareScoredEntries)
    .map((entry) => entry.id);

  return {
    summaryIds,
    categoryIds,
    method: 'descriptor+heuristic',
  };
}

function dedupeCandidates(candidates: ContextCandidate[]): ContextCandidate[] {
  const deduped: ContextCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    deduped.push(candidate);
  }

  return deduped;
}

// ── Semantic chunk deduplication ──────────────────────────────────────────────

/**
 * Remove near-duplicate chunks by comparing their stored embedding vectors.
 * When two or more chunk candidates have a cosine similarity at or above
 * the configured `semanticDuplicateThreshold`, only the one with the
 * newest `createdAt` timestamp is kept (ties break on highest similarity).
 *
 * This runs *before* fillBudget so freed-up tokens can be used by other
 * diverse candidates instead of wasted on redundant facts.
 */
async function semanticallyDedupeChunks(
  candidates: ContextCandidate[],
  projectId: string,
): Promise<ContextCandidate[]> {
  const config = getEffectiveContextConfig();
  const threshold = config.semanticDuplicateThreshold;
  if (threshold <= 0 || threshold >= 1) return candidates;

  const chunkCandidates = candidates.filter((c) => c.type === 'chunk');
  if (chunkCandidates.length < 2) return candidates;

  const chunkIds = chunkCandidates.map((c) => c.id);
  let embeddings: Array<{ chunkId: string; vector: Float32Array }>;

  try {
    const rows = await embeddingsRepo.findByChunkIds(chunkIds);
    if (rows.length < 2) return candidates;
    embeddings = rows.map((row) => ({
      chunkId: row.chunkId,
      vector: embeddingsRepo.getVector(row),
    }));
  } catch (err) {
    logger.warn('Semantic dedup failed to load embeddings, skipping', {
      projectId,
      error: String(err),
    });
    return candidates;
  }

  const embLookup = new Map<string, Float32Array>();
  for (const emb of embeddings) {
    if (emb.vector.length > 0) embLookup.set(emb.chunkId, emb.vector);
  }

  // Build adjacency: candidates that have embeddings and
  // are similar above the threshold form connected components.
  const indexed = chunkCandidates
    .map((c, i) => ({ candidate: c, idx: i, emb: embLookup.get(c.id) }))
    .filter((item) => item.emb != null);

  if (indexed.length < 2) return candidates;

  const parent = new Array(indexed.length).fill(-1);
  const find = (x: number): number => {
    while (parent[x] >= 0) x = parent[x];
    return x;
  };
  const union = (a: number, b: number): void => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (parent[ra] > parent[rb]) [ra, rb] = [rb, ra]; // union by size
    parent[ra] += parent[rb];
    parent[rb] = ra;
  };

  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      const sim = cosineSimilarity(indexed[i].emb!, indexed[j].emb!);
      if (sim >= threshold) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map<number, typeof indexed>();
  for (let i = 0; i < indexed.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(indexed[i]);
  }

  // Build set of IDs to exclude (keep the best from each group)
  const excludeIds = new Set<string>();
  let dedupedCount = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Pick the keeper: prefer newest createdAt, then highest similarity
    group.sort((a, b) => {
      const timeDelta = timestampToMillis(b.candidate.createdAt) - timestampToMillis(a.candidate.createdAt);
      if (timeDelta !== 0) return timeDelta;
      return (b.candidate.similarity ?? 0) - (a.candidate.similarity ?? 0);
    });

    // Exclude all but the first (best) one
    for (let i = 1; i < group.length; i++) {
      excludeIds.add(group[i].candidate.id);
      dedupedCount++;
    }
  }

  if (dedupedCount > 0) {
    logger.info('Semantic dedup removed near-duplicate chunks', {
      projectId,
      threshold,
      totalChunksBefore: chunkCandidates.length,
      removed: dedupedCount,
      kept: chunkCandidates.length - dedupedCount,
    });

    recordStat({
      projectId,
      model: 'semantic-dedup',
      runId: 'semantic-dedup',
      type: 'context_injection',
      direction: 'output',
      meta: {
        method: 'semantic-dedup',
        threshold,
        chunksBefore: chunkCandidates.length,
        chunksDeduped: dedupedCount,
      },
      tokens: 0,
      body: '',
    });
  }

  return candidates.filter((c) => !excludeIds.has(c.id));
}

// ── Bypass-selector logic ─────────────────────────────────────────────────────

/**
 * Decide whether to skip the LLM selector. We bypass when either:
 *   - the descriptor pool (summary IDs + unsummarized category IDs) is at or
 *     below `bypassSelectorItemThreshold`, OR
 *   - the estimated total token cost of injecting every candidate reachable via
 *     those descriptors is at or below `bypassSelectorTokenThreshold`.
 */
function shouldBypassSelector(pool: PreparedContextPool): boolean {
  const ctx = getEffectiveContextConfig();
  const itemThreshold = ctx.bypassSelectorItemThreshold;
  const tokenThreshold = ctx.bypassSelectorTokenThreshold;
  const selectorItemCount = pool.summaryEntries.length + pool.categoryEntries.length;

  if (itemThreshold > 0 && selectorItemCount <= itemThreshold) {
    logger.debug('Bypassing context selector: descriptor pool within item threshold', {
      summaries: pool.summaryEntries.length,
      categories: pool.categoryEntries.length,
      threshold: itemThreshold,
    });
    return true;
  }

  if (tokenThreshold > 0) {
    const totalTokens = estimateCandidateTokens([
      ...pool.guaranteedCandidates,
      ...pool.globalSummaryCandidates,
      ...pool.matchedFindingCandidates,
      ...pool.summaryEntries.map((entry) => entry.candidate),
      ...pool.categoryEntries.flatMap((entry) => entry.candidates),
    ]);
    if (totalTokens > 0 && totalTokens <= tokenThreshold) {
      logger.debug('Bypassing context selector: injection pool within token threshold', {
        totalTokens,
        threshold: tokenThreshold,
      });
      return true;
    }
  }

  return false;
}

function estimateCandidateTokens(candidates: ContextCandidate[]): number {
  return estimateCandidateInjectionTokens(dedupeCandidates(candidates));
}

// ── Helper: build a chunk candidate ──────────────────────────────────────────

function normalizeTimestamp(value: TimestampValue): string | undefined {
  if (!value) return undefined;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }

  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}

function timestampToMillis(value: TimestampValue): number {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return Number.NEGATIVE_INFINITY;

  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function compareTimestampsDesc(left: TimestampValue, right: TimestampValue): number {
  return timestampToMillis(right) - timestampToMillis(left);
}

function getNewestTimestamp(values: TimestampValue[]): string | undefined {
  let newest: { value: string; ms: number } | undefined;

  for (const value of values) {
    const normalized = normalizeTimestamp(value);
    if (!normalized) continue;

    const ms = Date.parse(normalized);
    if (Number.isNaN(ms)) continue;

    if (!newest || ms > newest.ms) {
      newest = { value: normalized, ms };
    }
  }

  return newest?.value;
}

function getOldestTimestamp(values: TimestampValue[]): string | undefined {
  let oldest: { value: string; ms: number } | undefined;

  for (const value of values) {
    const normalized = normalizeTimestamp(value);
    if (!normalized) continue;

    const ms = Date.parse(normalized);
    if (Number.isNaN(ms)) continue;

    if (!oldest || ms < oldest.ms) {
      oldest = { value: normalized, ms };
    }
  }

  return oldest?.value;
}

function formatTimestampForContext(value: TimestampValue): string | null {
  const normalized = normalizeTimestamp(value);
  if (!normalized) return null;

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return normalized;

  return normalized.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function buildRecencyLine(
  type: ContextCandidate['type'],
  createdAt?: TimestampValue,
  updatedAt?: TimestampValue,
): string | null {
  if (type === 'chunk') {
    const learnedAt = formatTimestampForContext(createdAt);
    return learnedAt ? `Recency: learned ${learnedAt}.` : null;
  }

  if (type === 'finding') {
    const reportedAt = formatTimestampForContext(createdAt);
    return reportedAt ? `Recency: reported ${reportedAt}.` : null;
  }

  const normalizedCreatedAt = normalizeTimestamp(createdAt);
  const normalizedUpdatedAt = normalizeTimestamp(updatedAt) ?? normalizedCreatedAt;
  const createdLabel = formatTimestampForContext(normalizedCreatedAt);
  const updatedLabel = formatTimestampForContext(normalizedUpdatedAt);

  if (updatedLabel && createdLabel && normalizedUpdatedAt && normalizedUpdatedAt !== normalizedCreatedAt) {
    return `Recency: last updated ${updatedLabel}; created ${createdLabel}.`;
  }

  if (updatedLabel) return `Recency: last updated ${updatedLabel}.`;
  if (createdLabel) return `Recency: created ${createdLabel}.`;
  return null;
}

function compareScoredEntries(
  left: { id: string; score: number; recency?: string },
  right: { id: string; score: number; recency?: string },
): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) return scoreDelta;

  const recencyDelta = compareTimestampsDesc(left.recency, right.recency);
  if (recencyDelta !== 0) return recencyDelta;

  return left.id.localeCompare(right.id);
}

function buildChunkCandidate(
  chunk: { id: string; fact: string; category: string; createdAt?: TimestampValue },
  files: Array<{ fileName: string; purpose: string }>,
  codeExtracts: Array<{ fileName: string; language: string; symbolsJson: string; code: string }>,
  similarity: number,
  opts: { guaranteed?: boolean } = {}
): ContextCandidate {
  // Lightweight selector content: just the fact + category
  const selectorContent = chunk.fact;
  const recencyLine = buildRecencyLine('chunk', chunk.createdAt);

  let fullContent = `- ${chunk.fact}`;
  if (recencyLine) {
    fullContent += `\n  ${recencyLine}`;
  }
  if (files.length > 0) {
    const fileLines = files.map(
      (f) => `    - \`${f.fileName}\`${f.purpose ? ` — ${f.purpose}` : ''}`
    );
    fullContent += '\n  Files referenced:\n' + fileLines.join('\n');
  }

  const renderedCodeExtracts = renderCodeExtracts(codeExtracts);
  if (renderedCodeExtracts) {
    fullContent += `\n${renderedCodeExtracts}`;
  }

  return {
    id: chunk.id,
    type: 'chunk',
    content: selectorContent,
    fullContent,
    category: chunk.category,
    categories: [chunk.category],
    similarity,
    guaranteed: opts.guaranteed ?? false,
    createdAt: normalizeTimestamp(chunk.createdAt),
  };
}

function buildSummaryCandidate(summary: {
  id: string;
  oneLineSummary?: string;
  categoriesList?: string;
  toc?: string | null;
  content: string;
  createdAt?: TimestampValue;
  updatedAt?: TimestampValue;
}, opts: { guaranteed?: boolean; similarity?: number } = {}): ContextCandidate {
  const categories = parseCategoriesList(summary.categoriesList);
  const primaryCategory = categories.includes('global')
    ? 'global'
    : categories.find((category) => category !== 'global') ?? 'summary';
  const recencyLine = buildRecencyLine('summary', summary.createdAt, summary.updatedAt);
  const oneLineSummary = summary.oneLineSummary ?? summary.content.slice(0, 150);
  const similarity = opts.similarity ?? (categories.includes('global') ? 0.9 : 0.5);

  // Prepend a table-of-contents index for summaries with 2+ ## sections
  const tocPrefix = renderTocPrefix(summary.content);
  const contentWithToc = tocPrefix
    ? `${tocPrefix}\n\n${summary.content}`
    : summary.content;

  return {
    id: summary.id,
    type: 'summary',
    content: buildSummarySelectorContent(summary),
    fullContent: recencyLine
      ? `${recencyLine}\n${contentWithToc}`
      : contentWithToc,
    compactContent: renderCompactSummaryContext({
      id: summary.id,
      oneLineSummary,
      categories,
      category: primaryCategory,
      confidence: similarity,
    }),
    category: primaryCategory,
    categories,
    similarity,
    guaranteed: opts.guaranteed ?? false,
    createdAt: normalizeTimestamp(summary.createdAt),
    updatedAt: normalizeTimestamp(summary.updatedAt),
    oneLineSummary,
  };
}

function gathererSummaryPriorityRank(priority: GathererSummaryDescriptor['priority']): number {
  switch (priority) {
    case 'file-linked':
      return 0;
    case 'global':
      return 1;
    default:
      return 2;
  }
}

function buildGapFindingCandidate(
  finding: { id: string; title: string; description: string; createdAt?: TimestampValue },
  similarity: number
): ContextCandidate {
  const summary = `Open knowledge gap: ${finding.title}`;
  const recencyLine = buildRecencyLine('finding', finding.createdAt);

  return {
    id: finding.id,
    type: 'finding',
    content: `${summary}. ${finding.description}`.trim(),
    fullContent: [
      `- Knowledge gap: ${finding.title}`,
      recencyLine ? `  ${recencyLine}` : null,
      `  ${finding.description}`,
      '  If the user request touches this area, gather concrete project evidence before answering confidently.',
    ].filter((line): line is string => Boolean(line)).join('\n'),
    category: 'gap',
    categories: ['gap'],
    similarity,
    createdAt: normalizeTimestamp(finding.createdAt),
  };
}

// ── Helper: build lightweight selector content for a summary ─────────────────

function buildSummarySelectorContent(summary: {
  oneLineSummary?: string;
  categoriesList?: string;
  content: string;
}): string {
  const parts: string[] = [];
  const oneLiner = summary.oneLineSummary ?? summary.content.slice(0, 150);
  if (oneLiner) parts.push(oneLiner);

  const cats = parseCategoriesList(summary.categoriesList);
  if (cats.length > 0) parts.push(`[${cats.join(', ')}]`);

  return parts.join(' ') || summary.content.slice(0, 150);
}

function parseSymbolsJson(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => value.length > 0))]
      : [];
  } catch {
    return [];
  }
}

function indentMultiline(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/**
 * Extract up to maxBullets bullet-point lines from summary content for preview.
 * Matches lines starting with `- ` or `* ` (common markdown bullet syntax).
 */
function extractBulletPreviews(content: string, maxBullets: number): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .slice(0, maxBullets);
}

function renderCodeExtracts(
  codeExtracts: Array<{ fileName: string; language: string; symbolsJson: string; code: string }>
): string | null {
  const lines: string[] = [];

  for (const extract of codeExtracts) {
    const fileLabel = extract.fileName ? ` from \`${extract.fileName}\`` : '';
    const symbols = parseSymbolsJson(extract.symbolsJson);
    const code = extract.code.trim();

    if (symbols.length > 0) {
      lines.push(`    - Symbols${fileLabel}: ${JSON.stringify(symbols)}`);
    }

    if (code.length > 0) {
      const language = extract.language.trim();
      lines.push(`  Relevant code${fileLabel}:`);
      lines.push(`  \`\`\`${language}`);
      lines.push(indentMultiline(code, '  '));
      lines.push('  ```');
    }
  }

  if (lines.length === 0) return null;
  return `  Code references:\n${lines.join('\n')}`;
}

function scoreKeywordMatches(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  const lower = text.toLowerCase();
  return keywords.reduce((score, keyword) => score + (lower.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}
