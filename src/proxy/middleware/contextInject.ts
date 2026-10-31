import type { Request, Response, NextFunction } from 'express';
import {
  selectContext,
  prepareGathererContextSelection,
  type ContextCandidate,
  type GathererContextSelection,
} from '../../context/selector';
import { assembleContextMessage, injectContextIntoMessages } from '../../context/assembler';
import { logger } from '../../utils/logger';
import { estimateTokens } from '../../utils/tokens';
import { recordStat } from '../../utils/stats';
import { getSystemModelConfig } from '../../config/systemModels';
import type { ChatMessage, ProxyRequest } from '../adapters/adapter';
import { isToolContinuation } from '../toolContinuation';
import { stripModelPrefix } from '../modelSelection';
import {
  readContextReplayForSession,
  readContextInjectionRoleForSession,
  writeContextReplayForSession,
  writeContextInjectionRoleForSession,
  clearContextReplayForSession,
} from '../contextReplay';


const PROJECT_CONTEXT_SHORTLIST_TAG = 'project_context_shortlist';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      contextApplied?: boolean;
      toolContinuation?: boolean;
      gathererSelectionContext?: GathererContextSelection;
      /**
       * Full assembled `## Project Context` block for the gatherer when
       * the gatherer stage is enabled.  The gatherer normally runs
       * blind to past knowledge, but with the two-stage design the
       * main model later wants the gatherer's `<gatherer_analysis>`
       * handoff to be informed by what we already know — otherwise the
       * gatherer re-derives facts that are already in the knowledge
       * store.  `buildGathererRequest` injects this as a system
       * message (between the gatherer system prompt and the user
       * messages) so the cheap model can use it as a starting point.
       */
      gathererContextBlock?: string;
    }
  }
}

