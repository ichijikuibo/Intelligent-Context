import axios from 'axios';
import { chunksRepo } from '../db/repositories/chunks';
import { codeExtractsRepo } from '../db/repositories/codeExtracts';
import { filesRepo } from '../db/repositories/files';
import { findingsRepo, type FindingAction, type FindingRecord, type RelatedIds } from '../db/repositories/findings';
import { summariesRepo } from '../db/repositories/summaries';
import { type LearningChunk, type LearningCodeExtract, type LearningFile, type Summary } from '../db/schema';
import { logger } from '../utils/logger';
import { type ResolvedProvider } from '../proxy/upstream';
import { projectsRepo } from '../db/repositories/projects';
import { implementFinding } from '../findings/actionFinding';
import { recordStat, generateRunId } from '../utils/stats';
import { estimateTokens } from '../utils/tokens';
import { contentToText } from '../utils/messageContent';
import { getSystemModelConfig } from '../config/systemModels';
import type { ProxyRequest, ProxyResponse } from '../proxy/adapters/adapter';
import { getLearningToolsForClientProtocol } from '../proxy/tools/definitions';
import { runLearningToolAgentLoop } from '../proxy/tools/agentLoop';
import { withParamFallback, type ParamFallbackContext } from '../utils/paramFallback';
import { logTaskRun } from '../utils/taskRunLog';
import { applyUpstreamRequestMiddleware } from '../proxy/requestMiddleware';

export interface AnalyzerOptions {
  projectId: string;
  model: string;
  provider: ResolvedProvider;
}

interface AnalyzerFindingPayload {
  type?: string;
  severity?: string;
  title?: string;
  description?: string;
  actions?: FindingAction[];
  relatedIds?: RelatedIds;
}

interface AgentAnalyzerCompletion {
  updatedSummaryIds: string[];
  deletedChunkIds: string[];
  createdFindingIds: string[];
  notes: string[];
}

interface RecentFileHotspot {
  id: string;
  fileName: string;
  purpose: string;
  changedChunkIds: string[];
  linkedSummaryIds: string[];
  changedSummaryIds: string[];
  chunkCount: number;
  summaryCount: number;
  latestChunkCreatedAt?: string | null;
}

