import axios from 'axios';
import { chunksRepo } from '../db/repositories/chunks';
import { summariesRepo } from '../db/repositories/summaries';
import { getConfig } from '../config/config';
import { logger } from '../utils/logger';
import { contentToText } from '../utils/messageContent';
import { estimateTokens } from '../utils/tokens';
import { recordStat, generateRunId } from '../utils/stats';
import { withParamFallback, type ParamFallbackContext } from '../utils/paramFallback';
import { logTaskRun } from '../utils/taskRunLog';
import { type ResolvedProvider } from '../proxy/upstream';
import { applyUpstreamRequestMiddleware } from '../proxy/requestMiddleware';
import type { LearningChunk, Summary } from '../db/schema';
import {
  getSummarizerLastSuccessfulRunAt,
  MIN_NEW_CHUNKS_FOR_SCHEDULED_SUMMARIZER,
  setSummarizerLastSuccessfulRunAt,
  shouldPersistSuccessfulRun,
  shouldRunScheduledSummarizer,
} from './summarizerState';

export interface SummarizerOptions {
  projectId: string;
  model: string;
  provider: ResolvedProvider;
  trigger?: 'manual' | 'scheduled';
}

// ── Prompt builders ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are a technical knowledge manager. Your job is to produce concise,',
  'well-organised summaries of facts learned about a software project.',
  '',
  'Rules:',
  '- Group related facts. Remove redundancy. Preserve technical precision.',
  '- Only use information from the provided facts — do not invent anything.',
  '- Write concise bullet points (one sentence each).',
  '- Omit sections that have no relevant content.',
  '',
  'SPECIAL RULE for the "global" category:',
  '- The global summary contains system-wide conventions that apply to the ENTIRE',
  '  project — date/time formats, coding standards, language/framework choices,',
  '  repository-wide rules, project-level policies, etc.',
  '- This summary is injected into nearly every prompt, so keep it concise',
  '  and universally relevant. Avoid feature-specific details here.',
  '- When merging into an existing global summary, preserve all accumulated',
  '  conventions and update only what has changed. The global summary is a',
  '  living document — it should grow cumulatively, not be rewritten from scratch.',
  '',
  'You MUST format your ENTIRE response EXACTLY as follows — no preamble, no commentary,',
  'no markdown outside the tags. Start with <one-line> on the very first line:',
  '',
  '<one-line>A concise summary of the key knowledge. Scale the length to the size of the <content>: for small summaries (under ~500 chars of content), one sentence is enough; for medium summaries use 1–2 sentences; for large summaries use 2–3 sentences capturing the key points with a bit more detail. Target roughly 5–15% of the <content> length.</one-line>',
  '<categories>architecture, api-design</categories>',
  '<content>',
  '## Section Heading',
  '- Bullet point one',
  '- Bullet point two',
  '</content>',
  '',
  'The <one-line> and <categories> tags are REQUIRED. Do not skip them.',
].join('\n');

function renderChunkForPrompt(chunk: LearningChunk, label: string): string {
  return `[${label}] (confidence: ${chunk.confidence.toFixed(2)})\n${chunk.fact}`;
}

function parseStoredStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mergeSummaryCategories(primaryCategory: string, ...lists: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  const add = (category: string) => {
    const trimmed = category.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(trimmed);
  };

  add(primaryCategory);
  for (const list of lists) {
    for (const category of list) add(category);
  }

  return merged;
}

function buildNewSummaryPrompt(chunks: LearningChunk[], category: string): string {
  const chunkText = chunks
    .map((c, i) => renderChunkForPrompt(c, String(i + 1)))
    .join('\n\n');

  return [
    SYSTEM_PROMPT,
    '',
    `Create a summary for the category "${category}".`,
    `Always include "${category}" in the <categories> tag. Add extra categories only when the facts clearly support them.`,
    '',
    `## Facts to Summarise (${chunks.length})`,
    chunkText,
  ].join('\n');
}

function buildMergeSummaryPrompt(
  chunks: LearningChunk[],
  existingSummary: Summary,
  category: string,
  existingCategories: string[]
): string {
  const chunkText = chunks
    .map((c, i) => renderChunkForPrompt(c, `NEW-${i + 1}`))
    .join('\n\n');

  return [
    SYSTEM_PROMPT,
    '',
    `You are updating an existing summary for the category "${category}".`,
    'Merge the NEW facts below into the EXISTING summary content.',
    'Remove any redundancy between old and new facts.',
    'Preserve all valuable information from the existing summary.',
    'Add new sections or restructure if the new facts warrant it.',
    `Always include "${category}" in the <categories> tag and preserve existing category tags that still apply.`,
    '',
    `## Existing Categories (${existingCategories.length})`,
    existingCategories.join(', ') || '(none)',
    '',
    '## Existing Summary (v' + existingSummary.version + ')',
    existingSummary.content,
    '',
    `## New Facts to Merge (${chunks.length})`,
    chunkText,
  ].join('\n');
}