export async function contextInjectMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.projectId) {
    next();
    return;
  }

  const body = req.body as ProxyRequest;
  if (!body?.messages || !Array.isArray(body.messages)) {
    next();
    return;
  }

  const requestId = (req.headers['x-request-id'] as string | undefined) ?? generateId();
  const messages = body.messages as ChatMessage[];
  const toolContinuation = isToolContinuation(messages);
  const sessionId = (req.headers['x-session-id'] as string | undefined) ?? (req.headers['x-interaction-id'] as string | undefined);
  const systemModels = getSystemModelConfig();
  const requestContextMode =
    systemModels.requestContextMode === 'basic' ||
    systemModels.requestContextMode === 'selector' ||
    systemModels.requestContextMode === 'gatherer'
      ? systemModels.requestContextMode
      : systemModels.gatherer.trim().length > 0
        ? 'gatherer'
        : 'selector';

  // If the gatherer and main model are the same base model (after stripping
  // provider prefixes), skip the gatherer stage to avoid a 400 error when
  // switching between providers that serve the same underlying model.
  const gathererModelName = systemModels.gatherer.trim();
  const mainModelName = body.model ?? '';
  const sameBaseModel = !!gathererModelName && !!mainModelName &&
    stripModelPrefix(gathererModelName) === stripModelPrefix(mainModelName);
  const gathererEnabled = requestContextMode === 'gatherer' && !!gathererModelName && !!sessionId && !sameBaseModel;

  if (sameBaseModel) {
    logger.info('Gatherer skipped in context inject — gatherer model and main model share the same base model', {
      projectId: req.projectId,
      sessionId,
      requestId,
      gathererModel: gathererModelName,
      mainModel: mainModelName,
      baseModel: stripModelPrefix(gathererModelName),
    });
  }

  req.toolContinuation = toolContinuation;
  req.contextApplied = false;
  req.gathererSelectionContext = undefined;

  // Tool-use continuations should reuse the original context bundle
  // for the turn rather than recomputing retrieval on every hop.
  if (toolContinuation) {
    const cachedContext = readContextReplayForSession(req.projectId, sessionId);
    if (cachedContext) {
      const cachedRole = readContextInjectionRoleForSession(req.projectId, sessionId);
      body.messages = injectContextIntoMessages(messages, cachedContext, { role: cachedRole });
      req.contextApplied = true;
      logger.info('Tool continuation — replayed cached context into messages', {
        projectId: req.projectId,
        sessionId,
        requestId,
        messageCountBefore: messages.length,
        messageCountAfter: body.messages.length,
        contextBlockLength: cachedContext.length,
        injectionRole: cachedRole,
      });
    } else {
      logger.debug('No cached context available for tool continuation', {
        projectId: req.projectId,
        hasSessionId: !!sessionId,
      });
    }

    req.headers['x-ic-request-id'] = requestId;
    req.body = body;
    next();
    return;
  }

  clearContextReplayForSession(req.projectId, sessionId);

  try {
    if (requestContextMode === 'basic') {
      const selectionContext = await prepareGathererContextSelection(req.projectId, messages);

      if (selectionContext) {
        const contextBlock = assembleContextShortlistMessage(selectionContext, req.projectName ?? 'Project');
        const messageCountBefore = body.messages.length;
        body.messages = injectContextIntoMessages(messages, contextBlock, { role: 'user' });
        req.contextApplied = true;
        writeContextReplayForSession(req.projectId, sessionId, contextBlock);
        writeContextInjectionRoleForSession(req.projectId, sessionId, 'user');
        logger.info('Context shortlist injected into messages (basic mode)', {
          projectId: req.projectId,
          sessionId,
          requestId,
          requestContextMode,
          messageCountBefore,
          messageCountAfter: body.messages.length,
          referencedFileCount: selectionContext.referencedFiles.length,
          prioritySummaryCount: selectionContext.prioritySummaryIds.length,
          summaryDescriptorCount: selectionContext.summaryDescriptors.length,
          unsummarizedCategoryCount: selectionContext.unsummarizedCategories.length,
          relevantFindingCount: selectionContext.relevantFindings.length,
        });
      } else {
        logger.info('No shortlist candidates selected — request body unchanged in basic mode', {
          projectId: req.projectId,
          sessionId,
          requestId,
          requestContextMode,
          messageCount: body.messages.length,
          model: body.model,
        });
      }

      req.headers['x-ic-request-id'] = requestId;
      req.body = body;
      next();
      return;
    }

    if (gathererEnabled) {
      const gathererSelectionContext = await prepareGathererContextSelection(req.projectId, messages);
      req.gathererSelectionContext = gathererSelectionContext ?? undefined;

      // Also build the full assembled `## Project Context` block so
      // the gatherer has the same past knowledge the main model would
      // see.  Without this, the gatherer re-derives facts already
      // stored in the knowledge base, and the main model's
      // `<gatherer_analysis>` handoff duplicates content that the
      // project context shortlist already covers.
      try {
        const { candidates, method } = await selectContext(
          req.projectId,
          messages,
          body.model ?? 'unknown',
          requestId,
          req.userId,
          sessionId
        );
        if (candidates.length > 0) {
          const contextBlock = assembleContextMessage(candidates, req.projectName ?? 'Project');
          if (contextBlock) {
            req.gathererContextBlock = contextBlock;
            logContextInjection(
              candidates,
              contextBlock,
              method,
              req.projectId,
              sessionId,
              requestId,
              body.model ?? 'unknown'
            );
            logger.info('Project context block prepared for gatherer request', {
              projectId: req.projectId,
              sessionId,
              requestId,
              method,
              candidateCount: candidates.length,
              contextBlockLength: contextBlock.length,
              hasSelectionContext: !!gathererSelectionContext,
            });
          } else {
            logger.info('Gatherer selection present but no assembled context block', {
              projectId: req.projectId,
              sessionId,
              requestId,
              hasSelectionContext: !!gathererSelectionContext,
            });
          }
        } else {
          logger.info('No context candidates selected for gatherer request', {
            projectId: req.projectId,
            sessionId,
            requestId,
            hasSelectionContext: !!gathererSelectionContext,
          });
        }
      } catch (ctxErr) {
        // Context-block build failure is non-fatal — the gatherer can
        // still run with the shortlist alone.
        logger.error('Failed to build project context block for gatherer request', {
          projectId: req.projectId,
          sessionId,
          requestId,
          error: String(ctxErr),
        });
      }

      req.headers['x-ic-request-id'] = requestId;
      req.body = body;
      next();
      return;
    }

    // Select relevant context
    const { candidates, method } = await selectContext(
      req.projectId,
      messages,
      body.model ?? 'unknown',
      requestId,
      req.userId,
      sessionId
    );

    // Build and inject context block
    if (candidates.length > 0) {
      const contextBlock = assembleContextMessage(candidates, req.projectName ?? 'Project');
      if (contextBlock) {
        logContextInjection(candidates, contextBlock, method, req.projectId, sessionId, requestId, body.model ?? 'unknown');
        const messageCountBefore = body.messages.length;
        body.messages = injectContextIntoMessages(messages, contextBlock);
        req.contextApplied = true;
        writeContextReplayForSession(req.projectId, sessionId, contextBlock);
        logger.info('Context injected into messages (non-gatherer path)', {
          projectId: req.projectId,
          sessionId,
          requestId,
          method,
          candidateCount: candidates.length,
          messageCountBefore,
          messageCountAfter: body.messages.length,
          contextBlockLength: contextBlock.length,
          model: body.model,
        });
      }
    } else {
      logger.info('No context candidates selected — request body unchanged by context injection', {
        projectId: req.projectId,
        sessionId,
        requestId,
        method,
        messageCount: body.messages.length,
        model: body.model,
      });
    }

    // The `record_learning` system instruction is injected by
    // createLearningToolsMiddleware, which runs after this one.

    // Store request ID for downstream use
    req.headers['x-ic-request-id'] = requestId;
    req.body = body;
  } catch (err) {
    // Context injection failure is non-fatal — continue without context
    logger.error('Context injection failed', { error: String(err) });
  }

  next();
}