export async function runAnalyzer(opts: AnalyzerOptions, manualRun:boolean = false): Promise<void> {
  const [unsummarizedChunks, fileLinkedChunks, summaries, findings] = await Promise.all([
    chunksRepo.findUnsummarized(opts.projectId),
    chunksRepo.findFileLinkedByProject(opts.projectId),
    summariesRepo.findByProject(opts.projectId),
    findingsRepo.findByProject(opts.projectId),
  ]);
  const chunks = mergeUniqueChunks(unsummarizedChunks, fileLinkedChunks);

  //check that there have been at 3 new summaries or 10 new chunks since the last analysis run
  const project = await projectsRepo.findById(opts.projectId);
  if (!project) {
    logger.warn('Project not found', { projectId: opts.projectId });
    return;
  }
  if (project.analyzerLastRun && !manualRun) {
    const newChunkCount = chunks.filter((c) => c.createdAt > project.analyzerLastRun!).length;
    const newSummaryCount = summaries.filter((s) => s.updatedAt > project.analyzerLastRun!).length;
    if (
      newChunkCount < 10 &&
      newSummaryCount < 3
    ) {
      logger.debug('Not enough new data for analysis', {
        projectId: opts.projectId,
        newChunks: newChunkCount,
        newSummaries: newSummaryCount,
      });
      return;
    }
  }

  const knowledgeItemCount = chunks.length + summaries.length;
  if (knowledgeItemCount < 5) {
    logger.debug('Not enough active knowledge for analysis', {
      projectId: opts.projectId,
      unsummarizedChunks: chunks.length,
      fileLinkedChunks: fileLinkedChunks.length,
      summaries: summaries.length,
    });
    return;
  }

  logger.info('Running deep analysis', {
    projectId: opts.projectId,
    unsummarizedChunks: unsummarizedChunks.length,
    fileLinkedChunks: fileLinkedChunks.length,
    chunksConsidered: chunks.length,
    summaries: summaries.length,
    existingFindings: findings.length,
    provider: opts.provider.providerName,
  });

  const recentFiles = await buildRecentFileHotspots(opts.projectId, project.analyzerLastRun, chunks);

  const analyzerConfig = getSystemModelConfig();
  const useAgentAnalyzer = analyzerConfig.enableAgentAnalyzer;

  if (useAgentAnalyzer) {
    await runAgentAnalyzer({
      opts,
      project,
      chunks,
      summaries,
      findings,
      recentFiles,
      maxTurns: analyzerConfig.analyzerAgentMaxTurns,
    });
    return;
  }

  const chunkIds = chunks.map((chunk) => chunk.id);
  const [filesByChunk, codeExtractsByChunk] = chunkIds.length > 0
    ? await Promise.all([
      filesRepo.findByChunkIds(chunkIds),
      codeExtractsRepo.findByChunkIds(chunkIds),
    ])
    : [
      new Map<string, LearningFile[]>(),
      new Map<string, LearningCodeExtract[]>(),
    ];

  const knowledgePayload = buildAnalyzerKnowledgePayload(
    chunks,
    summaries,
    findings,
    filesByChunk,
    codeExtractsByChunk,
    recentFiles,
  );

  const knowledgeText = JSON.stringify(knowledgePayload, null, 2);

  const prompt = `You are a senior software architect reviewing accumulated knowledge about a project.

Analyse the following knowledge base and identify:
1. Potential contradictions or inconsistencies between facts
2. Missing best practices (e.g., no testing conventions mentioned)
3. Security concerns (hardcoded secrets, SQL injection risks, missing auth)
4. Refactoring opportunities
5. Positive patterns worth reinforcing
6. Large summaries are better than many summaries, if multiple summaries belong together, merge them into one summary and update the summary text to include all relevant information.

The knowledge payload includes:
- recentFiles: files whose linked chunks changed since the last analyzer run, plus the summary IDs linked to those files
- chunk.createdAt for all chunks
- summary.createdAt and summary.updatedAt
- finding.createdAt, reviewedAt, actionsAppliedAt, and status
- linked files and code extracts for file-grounded chunks

Use these timestamps to decide which information is newer and which older knowledge is stale.
Prioritize the recentFiles list first when deciding which summaries or source-backed chunks need attention.
File-grounded chunks are included even when already summarized so obsolete source-backed knowledge can be deleted or rewritten.
Existing findings are included to avoid duplicates and for cleanup of previously reviewed findings.
If you delete a chunk, do not emit separate delete actions for linked files or code extracts; deleting the chunk already soft-deletes that provenance.

When existing findings have status "actioned", the user has already manually applied the suggested actions.
Emit a new finding with a "done" action targeting the actioned finding to mark it implemented.
When existing findings have status "false", the finding itself was incorrect or based on outdated data.
Emit a new finding that cleans up by deleting or updating the problematic chunks/summaries that led to the false finding,
then marks the false finding as done. Use the "relatedIds" on the false finding to identify which data to clean up.

For each finding, output a JSON object in this format:
{"type":"security|refactor|contradiction|gap|positive","severity":"critical|high|medium|low|info","title":"Short title","description":"Detailed description","actions":[],"relatedIds":{"chunkIds":[],"summaryIds":[],"findingIds":[]}}
Actions is an options array of actions that will be auto parsed and performed to address the finding, 
this should be limited to data that might be problematic and not general findings. Item with the most recent date should be kept in the event of a conflict/contradiction, or a summary should be updated if it is missing information.
Actions format: {"action":"delete|update|done","targetType":"chunk|summary|file|finding","targetId":"id of the target","updateText":"text to update to (only for update action)"}
Use action "done" only with targetType "finding" when another finding should be marked implemented, any information that conflicts with this should be deleted too.
The "relatedIds" field must include the IDs of all chunks, summaries, and existing findings that are relevant to this finding. Include IDs from the knowledge payload that informed or triggered this finding. This is required for traceability — always provide at least one relevant ID even if empty arrays otherwise.
It there is an area of the system where more information is needed, output a finding with type "gap" and severity "info" and describe what is missing, but do not output any actions for this finding(future calls will focus on gather information around this area, delete finding when gap is filled).
Output ONLY a JSON array of findings. If no findings, output [].

## Project Knowledge Base
${knowledgeText}`;

  const { adapter, baseUrl, apiKey } = opts.provider;

  try {
    const proxyRequest: ProxyRequest = {
      model: opts.model,
      messages: [{ role: 'user' as const, content: prompt }],
      max_tokens: 20000,
      temperature: 0.5,
    };

    const url = adapter.endpoint(baseUrl);
    const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey), {
      jobKey: `analyzer:${opts.projectId}`,
      projectId: opts.projectId,
    });

    const runId = generateRunId();

    // Record analyzer input
    recordStat({
      projectId: opts.projectId,
      model: opts.model,
      runId,
      type: 'analyzer',
      direction: 'input',
      meta: {
        numUnsummarizedChunks: unsummarizedChunks.length,
        numFileLinkedChunks: fileLinkedChunks.length,
        numChunks: chunks.length,
        numSummaries: summaries.length,
        numExistingFindings: findings.length,
      },
      tokens: estimateTokens(prompt),
      body: prompt,
    });
    const ctx: ParamFallbackContext = {
      projectId: opts.projectId,
      requestId: `analyzer-${runId}`,
      model: opts.model,
      providerName: opts.provider.providerName,
      providerType: opts.provider.providerType,
      url,
      requestHeaders: headers,
    };

    const { result: normalised, paramStripped } = await withParamFallback(
      proxyRequest,
      adapter,
      ctx,
      async (payload) => {
        const response = await axios.post(url, payload, {
          headers,
          timeout: 900_000,
        });
        return adapter.parseResponse(response.data);
      },
    );
    const rawContent = normalised.choices?.[0]?.message?.content;
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? []);

    const usage = (normalised.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined);
    const parsedFindings = parseAnalyzerFindings(content);
    if (!parsedFindings) {
      logger.warn('Failed to parse analyzer response', { content: content.slice(0, 200) });
      return;
    }

    const now = new Date();
    let actionsTaken = 0;

    for (const f of parsedFindings) {
      const createdFinding = await findingsRepo.insert({
        projectId: opts.projectId,
        type: f.type ?? 'general',
        severity: f.severity ?? 'info',
        title: f.title ?? 'Unnamed finding',
        description: f.description ?? '',
        relatedIds: f.relatedIds ?? { chunkIds: [], summaryIds: [], findingIds: [] },
        actions: f.actions ?? [],
        status: 'open',
        createdAt: now,
      });

      if (Array.isArray(f.actions) && f.actions.length > 0 && createdFinding.actions.length === 0) {
        logger.warn('Analyzer finding actions could not be parsed', {
          projectId: opts.projectId,
          findingTitle: f.title,
          actions: f.actions,
        });
      }

      if (createdFinding.actions.length > 0) {
        actionsTaken += createdFinding.actions.length;
        try {
          await implementFinding(createdFinding.id);
          logger.info('Analyzer finding actions applied', {
            projectId: opts.projectId,
            findingId: createdFinding.id,
            findingTitle: createdFinding.title,
            actionsApplied: createdFinding.actions.length,
          });
        } catch (err) {
          logger.warn('Failed to apply analyzer finding actions', {
            projectId: opts.projectId,
            findingId: createdFinding.id,
            findingTitle: createdFinding.title,
            error: String(err),
          });
        }
      }
    }

    recordStat({
      projectId: opts.projectId,
      model: opts.model,
      runId,
      type: 'analyzer',
      direction: 'output',
      meta: {
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        findingsAdded: parsedFindings.length,
        actionsTaken,
      },
      tokens: usage?.completion_tokens ?? estimateTokens(content),
      body: content,
    });

    //update analyzer last run timestamp
    await projectsRepo.updateAnalyzerLastRun(opts.projectId);
    logger.info('Analysis complete', {
      projectId: opts.projectId,
      findings: parsedFindings.length,
    });
    await logTaskRun({
      projectId: opts.projectId,
      taskType: 'analyzer',
      model: opts.model,
      providerName: opts.provider.providerName,
      providerType: opts.provider.providerType,
      status: 'success',
      summary: `${parsedFindings.length} findings, ${actionsTaken} actions applied`,
    });
  } catch (err) {
    logger.error('Analyzer failed', { error: String(err) });
    await logTaskRun({
      projectId: opts.projectId,
      taskType: 'analyzer',
      model: opts.model,
      providerName: opts.provider.providerName,
      providerType: opts.provider.providerType,
      status: 'error',
      summary: 'Analyzer failed',
      errorMessage: String(err),
    });
  }
}