// ── Response parser ───────────────────────────────────────────────────────────

interface ParsedSummary {
  oneLine: string;
  categories: string[];
  content: string;
}

function parseSummaryResponse(rawText: string): ParsedSummary | null {
  const oneLineMatch = rawText.match(/<one-line>(.+?)<\/one-line>/s);
  const catsMatch = rawText.match(/<categories>(.+?)<\/categories>/s);
  const contentMatch = rawText.match(/<content>(.+?)<\/content>/s);

  if (!contentMatch) {
    // Model didn't follow the format — treat entire response as content
    logger.warn('Summarizer response missing <content> tags, using raw text');
    return {
      oneLine: oneLineMatch?.[1]?.trim() ?? '',
      categories: catsMatch?.[1]?.split(',').map((c) => c.trim()).filter(Boolean) ?? [],
      content: rawText.trim(),
    };
  }

  return {
    oneLine: oneLineMatch?.[1]?.trim() ?? '',
    categories: catsMatch?.[1]
      ?.split(',')
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0) ?? [],
    content: contentMatch[1].trim(),
  };
}

// ── Main summarizer ───────────────────────────────────────────────────────────

/** Minimum unsummarized chunks needed within a single category to trigger summarization. */
const PER_CATEGORY_THRESHOLD = 3;
const MAX_CHUNKS_PER_SUMMARY_BATCH = 25;
const MAX_SUMMARIZER_INPUT_TOKENS = 12_000;
const MIN_SUMMARIZER_INPUT_TOKENS = 2_000;
const MAX_SUMMARIZER_OUTPUT_TOKENS = 4_000;
const SUMMARIZER_TIMEOUT_MS = 5 * 60_000;

const activeSummarizerRuns = new Map<string, Promise<void>>();

function takeCategoryBatch(
  chunks: LearningChunk[],
  category: string,
  existingSummary: Summary | undefined,
  maxPromptTokens: number
): LearningChunk[] {
  if (chunks.length <= 1) return chunks;

  const existingCategories = existingSummary
    ? parseStoredStringArray(existingSummary.categoriesList)
    : [];
  const basePrompt = existingSummary
    ? buildMergeSummaryPrompt([], existingSummary, category, existingCategories)
    : buildNewSummaryPrompt([], category);

  let batchTokens = estimateTokens(basePrompt);
  const batch: LearningChunk[] = [];

  for (const chunk of chunks) {
    const label = existingSummary ? `NEW-${batch.length + 1}` : String(batch.length + 1);
    const chunkTokens = estimateTokens(renderChunkForPrompt(chunk, label)) + 4;
    const wouldOverflow = batch.length > 0 && (
      batch.length >= MAX_CHUNKS_PER_SUMMARY_BATCH ||
      batchTokens + chunkTokens > maxPromptTokens
    );

    if (wouldOverflow) break;

    batch.push(chunk);
    batchTokens += chunkTokens;
  }

  return batch.length > 0 ? batch : [chunks[0]!];
}

export async function runSummarizer(opts: SummarizerOptions): Promise<void> {
  const activeRun = activeSummarizerRuns.get(opts.projectId);
  if (activeRun) {
    logger.info('Summarizer already running; reusing active run', {
      projectId: opts.projectId,
      trigger: opts.trigger ?? 'scheduled',
    });
    return activeRun;
  }

  const runPromise = runSummarizerOnce(opts).finally(() => {
    if (activeSummarizerRuns.get(opts.projectId) === runPromise) {
      activeSummarizerRuns.delete(opts.projectId);
    }
  });

  activeSummarizerRuns.set(opts.projectId, runPromise);
  return runPromise;
}