export function assembleContextShortlistMessage(
  selectionContext: GathererContextSelection,
  projectName: string,
): string {
  const sections: string[] = [];

  // ── Referenced files ───
  if (selectionContext.referencedFiles.length > 0) {
    const files = selectionContext.referencedFiles.map((f) =>
      `- \`${f.fileName}\` — ${f.purpose || '(no description)'} (${f.chunkCount} chunks, ${f.summaryCount} summaries)`
    );
    sections.push('### Referenced Files');
    sections.push('Entry points into the codebase from your request:');
    sections.push(files.join('\n'));
    sections.push('');
  }

  // ── Summary descriptors grouped by priority ───
  if (selectionContext.summaryDescriptors.length > 0) {
    sections.push('### Summaries Available');
    sections.push('Each summary has full details you can fetch. The one-liner shows the topic; the full summary contains actionable technical detail that reduces file-reading.');

    // Priority labels for grouping
    const priorityLabel: Record<string, string> = {
      'file-linked': '🔗 Linked to files',
      'global': '🌐 Global (applies to whole project)',
      'candidate': '📋 Candidate (potentially relevant)',
    };

    const byPriority: Record<string, typeof selectionContext.summaryDescriptors> = {};
    for (const desc of selectionContext.summaryDescriptors) {
      const p = desc.priority || 'candidate';
      if (!byPriority[p]) byPriority[p] = [];
      byPriority[p].push(desc);
    }

    for (const [priority, descriptors] of Object.entries(byPriority)) {
      sections.push(`**${priorityLabel[priority] || priority}**`);

      for (const desc of descriptors) {
        const catTag = desc.categories.length > 0 ? `[${desc.categories.join(', ')}]` : '';
        const lines: string[] = [];
        lines.push(`- \`${desc.id.slice(0, 12)}…\` ${catTag}`);
        lines.push(`  ${desc.oneLineSummary}`);

        // Preview bullets (first 2-3 from the full summary)
        if (desc.previewBullets && desc.previewBullets.length > 0) {
          for (const bullet of desc.previewBullets) {
            lines.push(`  ${bullet}`);
          }
        }

        // Linked files info
        if (desc.linkedFileIds.length > 0) {
          lines.push(`  Covers ${desc.linkedFileIds.length} file(s)`);
        }

        // Clear fetch instruction
        lines.push(`  → Fetch: \`ic({ ops: [{ action: "get", type: "summary", ids: ["${desc.id}"] }] })\``);
        sections.push(lines.join('\n'));
      }
    }
    sections.push('');
  }

  // ── Unsummarized categories ───
  if (selectionContext.unsummarizedCategories.length > 0) {
    const cats = selectionContext.unsummarizedCategories.map((c) => {
      const dateStr = c.newestChunkCreatedAt
        ? new Date(c.newestChunkCreatedAt).toISOString().slice(0, 10)
        : 'unknown date';
      return `- ${c.id} (${c.chunkCount} chunk${c.chunkCount !== 1 ? 's' : ''}, ${dateStr})`;
    });
    sections.push('### Unsummarized Categories');
    sections.push('New chunks that haven\'t been summarized yet. These may contain fresh facts:');
    sections.push(cats.join('\n'));
    sections.push('');
  }

  // ── Relevant findings ───
  if (selectionContext.relevantFindings.length > 0) {
    const findings = selectionContext.relevantFindings.map((f) =>
      `- ${f.title}${f.severity ? ` [severity: ${f.severity}]` : ''}`
    );
    sections.push('### Relevant Findings');
    sections.push('Known gaps or issues relevant to your request:');
    sections.push(findings.join('\n'));
    sections.push('');
  }

  return [
    `## Project Context Shortlist — ${projectName}`,
    '',
    'This block is a compact index of stored project knowledge for this request.',
    'It is not the user\'s request and not a task to answer directly.',
    '',
    'The one-liners below are summaries-of-summaries — they give you the topic,',
    'not the detail. Full summaries contain structured technical detail that',
    'directly reduces how much source code you need to read. Fetching relevant',
    'summaries early via the \`ic\` tool will likely reduce your overall reasoning',
    'time by giving you key facts upfront instead of requiring file exploration.',
    '',
    'FOLLOW THIS WORKFLOW:',
    '1. Evaluate — identify which referenced files and summaries are relevant.',
    '2. Fetch summaries �� use \`ic\` with action \`get\`, type \`summary\`, and the IDs below.',
    '3. Read source files — use read_file, grep_search, etc. The ic tool returns metadata, not source code.',
    '4. Synthesize — combine context knowledge with file readings.',
    '5. Record learnings — use \`ic record\` after reading source files.',
    '6. Correct stale data — use \`ic update\` on \`summary\` or \`chunk\` if outdated.',
    '',
    'TIP: Prefer fetching summaries (step 2) before broad file exploration (step 3).',
    'Only dig into files when summaries are missing or insufficient.',
    '',
    `<${PROJECT_CONTEXT_SHORTLIST_TAG}>`,
    sections.join('\n'),
    `</${PROJECT_CONTEXT_SHORTLIST_TAG}>`,
    '',
    '---',
  ].join('\n');
}