async function runAgentAnalyzer(args: {
  opts: AnalyzerOptions;
  project: { analyzerLastRun?: unknown };
  chunks: LearningChunk[];
  summaries: Summary[];
  findings: FindingRecord[];
  recentFiles: RecentFileHotspot[];
  maxTurns: number;
}): Promise<void> {
  const { opts, project, chunks, summaries, findings, recentFiles, maxTurns } = args;
  const { adapter, baseUrl, apiKey } = opts.provider;

  const request: ProxyRequest = {
    model: opts.model,
    messages: [{
      role: 'user',
      content: buildAgentAnalyzerPrompt(opts.projectId, project.analyzerLastRun, chunks, summaries, findings, recentFiles),
    }],
    max_tokens: 12000,
    temperature: 0.2,
    tools: getLearningToolsForClientProtocol(opts.provider.providerType === 'anthropic' ? 'anthropic' : 'openai'),
    tool_choice: 'auto',
  };

  const prompt = contentToText(request.messages[0]?.content);
  const url = adapter.endpoint(baseUrl);
  const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey), {
    jobKey: `analyzer:${opts.projectId}`,
    projectId: opts.projectId,
  });
  const runId = generateRunId();
  const requestId = `analyzer-${runId}`;

  const providerMeta = {
    projectId: opts.projectId,
    requestId,
    model: opts.model,
    providerName: opts.provider.providerName,
    providerType: opts.provider.providerType,
    url,
    requestHeaders: headers,
  } as const;

  try {
    recordStat({
      projectId: opts.projectId,
      model: opts.model,
      runId,
      type: 'analyzer',
      direction: 'input',
      meta: {
        mode: 'agent',
        numChunks: chunks.length,
        numSummaries: summaries.length,
        numExistingFindings: findings.length,
        maxTurns,
      },
      tokens: estimateTokens(prompt),
      body: prompt,
    });

    let responseData: unknown;
    let normalised: ProxyResponse;
    const ctx: ParamFallbackContext = providerMeta;
    ({ result: normalised } = await withParamFallback(
      request,
      adapter,
      ctx,
      async (payload) => {
        const response = await axios.post(url, payload, {
          headers,
          timeout: 900_000,
        });
        responseData = response.data;
        return adapter.parseResponse(response.data);
      },
    ));

    const initialToolCalls = (normalised.choices?.[0]?.message as { tool_calls?: unknown } | undefined)?.tool_calls;
    let internalTurnCount = 0;

    if (normalised.choices?.[0]?.finish_reason === 'tool_calls' || Array.isArray(initialToolCalls)) {
      const loopResult = await runLearningToolAgentLoop({
        url,
        headers,
        adapter,
        request,
        projectId: opts.projectId,
        requestId,
        providerName: opts.provider.providerName,
        providerType: opts.provider.providerType,
        initialResponseData: responseData,
        initialNormalizedResponse: normalised,
        maxTurns,
        toolClientProtocol: opts.provider.providerType === 'anthropic' ? 'anthropic' : 'openai',
      });

      responseData = loopResult.responseData;
      normalised = loopResult.normalizedResponse;
      internalTurnCount = loopResult.internalTurnCount;
    }

    const content = contentToText(normalised.choices?.[0]?.message?.content);
    const usage = (normalised.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined);
    const completion = parseAgentAnalyzerCompletion(content);

    recordStat({
      projectId: opts.projectId,
      model: opts.model,
      runId,
      type: 'analyzer',
      direction: 'output',
      meta: {
        mode: 'agent',
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        internalTurnCount,
        updatedSummaries: completion?.updatedSummaryIds.length,
        deletedChunks: completion?.deletedChunkIds.length,
        createdFindings: completion?.createdFindingIds.length,
      },
      tokens: usage?.completion_tokens ?? estimateTokens(content),
      body: content,
    });

    await projectsRepo.updateAnalyzerLastRun(opts.projectId);
    logger.info('Analysis complete', {
      projectId: opts.projectId,
      mode: 'agent',
      internalTurnCount,
      updatedSummaries: completion?.updatedSummaryIds.length ?? 0,
      deletedChunks: completion?.deletedChunkIds.length ?? 0,
      createdFindings: completion?.createdFindingIds.length ?? 0,
    });
    const successSummary = [
      completion?.updatedSummaryIds.length ? `${completion.updatedSummaryIds.length} summaries updated` : '',
      completion?.deletedChunkIds.length ? `${completion.deletedChunkIds.length} chunks deleted` : '',
      completion?.createdFindingIds.length ? `${completion.createdFindingIds.length} findings created` : '',
    ].filter(Boolean).join(', ') || 'No changes';
    await logTaskRun({
      ...providerMeta,
      taskType: 'analyzer-agent',
      status: 'success',
      summary: successSummary,
    });
  } catch (err) {
    logger.error('Analyzer agent failed', {
      projectId: opts.projectId,
      error: String(err),
    });
    await logTaskRun({
      ...providerMeta,
      taskType: 'analyzer-agent',
      status: 'error',
      summary: 'Analyzer agent failed',
      errorMessage: String(err),
    });
  }
}