async function runSummarizerOnce(opts: SummarizerOptions): Promise<void> {
  const trigger = opts.trigger ?? 'scheduled';
  const lastSuccessfulRunAt = trigger === 'scheduled'
    ? await getSummarizerLastSuccessfulRunAt(opts.projectId)
    : null;

  if (trigger === 'scheduled') {
    const newChunkCount = lastSuccessfulRunAt
      ? await chunksRepo.countUnsummarizedCreatedAfter(opts.projectId, lastSuccessfulRunAt)
      : await chunksRepo.countUnsummarized(opts.projectId);

    if (!shouldRunScheduledSummarizer(newChunkCount)) {
      logger.debug('Skipping scheduled summarizer run', {
        projectId: opts.projectId,
        newChunkCount,
        minNewChunks: MIN_NEW_CHUNKS_FOR_SCHEDULED_SUMMARIZER,
        lastSuccessfulRunAt,
      });
      return;
    }
  }

  const config = getConfig();
  const summarizerMaxOutputTokens = Math.max(
    256,
    Math.min(MAX_SUMMARIZER_OUTPUT_TOKENS, config.context.reservedResponseTokens)
  );
  const maxPromptTokens = Math.max(
    MIN_SUMMARIZER_INPUT_TOKENS,
    Math.min(
      MAX_SUMMARIZER_INPUT_TOKENS,
      config.context.defaultModelMaxTokens - summarizerMaxOutputTokens - config.context.contextOverheadTokens
    )
  );
  const allUnsummarized = await chunksRepo.findUnsummarized(opts.projectId);

  // Global threshold: skip if total unsummarized < configured threshold
  if (allUnsummarized.length < config.context.autoSummarizeThreshold) {
    return;
  }

  // Group unsummarized chunks by category
  const byCategory = new Map<string, LearningChunk[]>();
  for (const chunk of allUnsummarized) {
    const cat = chunk.category || 'general';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(chunk);
  }

  // Global category is special: always eligible (even with 1 chunk) so system-wide
  // conventions are captured immediately rather than waiting for the threshold.
  const isGlobalEligible = (cat: string) => cat === 'global';

  // Only process categories that have enough chunks (or when total exceeds global threshold)
  const eligibleCategories = [...byCategory.entries()].filter(
    ([cat, chunks]) =>
      isGlobalEligible(cat) ||
      chunks.length >= PER_CATEGORY_THRESHOLD ||
      allUnsummarized.length >= config.context.autoSummarizeThreshold * 2
  );

  if (eligibleCategories.length === 0) return;

  logger.info('Running summarizer', {
    projectId: opts.projectId,
    totalUnsummarized: allUnsummarized.length,
    categories: eligibleCategories.length,
    categoriesList: eligibleCategories.map(([cat]) => cat),
    provider: opts.provider.providerName,
    maxPromptTokens,
    maxOutputTokens: summarizerMaxOutputTokens,
  });

  const { adapter, baseUrl, apiKey } = opts.provider;
  let hadFailure = false;
  let processedCategories = 0;

  for (const [category, chunks] of eligibleCategories) {
    let existing = await summariesRepo.findByCategory(opts.projectId, category);
    let remainingChunks = [...chunks];
    let categoryProcessed = false;
    let batchNumber = 0;

    while (remainingChunks.length > 0) {
      const batch = takeCategoryBatch(remainingChunks, category, existing, maxPromptTokens);
      const isMerge = !!existing && existing.content.length > 0;
      const existingCategories = existing
        ? parseStoredStringArray(existing.categoriesList)
        : [];
      const prompt = isMerge
        ? buildMergeSummaryPrompt(batch, existing!, category, existingCategories)
        : buildNewSummaryPrompt(batch, category);
      batchNumber++;

      try {
        const proxyRequest = {
          model: opts.model,
          messages: [
            { role: 'user' as const, content: prompt },
          ],
          max_tokens: summarizerMaxOutputTokens,
          temperature: 0.2,
        };

        const runId = generateRunId();

        // Record summarizer input
        recordStat({
          projectId: opts.projectId,
          model: opts.model,
          runId,
          type: 'summarizer',
          direction: 'input',
          meta: {
            category,
            batchSize: batch.length,
            batchNumber,
            isMerge,
            totalCategoryChunks: chunks.length,
            existingSummaryVersion: existing?.version ?? 0,
          },
          tokens: estimateTokens(prompt),
          body: prompt,
        });

        const url = adapter.endpoint(baseUrl);
        const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey), {
          jobKey: `summarizer:${opts.projectId}`,
          projectId: opts.projectId,
        });

        const ctx: ParamFallbackContext = {
          projectId: opts.projectId,
          requestId: `summarizer-${runId}`,
          model: opts.model,
          providerName: opts.provider.providerName,
          providerType: opts.provider.providerType,
          url,
          requestHeaders: headers,
        };

        const { result: normalised } = await withParamFallback(
          proxyRequest,
          adapter,
          ctx,
          async (payload) => {
            const response = await axios.post(url, payload, {
              headers,
              timeout: SUMMARIZER_TIMEOUT_MS,
            });
            return adapter.parseResponse(response.data);
          },
        );
        const rawText = contentToText(normalised.choices?.[0]?.message?.content);

        const usage = (normalised.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined);

        if (!rawText.trim()) {
          logger.warn('Summarizer returned empty content', {
            projectId: opts.projectId,
            category,
            batch: batchNumber,
          });
          break;
        }

        const parsed = parseSummaryResponse(rawText);
        if (!parsed) break;

        const chunkIds = batch.map((c) => c.id);
        const mergedCategories = mergeSummaryCategories(
          category,
          existingCategories,
          parsed.categories
        );
        const categoriesList = JSON.stringify(mergedCategories);
        const remainingAfterBatch = remainingChunks.length - batch.length;

        if (isMerge) {
          const existingSourceIds = parseStoredStringArray(existing!.sourceChunkIds);
          const mergedIds = [...new Set([...existingSourceIds, ...chunkIds])];
          const title = parsed.oneLine || existing!.title;
          const oneLineSummary = parsed.oneLine || existing!.oneLineSummary;
          await summariesRepo.update(existing!.id, {
            title,
            content: parsed.content,
            oneLineSummary,
            categoriesList,
            sourceChunkIds: mergedIds,
          });
          existing = {
            ...existing!,
            title,
            content: parsed.content,
            oneLineSummary,
            categoriesList,
            sourceChunkIds: JSON.stringify(mergedIds),
            version: (existing!.version || 0) + 1,
            updatedAt: new Date().toISOString(),
          };
          logger.info('Summary updated', {
            projectId: opts.projectId,
            category,
            summaryId: existing.id.slice(0, 8),
            version: existing.version,
            batch: batchNumber,
            batchChunks: batch.length,
            remainingCategoryChunks: remainingAfterBatch,
            totalSourceChunks: mergedIds.length,
          });
        } else {
          const title = parsed.oneLine || `${capitalise(category)} — ${new Date().toISOString().slice(0, 10)}`;
          const created = await summariesRepo.insert({
            projectId: opts.projectId,
            title,
            content: parsed.content,
            sourceChunkIds: chunkIds,
            oneLineSummary: parsed.oneLine,
            categoriesList,
          });
          existing = created;
          logger.info('Summary created', {
            projectId: opts.projectId,
            category,
            batch: batchNumber,
            batchChunks: batch.length,
            remainingCategoryChunks: remainingAfterBatch,
          });
        }

        recordStat({
          projectId: opts.projectId,
          model: opts.model,
          runId,
          type: 'summarizer',
          direction: 'output',
          meta: {
            category,
            batchNumber,
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens,
            summariesCreated: isMerge ? 0 : 1,
            summariesModified: isMerge ? 1 : 0,
            chunksConsumed: chunkIds.length,
            remainingCategoryChunks: remainingAfterBatch,
          },
          tokens: usage?.completion_tokens ?? estimateTokens(rawText),
          body: rawText,
        });

        await chunksRepo.markSummarized(chunkIds);
        remainingChunks = remainingChunks.slice(batch.length);
        categoryProcessed = true;
      } catch (err) {
        hadFailure = true;
        logger.error('Summarizer failed for category', {
          category,
          batch: batchNumber,
          batchChunks: batch.length,
          remainingCategoryChunks: remainingChunks.length,
          error: String(err),
        });
        break;
      }
    }

    if (categoryProcessed) {
      processedCategories++;
    }
  }

  const remainingUnsummarized = await chunksRepo.countUnsummarized(opts.projectId);
  if (shouldPersistSuccessfulRun(hadFailure, remainingUnsummarized)) {
    await setSummarizerLastSuccessfulRunAt(opts.projectId, new Date().toISOString());
  } else if (trigger === 'scheduled') {
    logger.debug('Scheduled summarizer run did not advance watermark', {
      projectId: opts.projectId,
      hadFailure,
      remainingUnsummarized,
      lastSuccessfulRunAt,
    });
  }

  logger.info('Summarization complete', {
    projectId: opts.projectId,
    categoriesProcessed: processedCategories,
    hadFailure,
    remainingUnsummarized,
  });
  await logTaskRun({
    projectId: opts.projectId,
    taskType: 'summarizer',
    model: opts.model,
    providerName: opts.provider.providerName,
    providerType: opts.provider.providerType,
    status: hadFailure ? 'error' : 'success',
    summary: hadFailure
      ? `Partial failure: ${processedCategories} categories processed`
      : `${processedCategories} categories processed`,
    errorMessage: hadFailure ? 'One or more categories failed' : undefined,
  });
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
