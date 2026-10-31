/**
 * Knowledge references for chat turns.
 *
 * The chat UI lets the user attach stored knowledge entities (a summary, a
 * finding, or a recorded file) to a message. Unlike file/image attachments,
 * these are resolved server-side from the project's knowledge base and
 * rendered into the prompt, so the model gets the exact stored data — plus,
 * for a file, everything linked to it (its chunks and summaries).
 *
 * Resolution is always project-scoped: a reference to an entity in another
 * project is silently dropped rather than leaking it into the turn.
 */
import { findingsRepo, type FindingRecord } from '../db/repositories/findings';
import { summariesRepo } from '../db/repositories/summaries';
import { filesRepo } from '../db/repositories/files';
import { logger } from '../utils/logger';

export type KnowledgeRefType = 'summary' | 'finding' | 'file';

export interface KnowledgeRef {
  type: KnowledgeRefType;
  id: string;
}

/** Cap how much linked data a single file reference pulls in. */
const MAX_FILE_CHUNKS = 100;
const MAX_FILE_SUMMARIES = 40;

function parseCategoriesList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function renderSummaryRef(summary: {
  id: string;
  title: string;
  oneLineSummary: string;
  categoriesList: string | null;
  content: string;
  sourceChunkIds: string | null;
  updatedAt: unknown;
}): string {
  const categories = parseCategoriesList(summary.categoriesList);
  const sourceChunkIds = parseStringArray(summary.sourceChunkIds);
  return [
    `## Attached summary: ${summary.title} (${summary.id})`,
    categories.length > 0 ? `Categories: ${categories.join(', ')}` : undefined,
    summary.oneLineSummary ? `One-line: ${summary.oneLineSummary}` : undefined,
    sourceChunkIds.length > 0 ? `Source chunks (${sourceChunkIds.length}): ${sourceChunkIds.join(', ')}` : undefined,
    '',
    summary.content,
  ].filter((line) => line !== undefined).join('\n');
}

function renderFindingRef(finding: FindingRecord): string {
  const actions = finding.actions.length > 0
    ? finding.actions
        .map((action) => `- ${action.action} ${action.targetType} ${action.targetId}${action.updateText ? `: "${action.updateText}"` : ''}`)
        .join('\n')
    : '- (none)';
  const related = finding.relatedIds;
  return [
    `## Attached finding: ${finding.title} (${finding.id})`,
    `Type: ${finding.type} | Severity: ${finding.severity} | Status: ${finding.status}`,
    '',
    finding.description,
    '',
    'Proposed actions:',
    actions,
    '',
    `Related ids: chunks [${related.chunkIds.join(', ')}], summaries [${related.summaryIds.join(', ')}], findings [${related.findingIds.join(', ')}]`,
  ].join('\n');
}

async function renderFileRef(projectId: string, file: {
  id: string;
  fileName: string;
  purpose: string;
}): Promise<string> {
  const [chunks, summaries] = await Promise.all([
    filesRepo.findChunksByFileId(file.id),
    filesRepo.findSummariesByFileId(file.id),
  ]);

  const chunkLines = chunks.slice(0, MAX_FILE_CHUNKS).map((chunk) => {
    const confidence = typeof chunk.confidence === 'number' ? `${Math.round(chunk.confidence * 100)}%` : '';
    return `- ${chunk.id} [${chunk.category}${confidence ? `, ${confidence}` : ''}] ${chunk.fact}`;
  });
  if (chunks.length > MAX_FILE_CHUNKS) {
    chunkLines.push(`- …and ${chunks.length - MAX_FILE_CHUNKS} more chunks`);
  }

  const summaryLines = summaries.slice(0, MAX_FILE_SUMMARIES).map(
    (summary) => `- ${summary.id} ${summary.title}: ${summary.oneLineSummary}`
  );
  if (summaries.length > MAX_FILE_SUMMARIES) {
    summaryLines.push(`- …and ${summaries.length - MAX_FILE_SUMMARIES} more summaries`);
  }

  return [
    `## Attached file: ${file.fileName} (${file.id})`,
    file.purpose ? `Purpose: ${file.purpose}` : undefined,
    '',
    `Linked chunks (${chunks.length}):`,
    chunkLines.length > 0 ? chunkLines.join('\n') : '- (none)',
    '',
    `Linked summaries (${summaries.length}):`,
    summaryLines.length > 0 ? summaryLines.join('\n') : '- (none)',
  ].filter((line) => line !== undefined).join('\n');
}

/**
 * Resolve knowledge references into prompt text blocks.
 *
 * Returns the rendered blocks in input order. Missing or cross-project
 * entities are dropped with a warning so a stale UI selection cannot fail the
 * whole turn.
 */
export async function resolveKnowledgeReferences(
  projectId: string,
  refs: KnowledgeRef[]
): Promise<string[]> {
  const blocks: string[] = [];

  for (const ref of refs) {
    try {
      if (ref.type === 'summary') {
        const summary = await summariesRepo.findById(ref.id);
        if (!summary || summary.projectId !== projectId) {
          logger.warn('Chat knowledge ref: summary not found in project', { projectId, refId: ref.id });
          continue;
        }
        blocks.push(renderSummaryRef(summary));
        continue;
      }

      if (ref.type === 'finding') {
        const finding = await findingsRepo.findById(ref.id);
        if (!finding || finding.projectId !== projectId) {
          logger.warn('Chat knowledge ref: finding not found in project', { projectId, refId: ref.id });
          continue;
        }
        blocks.push(renderFindingRef(finding));
        continue;
      }

      if (ref.type === 'file') {
        const file = await filesRepo.findByIdForProject(projectId, ref.id);
        if (!file) {
          logger.warn('Chat knowledge ref: file not found in project', { projectId, refId: ref.id });
          continue;
        }
        blocks.push(await renderFileRef(projectId, file));
        continue;
      }
    } catch (err) {
      logger.warn('Chat knowledge ref resolution failed', {
        projectId,
        refType: ref.type,
        refId: ref.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return blocks;
}

/** Prefix used to label resolved knowledge blocks inside a user message. */
export const KNOWLEDGE_REF_HEADER = 'Attached project knowledge:';