function mergeUniqueChunks(
  unsummarizedChunks: LearningChunk[],
  fileLinkedChunks: LearningChunk[],
): LearningChunk[] {
  const merged = new Map<string, LearningChunk>();
  for (const chunk of [...unsummarizedChunks, ...fileLinkedChunks]) {
    if (!merged.has(chunk.id)) {
      merged.set(chunk.id, chunk);
    }
  }

  return [...merged.values()];
}

async function buildRecentFileHotspots(
  projectId: string,
  lastAnalyzerRun: unknown,
  chunks: LearningChunk[],
): Promise<RecentFileHotspot[]> {
  const changedChunks = chunks.filter((chunk) => hasChangedSince(chunk.createdAt, lastAnalyzerRun));
  if (changedChunks.length === 0) return [];

  const changedChunkIds = changedChunks.map((chunk) => chunk.id);
  const changedChunkById = new Map(changedChunks.map((chunk) => [chunk.id, chunk]));
  const filesByChunk = await filesRepo.findByChunkIds(changedChunkIds);
  const hotspots = new Map<string, RecentFileHotspot>();

  for (const chunkId of changedChunkIds) {
    const chunk = changedChunkById.get(chunkId);
    if (!chunk) continue;

    for (const file of filesByChunk.get(chunkId) ?? []) {
      const existing = hotspots.get(file.id) ?? {
        id: file.id,
        fileName: file.fileName,
        purpose: file.purpose,
        changedChunkIds: [],
        linkedSummaryIds: [],
        changedSummaryIds: [],
        chunkCount: 0,
        summaryCount: 0,
        latestChunkCreatedAt: formatTimestamp(chunk.createdAt),
      };

      if (!existing.changedChunkIds.includes(chunkId)) {
        existing.changedChunkIds.push(chunkId);
      }
      existing.chunkCount = existing.changedChunkIds.length;

      const chunkCreatedAt = formatTimestamp(chunk.createdAt);
      if (!existing.latestChunkCreatedAt || compareTimestampsDesc(existing.latestChunkCreatedAt, chunkCreatedAt) > 0) {
        existing.latestChunkCreatedAt = chunkCreatedAt;
      }

      hotspots.set(file.id, existing);
    }
  }

  const fileIds = [...hotspots.keys()];
  const summariesByFile = fileIds.length > 0
    ? await filesRepo.findSummariesByFileIds(fileIds)
    : new Map();

  return [...hotspots.values()]
    .map((hotspot) => {
      const linkedSummaries = summariesByFile.get(hotspot.id) ?? [];
      const linkedSummaryIds = linkedSummaries.map((summary: Summary) => summary.id);
      const changedSummaryIds = linkedSummaries
        .filter((summary: Summary) => hasChangedSince(summary.updatedAt ?? summary.createdAt, lastAnalyzerRun))
        .map((summary: Summary) => summary.id);

      return {
        ...hotspot,
        linkedSummaryIds,
        changedSummaryIds,
        summaryCount: linkedSummaryIds.length,
      };
    })
    .sort((left, right) =>
      right.changedSummaryIds.length - left.changedSummaryIds.length ||
      right.changedChunkIds.length - left.changedChunkIds.length ||
      compareTimestampsDesc(left.latestChunkCreatedAt, right.latestChunkCreatedAt) ||
      left.fileName.localeCompare(right.fileName)
    );
}