function generateId(): string {
  return `ic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Context injection logging ────────────────────────────────────────────────

function logContextInjection(
  candidates: ContextCandidate[],
  contextBlock: string,
  method: string,
  projectId: string,
  sessionId: string | undefined,
  requestId: string,
  model: string,
): void {
  const chunkCount = candidates.filter((c) => c.type === 'chunk').length;
  const summaryCount = candidates.filter((c) => c.type === 'summary').length;
  const findingCount = candidates.filter((c) => c.type === 'finding').length;
  const totalTokens = estimateTokens(contextBlock);

  // Structured per-candidate summary — IDs, types, categories, content preview
  const items = candidates.map((c, i) => ({
    idx: i,
    type: c.type,
    id: c.id.slice(0, 8),
    cat: c.category ?? '-',
    preview: (c.fullContent ?? c.content).slice(0, 120).replace(/\n/g, ' '),
  }));

  logger.info('Context injected', {
    method,
    chunks: chunkCount,
    summaries: summaryCount,
    findings: findingCount,
    totalTokens,
    items,
  });

  // Full context block at info level — what the main model actually sees
  logger.info('Context block (full)', { contextBlock });

  // Stats: record the assembled context block (output of knowledge filtering)
  recordStat({
    projectId,
    sessionId,
    requestId,
    model,
    runId: requestId,
    type: 'context_injection',
    direction: 'output',
    meta: {
      method,
      numChunksSelected: chunkCount,
      numSummariesSelected: summaryCount,
      numFindingsSelected: findingCount,
      selectedIds: items.map((it) => `${it.type}:${it.id}`),
    },
    tokens: totalTokens,
    body: contextBlock,
  });
}