function buildAnalyzerKnowledgePayload(
  chunks: LearningChunk[],
  summaries: Summary[],
  findings: FindingRecord[],
  filesByChunk: Map<string, LearningFile[]>,
  codeExtractsByChunk: Map<string, LearningCodeExtract[]>,
  recentFiles: RecentFileHotspot[],
) {
  const activeFindings = findings.filter((f) => f.status !== 'implemented');
  return {
    recentFiles,
    chunks: chunks.map((chunk) => {
      const chunkFiles = filesByChunk.get(chunk.id) ?? [];
      const chunkExtracts = codeExtractsByChunk.get(chunk.id) ?? [];
      return {
        id: chunk.id,
        fact: chunk.fact,
        category: chunk.category,
        confidence: chunk.confidence,
        source: chunk.source,
        summarized: chunk.summarized,
        createdAt: formatTimestamp(chunk.createdAt),
        ...(chunkFiles.length > 0 ? {
          files: chunkFiles.map((file) => ({
            id: file.id,
            fileName: file.fileName,
            purpose: file.purpose,
            createdAt: formatTimestamp(file.createdAt),
          })),
        } : {}),
        ...(chunkExtracts.length > 0 ? {
          codeExtracts: chunkExtracts.map((extract) => ({
            id: extract.id,
            fileName: extract.fileName,
            language: extract.language,
            symbols: parseStoredStringArray(extract.symbolsJson),
            code: extract.code,
            createdAt: formatTimestamp(extract.createdAt),
          })),
        } : {}),
      };
    }),
    summaries: summaries.map((summary) => {
      const sourceIds = parseStoredStringArray(summary.sourceChunkIds);
      return {
        id: summary.id,
        title: summary.title,
        oneLineSummary: summary.oneLineSummary,
        content: summary.content,
        categories: parseStoredStringArray(summary.categoriesList),
        ...(sourceIds.length > 0 ? { sourceChunkIds: sourceIds } : {}),
        version: summary.version,
        createdAt: formatTimestamp(summary.createdAt),
        updatedAt: formatTimestamp(summary.updatedAt),
      };
    }),
    findings: activeFindings.map((finding) => ({
      id: finding.id,
      type: finding.type,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      status: finding.status,
      createdAt: formatTimestamp(finding.createdAt),
      reviewedAt: formatTimestamp(finding.reviewedAt),
      actionsAppliedAt: formatTimestamp(finding.actionsAppliedAt),
    })),
  };
}

function buildAgentAnalyzerPrompt(
  projectId: string,
  lastAnalyzerRun: unknown,
  chunks: LearningChunk[],
  summaries: Summary[],
  findings: FindingRecord[],
  recentFiles: RecentFileHotspot[],
): string {
  const compactPayload = buildAgentAnalyzerPayload(projectId, lastAnalyzerRun, chunks, summaries, findings, recentFiles);

  return `You are maintaining the project's learning summaries using internal learning tools.

You are receiving a compact analyzer index instead of the full knowledge base so you can expand only the categories and summaries that need attention.
Summary categories are the summary types. Chunk groups contain IDs only; fetch the full summary or chunk bodies before changing anything.

Priorities:
1. Focus first on the recentFiles list and the summaries linked to those files.
2. Then focus on summaries and chunk categories that changed since the last analyzer run.
3. Use ic_get_file_chunks and ic_get_file_summaries when a recent file hotspot looks important.
4. Use ic_get_summary to inspect a summary before rewriting it.
5. Use ic_get_chunks_by_category and ic_get_chunks to inspect the full chunk facts that back a summary category.
6. When a summary is stale, use ic_update_summary to update content, oneLineSummary, categories, and sourceChunkIds.
7. When a chunk is obsolete after its information has been merged or superseded, use ic_delete_chunk.
8. Existing findings are included in full, except already implemented findings, so do not create duplicate findings.
9. Create a new finding only when the issue should remain visible for a human or cannot be safely resolved automatically.
10. If you are investigating information and other information, even if it is older, seems relevant you should query and confirm if it is still accurate.

Return ONLY a JSON object with this shape:
{"updatedSummaryIds":[],"deletedChunkIds":[],"createdFindingIds":[],"notes":[]}

## Compact Analyzer Index
${JSON.stringify(compactPayload, null, 2)}`;
}

function buildAgentAnalyzerPayload(
  projectId: string,
  lastAnalyzerRun: unknown,
  chunks: LearningChunk[],
  summaries: Summary[],
  findings: FindingRecord[],
  recentFiles: RecentFileHotspot[],
) {
  const lastAnalyzerRunAt = formatTimestamp(lastAnalyzerRun);
  const activeFindings = findings.filter((finding) => finding.status !== 'implemented');
  const chunkGroups = new Map<string, LearningChunk[]>();

  for (const chunk of chunks) {
    const existing = chunkGroups.get(chunk.category) ?? [];
    existing.push(chunk);
    chunkGroups.set(chunk.category, existing);
  }

  return {
    meta: {
      projectId,
      generatedAt: new Date().toISOString(),
      lastAnalyzerRunAt,
      summaryCount: summaries.length,
      chunkCount: chunks.length,
      findingCount: activeFindings.length,
    },
    recentFiles,
    summaries: summaries.map((summary) => {
      const summaryCategories = parseStoredStringArray(summary.categoriesList);
      const createdAt = formatTimestamp(summary.createdAt);
      const updatedAt = formatTimestamp(summary.updatedAt);
      return {
        id: summary.id,
        ...(summaryCategories.length > 0 ? { categories: summaryCategories } : {}),
        oneLineSummary: summary.oneLineSummary,
        ...(createdAt !== updatedAt ? { createdAt } : {}),
        updatedAt,
        version: summary.version,
        changedSinceLastRun: hasChangedSince(summary.updatedAt ?? summary.createdAt, lastAnalyzerRun),
      };
    }),
    chunkGroups: [...chunkGroups.entries()]
      .map(([category, categoryChunks]) => {
        const sortedChunks = [...categoryChunks].sort((a, b) => compareTimestampsDesc(a.createdAt, b.createdAt));
        const changedIds = sortedChunks
          .filter((chunk) => hasChangedSince(chunk.createdAt, lastAnalyzerRun))
          .map((chunk) => chunk.id);
        const unsummarizedIds = sortedChunks
          .filter((chunk) => chunk.summarized === false)
          .map((chunk) => chunk.id);
        return {
          category,
          chunkCount: sortedChunks.length,
          chunkIds: sortedChunks.map((chunk) => chunk.id),
          _changedCount: changedIds.length,
          ...(changedIds.length > 0 ? { changedChunkIds: changedIds } : {}),
          ...(unsummarizedIds.length > 0 ? { unsummarizedChunkIds: unsummarizedIds } : {}),
          latestCreatedAt: formatTimestamp(sortedChunks[0]?.createdAt),
        };
      })
      .sort((a, b) =>
        b._changedCount - a._changedCount ||
        compareTimestampsDesc(a.latestCreatedAt, b.latestCreatedAt) ||
        a.category.localeCompare(b.category)
      )
      .map(({ _changedCount, ...rest }) => rest),
    findings: activeFindings.map((finding) => {
      const findingRelatedIds = finding.relatedIds;
      const hasRelatedIds =
        (findingRelatedIds?.chunkIds?.length ?? 0) > 0 ||
        (findingRelatedIds?.summaryIds?.length ?? 0) > 0 ||
        (findingRelatedIds?.findingIds?.length ?? 0) > 0;
      return {
        id: finding.id,
        type: finding.type,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        status: finding.status,
        ...(hasRelatedIds ? { relatedIds: findingRelatedIds } : {}),
        createdAt: formatTimestamp(finding.createdAt),
        reviewedAt: formatTimestamp(finding.reviewedAt),
        actionsAppliedAt: formatTimestamp(finding.actionsAppliedAt),
      };
    }),
  };
}

function parseAnalyzerFindings(content: string): AnalyzerFindingPayload[] | null {
  try {
    const cleaned = content.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned || '[]');
    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed
      .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
      .map((value) => ({
        type: typeof value.type === 'string' ? value.type : undefined,
        severity: typeof value.severity === 'string' ? value.severity : undefined,
        title: typeof value.title === 'string' ? value.title : undefined,
        description: typeof value.description === 'string' ? value.description : undefined,
        actions: Array.isArray(value.actions) ? value.actions as FindingAction[] : undefined,
        relatedIds: parseRelatedIdsFromPayload(value.relatedIds),
      }));
  } catch {
    return null;
  }
}

function parseAgentAnalyzerCompletion(content: string): AgentAnalyzerCompletion | null {
  try {
    const cleaned = content.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const value = parsed as Record<string, unknown>;
    return {
      updatedSummaryIds: parseUnknownStringArray(value.updatedSummaryIds),
      deletedChunkIds: parseUnknownStringArray(value.deletedChunkIds),
      createdFindingIds: parseUnknownStringArray(value.createdFindingIds),
      notes: parseUnknownStringArray(value.notes),
    };
  } catch {
    return null;
  }
}

function parseStoredStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseUnknownStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasChangedSince(value: unknown, lastAnalyzerRun: unknown): boolean {
  const timestamp = toTimestamp(value);
  if (timestamp === null) return false;

  const cutoff = toTimestamp(lastAnalyzerRun);
  if (cutoff === null) return true;
  return timestamp > cutoff;
}

function compareTimestampsDesc(a: unknown, b: unknown): number {
  const left = toTimestamp(a) ?? 0;
  const right = toTimestamp(b) ?? 0;
  return right - left;
}

function parseRelatedIdsFromPayload(raw: unknown): RelatedIds | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const obj = raw as Record<string, unknown>;
  const chunkIds = Array.isArray(obj.chunkIds)
    ? obj.chunkIds.filter((id): id is string => typeof id === 'string')
    : [];
  const summaryIds = Array.isArray(obj.summaryIds)
    ? obj.summaryIds.filter((id): id is string => typeof id === 'string')
    : [];
  const findingIds = Array.isArray(obj.findingIds)
    ? obj.findingIds.filter((id): id is string => typeof id === 'string')
    : [];

  // Only return if at least one ID is present
  if (chunkIds.length === 0 && summaryIds.length === 0 && findingIds.length === 0) {
    return undefined;
  }

  return { chunkIds, summaryIds, findingIds };
}

function formatTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return null;
}
