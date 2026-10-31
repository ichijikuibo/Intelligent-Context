import axios from 'axios';
import type { Request, Response } from 'express';
import { hasModelAccess } from '../auth/context';
import { logger } from '../utils/logger';
import { getSystemModelConfig } from '../config/systemModels';
import { openaiAdapter } from './adapters/openai';
import { anthropicAdapter } from './adapters/anthropic';
import { AnthropicToOpenAiStream, parseAnthropicSseToResponseData, convertOpenAiSseToAnthropic } from './anthropicSseBridge';
import { providersRepo, type ProviderType } from '../db/repositories/providers';
import { parseModels, type ProviderConfig } from '../db/schema';
import { t } from '../i18n';
import type { Adapter, ChatMessage, ProxyRequest, ProxyResponse } from './adapters/adapter';
import {
  type ClientProtocol,
} from './clientProtocols';
import { formatUpstreamErrorMessage } from './errorMessage';
import { buildProviderScopedModelId, normalizeRequestedModelSelection, stripModelPrefix } from './modelSelection';
import { looksLikeModelLabel } from './modelLabels';
import { getReportedApiFormatForProvider } from './modelMetadataCache';
import { runLearningToolAgentLoop } from './tools/agentLoop';
import { isLearningToolName } from './tools/definitions';
import { UnifiedProxyStream, streamCompletionAsSse } from './unifiedStream';
import { getEffectiveContextConfig } from '../config/configOverrides';
import {
  startAndRunGathererTurn,
  runGathererTurn,
  injectGathererResult,
} from './gatherer/orchestrator';
import { getGathererPhase, clearGathererPhase } from './gatherer/phase';
import { buildGathererContextBlock } from './gatherer/request';
import { writeContextReplayForSession } from './contextReplay';
import type { GathererContextSelection } from '../context/selector';
import { withParamFallback } from '../utils/paramFallback';
import { logModelRequestFailure } from './modelRequestDiagnostics';
import { deduplicateAndStore } from '../learning/deduplicator';
import { contentToText } from '../utils/messageContent';
import { applyUpstreamRequestMiddleware } from './requestMiddleware';
import {
  buildImageDescriptionText,
  buildUnavailableImageText,
  containsImages,
  describeImageWithVisionModel,
  replaceImagesWithDescriptions,
  type ExtractedImage,
} from './vision';
import { getModelSupportsVisionForProvider } from './modelMetadataCache';
import { getModelReference } from './modelReferenceCache';

const MGMT_URL = 'http://localhost:9090';

function detectProviderType(model: string, headerType?: string): ProviderType {
  // 1. Explicit header override from IDE/client
  if (headerType === 'anthropic' || headerType === 'openai') return headerType;

  // 2. Model name heuristics
  const lower = model.toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic')) return 'anthropic';
  return 'openai';
}

export interface ResolvedProvider {
  adapter: Adapter;
  baseUrl: string;
  apiKey: string;
  providerName: string;
  providerType: ProviderType;
}

export interface ResolvedModelExecution extends ResolvedProvider {
  model: string;
}

interface ResolvedAdapterContext extends ResolvedProvider {
  providerId: string;
  providerShortPrefix?: string | null;
  models: string[];
  /**
   * Real upstream model ID, set when the request named a catalog display label
   * instead of a model. Callers must swap this into the request body, because
   * the label the client sent is not a valid upstream model.
   */
  resolvedModel?: string;
}

/**
 * Wire format to use for a provider's model.
 *
 * A per-model override (or a value the provider reported from its `/models`
 * endpoint) wins over the provider's default type, so a gateway that serves
 * both OpenAI- and Anthropic-shaped models can be corrected per model without
 * splitting it into separate provider rows.
 */
function resolveEffectiveProviderType(provider: ProviderConfig, model?: string): ProviderType {
  const providerType = provider.type as ProviderType;
  if (!model || model === 'unknown') return providerType;

  return getReportedApiFormatForProvider(provider.id, model) ?? providerType;
}

function buildResolvedProvider(provider: ProviderConfig, model?: string): ResolvedProvider {
  const providerType = resolveEffectiveProviderType(provider, model);
  return {
    adapter: providerType === 'anthropic' ? anthropicAdapter : openaiAdapter,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    providerName: provider.name,
    providerType,
  };
}

function buildResolvedAdapterContext(provider: ProviderConfig, model?: string): ResolvedAdapterContext {
  return {
    ...buildResolvedProvider(provider, model),
    providerId: provider.id,
    providerShortPrefix: provider.shortPrefix ?? null,
    models: parseModels(provider),
  };
}

function resolveUpstreamModel(provider: ProviderConfig, requestedModel: string): string {
  if (requestedModel && requestedModel !== 'unknown') {
    return requestedModel;
  }

  const models = parseModels(provider);
  if (models.length > 0) {
    return models[0]!;
  }

  return provider.type === 'anthropic'
    ? 'claude-sonnet-4-20250514'
    : 'gpt-4o-mini';
}

async function resolveProviderHint(providerHint?: string): Promise<ProviderConfig | undefined> {
  if (!providerHint) return undefined;

  const providerById = await providersRepo.findById(providerHint);
  if (providerById?.isEnabled) {
    return providerById;
  }

  const providerByShortPrefix = await providersRepo.findByShortPrefix(providerHint);
  if (providerByShortPrefix?.isEnabled) {
    return providerByShortPrefix;
  }

  return undefined;
}

async function resolveFallbackProvider(preferredType: ProviderType = 'openai'): Promise<ProviderConfig | undefined> {
  let provider = await providersRepo.findBestForType(preferredType);
  if (!provider && preferredType === 'openai') {
    provider = await providersRepo.findBestForType('anthropic');
  } else if (!provider && preferredType === 'anthropic') {
    provider = await providersRepo.findBestForType('openai');
  }
  if (!provider) {
    provider = await providersRepo.findAnyEnabled();
  }

  return provider;
}

/**
 * Resolve the best available provider for background jobs.
 * Prefers OpenAI-type (most compatible with generic chat/completions calls),
 * falls back to Anthropic if no OpenAI provider is configured.
 */
export async function resolveProviderForJob(preferredType: ProviderType = 'openai'): Promise<ResolvedProvider | null> {
  const provider = await resolveFallbackProvider(preferredType);
  if (!provider) return null;

  return buildResolvedProvider(provider);
}

export async function resolveProviderAndModelForJob(
  modelSelection: string,
  preferredType: ProviderType = 'openai'
): Promise<ResolvedModelExecution | null> {
  const trimmedSelection = modelSelection.trim();

  // A stored selection may be a catalog display label
  // ("CommandCode (OpenAI) · DeepSeek V4.1 Flash") if the user picked the model
  // by label. Labels are not valid upstream models, so resolve to the real
  // provider + model ID before falling through to type-based routing.
  if (trimmedSelection && looksLikeModelLabel(trimmedSelection)) {
    const labelMatch = await providersRepo.findModelForLabel(trimmedSelection);
    if (labelMatch) {
      return {
        ...buildResolvedProvider(labelMatch.provider, labelMatch.modelId),
        model: labelMatch.modelId,
      };
    }
  }

  const normalizedSelection = normalizeRequestedModelSelection(trimmedSelection);
  const requestedModel = normalizedSelection.model.trim();
  const fallbackType = requestedModel ? detectProviderType(requestedModel) : preferredType;

  let provider = await resolveProviderHint(normalizedSelection.providerIdHint);
  if (!provider && requestedModel) {
    provider = await providersRepo.findProviderForModel(requestedModel);
  }
  if (!provider) {
    provider = await resolveFallbackProvider(fallbackType);
  }
  if (!provider) return null;

  return {
    ...buildResolvedProvider(provider, requestedModel),
    model: resolveUpstreamModel(provider, requestedModel),
  };
}

interface VisionDelegationOptions {
  body: ProxyRequest;
  providerId: string;
  providerName: string;
  model: string;
  projectId?: string;
  sessionId?: string;
  requestId: string;
}

/**
 * Route images to the configured vision model when the target model cannot see
 * them.
 *
 * Rules:
 *   - a model marked as vision-capable (Models dialog) keeps its images;
 *   - with no vision model configured the request is forwarded untouched, so
 *     unmarked-but-capable models keep working as before;
 *   - a failed interpretation degrades to a placeholder block rather than
 *     failing the whole request.
 */
async function applyVisionDelegation(options: VisionDelegationOptions): Promise<void> {
  const { body, providerId, providerName, model } = options;
  if (!model || !containsImages(body.messages)) return;

  // The target model sees images itself — nothing to do.
  if (getModelSupportsVisionForProvider(providerId, model) === true) return;

  // The shared reference catalog also knows which models accept images, which
  // keeps a capable model from being delegated to unnecessarily.
  if (getModelReference(model)?.supportsVision === true) return;

  const visionSelection = getSystemModelConfig().vision.trim();
  if (!visionSelection) {
    logger.warn('Request contains images but no vision model is configured', {
      projectId: options.projectId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      providerName,
      model,
    });
    return;
  }

  const execution = await resolveProviderAndModelForJob(visionSelection, 'openai');
  if (!execution) {
    logger.warn('Configured vision model could not be resolved; images left as-is', {
      projectId: options.projectId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      visionSelection,
      providerName,
      model,
    });
    return;
  }

  // Delegating a model to itself cannot add vision capability.
  if (execution.model === model && execution.providerName === providerName) {
    logger.warn('Vision model matches the request model; images left as-is', {
      projectId: options.projectId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      visionSelection,
      model,
    });
    return;
  }

  const startedAt = Date.now();
  let failed = 0;

  const replaced = await replaceImagesWithDescriptions(body.messages!, async (image: ExtractedImage) => {
    try {
      const description = await describeImageWithVisionModel(execution, image, {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
      });
      return buildImageDescriptionText(description);
    } catch (err) {
      failed += 1;
      logger.error('Vision model failed to interpret an image', {
        projectId: options.projectId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        visionModel: visionSelection,
        providerName: execution.providerName,
        error: err instanceof Error ? err.message : String(err),
      });
      return buildUnavailableImageText(
        'The image could not be interpreted by the configured vision model.'
      );
    }
  });

  if (replaced > 0) {
    logger.info('Images interpreted by the vision model', {
      projectId: options.projectId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      visionModel: visionSelection,
      providerName: execution.providerName,
      model,
      imageCount: replaced,
      failedCount: failed,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function resolveAdapter(
  req: Request,
  model: string,
  providerIdHint?: string,
  providerTypeHint?: string
): Promise<ResolvedAdapterContext> {
  // 1. Explicit provider ID via X-Provider-Id header
  if (providerIdHint) {
    const provider = await resolveProviderHint(providerIdHint);
    if (provider) {
      return buildResolvedAdapterContext(provider, model);
    }
    logger.warn('Requested provider not found or disabled; falling back', {
      providerIdHint,
    });
  }

  // 2. Catalog display label: "<provider name> · <model label>".
  //    Clients that surface `display_name` from /v1/models send the label back
  //    as the model. It is not a valid upstream model, so map it to the real
  //    provider + model ID rather than guessing by provider type.
  if (model && looksLikeModelLabel(model)) {
    const labelMatch = await providersRepo.findModelForLabel(model);
    if (labelMatch) {
      logger.info('Model resolved from catalog display label', {
        requested: model,
        providerName: labelMatch.provider.name,
        model: labelMatch.modelId,
      });
      return {
        ...buildResolvedAdapterContext(labelMatch.provider, labelMatch.modelId),
        resolvedModel: labelMatch.modelId,
      };
    }
  }

  // 3. Model-name match: check all providers' model lists for the IDE's chosen model
  if (model && model !== 'unknown') {
    const matched = await providersRepo.findProviderForModel(model);
    if (matched) {
      return buildResolvedAdapterContext(matched, model);
    }
  }

  // 4. Type detection from model name + optional X-Provider-Type header
  const type = detectProviderType(model, providerTypeHint);
  const provider = await providersRepo.findBestForType(type);

  if (!provider) {
    // Fallback: try the other type
    const fallbackType = type === 'anthropic' ? 'openai' : 'anthropic';
    const fallback = await providersRepo.findBestForType(fallbackType);
    if (fallback) {
      logger.info('Using fallback provider type', { requested: type, used: fallbackType, provider: fallback.name });
      return buildResolvedAdapterContext(fallback);
    }

    throw new Error(t(req, 'api.error.noProviderForType', { type, url: MGMT_URL }));
  }

  return buildResolvedAdapterContext(provider);
}

interface ProxyToUpstreamOptions {
  clientProtocol?: ClientProtocol;
}

function providerTypeToToolProtocol(providerType: ProviderType): ClientProtocol {
  return providerType === 'anthropic' ? 'anthropic' : 'openai';
}

function finalizeGathererCompletion(
  requestBody: ProxyRequest,
  phase: ReturnType<typeof getGathererPhase>,
  projectId: string | undefined,
  sessionId: string,
  capturedText: string,
): void {
  const previousMessageCount = requestBody.messages?.length ?? 0;
  let changes: string[] = [];

  if (phase?.originalMessages) {
    requestBody.messages = phase.originalMessages;
    changes.push('originalMessages_restored');
  }

  if (capturedText.trim()) {
    injectGathererResult(requestBody, capturedText);
    writeContextReplayForSession(projectId, sessionId, buildGathererContextBlock(capturedText));
    changes.push('gatherer_analysis_injected');
  }

  clearGathererPhase(sessionId);

  if (changes.length > 0) {
    logger.info('Gatherer completion finalized — body modified', {
      projectId,
      sessionId,
      previousMessageCount,
      currentMessageCount: requestBody.messages?.length ?? 0,
      capturedTextLength: capturedText.length,
      capturedTextPreview: capturedText.trim() ? capturedText.slice(0, 200) : '(empty)',
      changes: changes.join(', '),
    });
  }
}

// ── Separate Learning Extraction ────────────────────────────────────────
//
// When a separate learning model is configured, this function is called
// after the main model completes (finish_reason === 'stop') to extract
// durable project knowledge from the conversation and store it as chunks.
//
// It sends the conversation context (request messages + main model response)
// to the learning model with a prompt asking it to output learnings as a
// JSON array, then persists the extracted learnings via deduplicateAndStore.

interface SeparateLearningExtractionParams {
  learningModel: string;
  /** The response payload or text to extract learnings from */
  responsePayload: unknown;
  /** Visible (user-facing) text from the main model response */
  visibleResponseText: string;
  /** Original request messages for full conversation context */
  requestMessages?: ChatMessage[];
  projectId: string;
  sessionId?: string;
  requestId: string;
}

async function performSeparateLearningExtraction(
  params: SeparateLearningExtractionParams
): Promise<void> {
  const { learningModel, visibleResponseText, projectId, sessionId, requestId } = params;

  try {
    const learningExecution = await resolveProviderAndModelForJob(
      learningModel,
      detectProviderType(learningModel),
    );
    if (!learningExecution) {
      logger.warn('Separate learning: no provider resolved for learning model', {
        learningModel,
        projectId,
        sessionId,
        requestId,
      });
      return;
    }

    // Build a prompt that asks the learning model to extract durable project
    // knowledge from the main model's response. Include the conversation
    // messages for context when available.
    const conversationContext = Array.isArray(params.requestMessages) && params.requestMessages.length > 0
      ? `--- CONVERSATION MESSAGES ---\n${params.requestMessages
          .filter((m) => m.role !== 'system')
          .map((m) => `[${m.role}]: ${contentToText(m.content).slice(0, 2000)}`)
          .join('\n\n')}\n\n--- END CONVERSATION MESSAGES ---\n`
      : '';

    const extractionPrompt = [
      {
        role: 'system' as const,
        content: [
          'You are a project knowledge extractor. Your job is to analyze a model\'s response',
          'and extract durable, reusable project facts that would help future coding sessions.',
          '',
          'For each fact you identify, output a JSON object with these fields:',
          '- fact: a one-sentence project truth about structure, conventions, or behaviour',
          '- category: a domain label like "auth", "scheduler", "api", or "global"',
          '- confidence: 0.0–1.0 (use high values only when certain)',
          '- filesUsed: optional array of {name, purpose} for files that informed the fact',
          '',
          'Output ONLY a valid JSON array. Do NOT wrap in markdown or add explanatory text.',
          'Example output:',
          '[{"fact":"The auth middleware uses HMAC-SHA256 for session tokens","category":"auth","confidence":0.95,"filesUsed":[{"name":"src/auth/context.ts","purpose":"Session token verification"}]}]',
          '',
          'If you found no new project-level facts, output: []',
          '',
          'Do NOT include task-specific details, personal opinions, or ephemeral information.',
          'Only extract durable facts about the project that would save re-reading files next time.',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: [
          'Analyze the following conversation and extract any durable project knowledge:',
          '',
          conversationContext,
          '--- MODEL RESPONSE ---',
          visibleResponseText,
          '--- END MODEL RESPONSE ---',
          '',
          'Output the JSON array of extracted learnings now (or [] if none):',
        ].join('\n'),
      },
    ];

    const { adapter, baseUrl, apiKey, model } = learningExecution;
    const extractionUrl = adapter.endpoint(baseUrl);
    const extractionHeaders = applyUpstreamRequestMiddleware(extractionUrl, adapter.headers(apiKey), {
      sessionId,
      projectId,
    });

    const extractionRequest = {
      model,
      messages: extractionPrompt,
      stream: false,
    };

    logger.info('Separate learning extraction started', {
      learningModel,
      provider: learningExecution.providerName,
      projectId,
      sessionId,
      requestId,
    });

    const extractionResponse = await axios.post(extractionUrl, extractionRequest, {
      headers: extractionHeaders,
      timeout: 60_000,
    });

    const parsed = adapter.parseResponse(extractionResponse.data);
    const responseContent = contentToText(parsed.choices?.[0]?.message?.content);
    const toolCalls = (parsed.choices?.[0]?.message as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } | undefined)?.tool_calls;

    let learnings: Array<{
      fact: string;
      category: string;
      confidence: number;
      isNew?: boolean;
      filesUsed?: Array<{ name: string; purpose?: string }>;
    }> = [];

    // Try to extract learnings from tool calls first (record_learning)
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        if (tc.function?.name === 'record_learning' && tc.function?.arguments) {
          try {
            const args = JSON.parse(tc.function.arguments);
            if (Array.isArray(args.learnings)) {
              learnings.push(...args.learnings);
            }
          } catch {
            // Silently skip unparseable arguments
          }
        }
      }
    }

    // Fall back to parsing JSON from the text response
    if (learnings.length === 0 && responseContent.trim()) {
      // Try to find a JSON array in the response
      const jsonMatch = responseContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const parsedLearnings = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsedLearnings)) {
            learnings = parsedLearnings;
          }
        } catch {
          logger.debug('Separate learning: failed to parse JSON from response text', {
            projectId,
            sessionId,
            requestId,
          });
        }
      }
    }

    if (learnings.length > 0) {
      const result = await deduplicateAndStore(
        learnings.map((l) => ({
          fact: l.fact,
          category: l.category,
          confidence: l.confidence ?? 0.9,
          isNew: l.isNew ?? true,
          filesUsed: l.filesUsed?.map((f) => ({
            name: f.name,
            purpose: f.purpose ?? '',
          })),
        })),
        projectId,
        sessionId,
        `${requestId}:learning`,
      );
      logger.info('Separate learning extraction completed', {
        learningModel,
        provider: learningExecution.providerName,
        projectId,
        sessionId,
        requestId,
        stored: result.stored,
        skipped: result.skipped,
        updated: result.updated,
      });
    } else {
      logger.info('Separate learning extraction: no learnings extracted', {
        learningModel,
        provider: learningExecution.providerName,
        projectId,
        sessionId,
        requestId,
      });
    }
  } catch (err) {
    // Learning extraction failure is non-fatal — log and continue
    logger.error('Separate learning extraction failed', {
      learningModel,
      projectId,
      sessionId,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ��─ Proxy to Upstream ────────────────────────────────────────────────────
export async function proxyToUpstream(
  req: Request,
  res: Response,
  options: ProxyToUpstreamOptions = {}
): Promise<void> {
  const body = req.body as ProxyRequest;
  const projectId = req.projectId;
  const sessionId =
    (req.headers['x-opencode-session'] as string | undefined) ??
    (req.headers['x-session-id'] as string | undefined) ??
    (req.headers['x-interaction-id'] as string | undefined);
  const requestId =
    (req.headers['x-ic-request-id'] as string | undefined) ??
    `ic-${Date.now()}`;
  const clientProtocol = options.clientProtocol ?? 'openai';
  // Learning model config: if a separate learning model is configured, the
  // main model runs WITHOUT a learning instruction (handled in
  // learningTools.ts), and a separate learning extraction call runs
  // after the main model completes. If no learning model is configured,
  // the main model itself calls `record_learning` in-band.
  const systemModels = getSystemModelConfig();
  const separateLearningModel = projectId ? systemModels.learning.trim() : '';
  const toolContinuation = req.toolContinuation === true;

  const rawProviderIdHint = req.headers['x-provider-id'] as string | undefined;
  const providerTypeHint = req.headers['x-provider-type'] as string | undefined;
  const normalizedSelection = normalizeRequestedModelSelection(body.model ?? '', rawProviderIdHint);
  const providerIdHint = normalizedSelection.providerIdHint;
  const originalModel = body.model;
  body.model = normalizedSelection.model;

  if (body.model !== originalModel) {
    logger.info('Model selection normalized', {
      projectId,
      sessionId,
      requestId,
      originalModel,
      normalizedModel: body.model,
      providerIdHint,
      rawProviderIdHint,
    });
  }

  let adapterCtx: Awaited<ReturnType<typeof resolveAdapter>>;
  try {
    adapterCtx = await resolveAdapter(
      req,
      body.model ?? '',
      providerIdHint,
      providerTypeHint ?? (clientProtocol === 'anthropic' ? 'anthropic' : undefined)
    );
  } catch (err) {
    await logModelRequestFailure({
      err,
      url: '(adapter resolution)',
      requestHeaders: {},
      requestBody: body,
      projectId,
      sessionId,
      requestId,
      model: body.model ?? 'unknown',
      providerName: providerIdHint ?? '(none)',
      providerType: providerTypeHint ?? 'openai',
      logMessage: 'Upstream adapter resolution failed',
    });
    res.status(502).json({
      error: { message: String(err), type: 'configuration_error' },
    });
    return;
  }

  if (clientProtocol === 'anthropic' && adapterCtx.providerType !== 'anthropic') {
    res.status(502).json({
      error: {
        message: t(req, 'api.error.noAnthropicProviderForMessages'),
        type: 'configuration_error',
      },
    });
    return;
  }

  const { adapter, baseUrl, apiKey, models, providerType } = adapterCtx;
  const url = adapter.endpoint(baseUrl);
  const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey), { sessionId, projectId });

  // A catalog display label is not a valid upstream model. Swap in the real ID
  // the label resolved to, before access checks and any fallback logic run.
  if (adapterCtx.resolvedModel && adapterCtx.resolvedModel !== body.model) {
    logger.info('Rewriting request model to resolved upstream ID', {
      projectId,
      sessionId,
      requestId,
      requestedModel: body.model,
      resolvedModel: adapterCtx.resolvedModel,
      providerName: adapterCtx.providerName,
    });
    body.model = adapterCtx.resolvedModel;
  }

  if (req.user && !req.user.accessAllModels && req.user.role !== 'admin') {
    const selectedModelId = body.model && body.model !== 'unknown'
      ? buildProviderScopedModelId({
          id: adapterCtx.providerId,
          shortPrefix: adapterCtx.providerShortPrefix,
        }, body.model)
      : '';

    if (selectedModelId && !hasModelAccess(req.user, selectedModelId)) {
      res.status(403).json({ error: { message: 'You do not have access to this model.', type: 'auth_error' } });
      return;
    }

    const allowedModels = models.filter((modelId) =>
      hasModelAccess(req.user!, buildProviderScopedModelId({
        id: adapterCtx.providerId,
        shortPrefix: adapterCtx.providerShortPrefix,
      }, modelId))
    );
    if ((!body.model || body.model === 'unknown') && allowedModels.length === 0) {
      res.status(403).json({ error: { message: 'You do not have access to any configured models.', type: 'auth_error' } });
      return;
    }

    if (!body.model || body.model === 'unknown') {
      body.model = allowedModels[0];
      logger.info('Model assigned from auth-allowed models (was empty/unknown)', {
        projectId,
        sessionId,
        requestId,
        model: body.model,
        allowedModels: allowedModels.join(', '),
        reason: 'user_model_not_specified',
      });
    }
  }

  // Use provider's first model when the IDE sends no model (e.g., empty string or "unknown")
  if ((!body.model || body.model === 'unknown') && models.length > 0) {
    const fallbackModel = models[0];
    body.model = fallbackModel;
    logger.info('Model set to provider default (was empty/unknown)', {
      projectId,
      sessionId,
      requestId,
      model: fallbackModel,
      providerName: adapterCtx.providerName,
      providerModels: models.join(', '),
      reason: 'fallback_to_first_configured_model',
    });
  }

  // A model that cannot see images gets them interpreted by the configured
  // vision model, and the descriptions replace the images as text before the
  // request is forwarded.
  await applyVisionDelegation({
    body,
    providerId: adapterCtx.providerId,
    providerName: adapterCtx.providerName,
    model: body.model ?? '',
    projectId,
    sessionId,
    requestId,
  });

  logger.debug('Proxying to upstream', {
    url,
    model: body.model,
    stream: body.stream,
    provider: adapterCtx.providerName,
  });

  if (body.stream) {
    await handleStreaming(
      url,
      headers,
      projectId,
      sessionId,
      requestId,
      providerType,
      adapterCtx.providerName,
      clientProtocol,
      toolContinuation,
      separateLearningModel,
      res,
      body,
      adapter,
      req.gathererSelectionContext,
      req.gathererContextBlock,
    );
  } else {
    await handleNonStreaming(
      url,
      headers,
      body,
      adapter,
      projectId,
      sessionId,
      requestId,
      providerType,
      adapterCtx.providerName,
      clientProtocol,
      separateLearningModel,
      res
    );
  }
}
// ── Anthropic streaming response handler ────────────────────────────────
//
// When the client speaks Anthropic protocol (`/v1/messages`) and a project
// is active, we buffer the upstream Anthropic SSE, check for `ic_` tool_use
// blocks, and if found run the agent loop server-side to resolve them.
// The resolved `ProxyResponse` is converted back to Anthropic SSE for the
// IDE so the model only ever sees the tool calls the IDE can execute.
//
// The conversion chain is:
//   upstream (Anthropic SSE)
//     → parseAnthropicSseToResponseData  →  full Anthropic JSON response
//     → adapter.parseResponse            →  OpenAI ProxyResponse
//     → runLearningToolAgentLoop         →  resolved ProxyResponse
//     → streamCompletionAsSse            →  OpenAI SSE string
//     → convertOpenAiSseToAnthropic      →  Anthropic SSE string
//     → res.write / res.end

async function handleAnthropicStreamingResponse(
  upstreamResponse: { data: NodeJS.ReadableStream },
  options: {
    url: string;
    headers: Record<string, string>;
    projectId: string;
    sessionId: string | undefined;
    requestId: string;
    providerType: ProviderType;
    providerName: string;
    requestBody: ProxyRequest;
    adapter: Adapter;
    separateLearningModel: string;
    res: Response;
  },
): Promise<void> {
  const {
    projectId,
    sessionId,
    requestId,
    providerName,
    providerType,
    requestBody,
    adapter,
    separateLearningModel,
    res,
  } = options;

  // ── Buffer the entire upstream SSE stream ──
  const sseChunks: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      upstreamResponse.data.on('data', (chunk: Buffer) => sseChunks.push(chunk));
      upstreamResponse.data.on('end', resolve);
      upstreamResponse.data.on('error', reject);
    });
  } catch (streamErr) {
    logger.error('Anthropic streaming: error reading upstream SSE', {
      projectId,
      sessionId,
      requestId,
      error: String(streamErr),
    });
    const partialSse = Buffer.concat(sseChunks).toString('utf8');
    if (!res.headersSent) {
      if (partialSse.trim()) {
        sendAnthropicSseToRes(res, partialSse);
      } else {
        res.status(502).json({ error: { message: String(streamErr), type: 'upstream_error' } });
      }
    }
    return;
  }

  const rawSse = Buffer.concat(sseChunks).toString('utf8');

  // ── Reconstruct the full Anthropic response JSON ──
  const responseData = parseAnthropicSseToResponseData(rawSse);
  if (!responseData) {
    logger.warn('Anthropic streaming: failed to parse SSE into response data', {
      projectId,
      sessionId,
      requestId,
      sseLength: rawSse.length,
    });
    sendAnthropicSseToRes(res, rawSse);
    return;
  }

  const normalised = adapter.parseResponse(responseData);
  const toolCalls = (normalised.choices?.[0]?.message as { tool_calls?: Array<{ function?: { name?: string } }> } | undefined)?.tool_calls;
  const hasIcTools = Array.isArray(toolCalls) && toolCalls.some((tc) => isLearningToolName(tc.function?.name ?? ''));

  if (!hasIcTools) {
    // No ic_ tool calls — pass raw SSE through unchanged (zero latency overhead)
    sendAnthropicSseToRes(res, rawSse);
    return;
  }

  // ── Run the agent loop to resolve ic_ tool calls server-side ──
  let loopResult: Awaited<ReturnType<typeof runLearningToolAgentLoop>>;
  try {
    loopResult = await runLearningToolAgentLoop({
      url: options.url,
      headers: options.headers,
      adapter,
      request: requestBody,
      projectId,
      sessionId,
      requestId,
      providerName,
      providerType,
      initialResponseData: responseData,
      initialNormalizedResponse: normalised,
      toolClientProtocol: 'anthropic',
    });
  } catch (loopErr) {
    // Agent loop failure — fall back to raw SSE so the IDE still sees
    // the original tool-call turn and can surface the model's intent.
    logger.error('Anthropic streaming: agent loop failed, falling back to raw SSE', {
      projectId,
      sessionId,
      requestId,
      error: loopErr instanceof Error ? loopErr.message : String(loopErr),
    });
    sendAnthropicSseToRes(res, rawSse);
    return;
  }

  // ── Convert the resolved ProxyResponse to Anthropic SSE ──
  const sseOutput: string[] = [];
  streamCompletionAsSse(loopResult.normalizedResponse, (chunk: string) => sseOutput.push(chunk));
  const anthropicSse = convertOpenAiSseToAnthropic(sseOutput.join('\n'));

  sendAnthropicSseToRes(res, anthropicSse);

  // ── Fire separate learning extraction at end-of-turn ──
  const finalFinishReason = loopResult.normalizedResponse.choices?.[0]?.finish_reason;
  if (separateLearningModel && finalFinishReason === 'stop' && projectId) {
    const visibleText = contentToText(loopResult.normalizedResponse.choices?.[0]?.message?.content);
    void performSeparateLearningExtraction({
      learningModel: separateLearningModel,
      responsePayload: loopResult.normalizedResponse,
      visibleResponseText: visibleText,
      requestMessages: requestBody.messages as ChatMessage[] | undefined,
      projectId,
      sessionId,
      requestId,
    });
  }
}

/**
 * Helper: write an Anthropic-format SSE string to the Express response
 * with the correct SSE headers.
 */
function sendAnthropicSseToRes(res: Response, sse: string): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(sse);
  res.end();
}

// ── Streaming handler (unified stream) ──────────────────────────────

async function handleStreaming(
  url: string,
  headers: Record<string, string>,
  projectId: string | undefined,
  sessionId: string | undefined,
  requestId: string,
  providerType: ProviderType,
  providerName: string,
  clientProtocol: ClientProtocol,
  toolContinuation: boolean,
  separateLearningModel: string,
  res: Response,
  requestBody?: ProxyRequest,
  adapter?: Adapter,
  gathererSelectionContext?: GathererContextSelection,
  pastKnowledgeBlock?: string,
): Promise<void> {
  // ── Two-stage gatherer routing ──
  // The gatherer runs across multiple HTTP requests.  Each tool-call
  // turn streams to the IDE; the IDE executes tools and sends results
  // back on the next request.  The proxy MUST route those continuations
  // back to the gatherer until it produces finish_reason: "stop".
  const systemModels = getSystemModelConfig();
  const requestContextMode =
    systemModels.requestContextMode === 'basic' ||
    systemModels.requestContextMode === 'selector' ||
    systemModels.requestContextMode === 'gatherer'
      ? systemModels.requestContextMode
      : systemModels.gatherer.trim().length > 0
        ? 'gatherer'
        : 'selector';
  const gathererModel = systemModels.gatherer.trim();
  const ctx = getEffectiveContextConfig();

  // If the gatherer and main model are the same base model (after stripping
  // provider prefixes), skip the gatherer stage to avoid a 400 error when
  // switching between providers that serve the same underlying model.
  const mainModel = requestBody?.model ?? '';
  const sameBaseModel = !!gathererModel && !!mainModel &&
    stripModelPrefix(gathererModel) === stripModelPrefix(mainModel);
  const gathererEnabled = requestContextMode === 'gatherer' && !!gathererModel && !!projectId && !!requestBody && !!sessionId && !sameBaseModel;

  if (sameBaseModel) {
    logger.info('Gatherer skipped — gatherer model and main model share the same base model', {
      projectId,
      sessionId,
      requestId,
      gathererModel,
      mainModel,
      baseModel: stripModelPrefix(gathererModel),
    });
  }

  if (gathererEnabled) {
    const phase = getGathererPhase(sessionId!);

    if (phase?.finished) {
      finalizeGathererCompletion(
        requestBody!,
        phase,
        projectId,
        sessionId!,
        phase.capturedText,
      );
    } else if (phase) {
      // ── Gatherer turn in progress: route this continuation to gatherer ──
      const result = await runGathererTurn({
        gathererModel: phase.model,
        requestBody: requestBody!,
        projectId: projectId!,
        sessionId: sessionId!,
        requestId,
        clientProtocol,
        selectionContext: phase.selectionContext,
        pastKnowledgeBlock: phase.pastKnowledgeBlock ?? pastKnowledgeBlock,
      }, res);

      if (result.phaseFinished) {
        finalizeGathererCompletion(
          requestBody!,
          phase,
          projectId,
          sessionId!,
          result.capturedText,
        );
        // Fall through to the main model pipe below.
      } else {
        // Gatherer streamed tool calls to IDE — nothing more to do now.
        return;
      }
    } else if (!phase && (!ctx.gathererSkipOnToolContinuation || !toolContinuation)) {
      // ── First turn: start gatherer phase ──
      const result = await startAndRunGathererTurn({
        gathererModel,
        requestBody: requestBody!,
        projectId: projectId!,
        sessionId: sessionId!,
        requestId,
        clientProtocol,
        selectionContext: gathererSelectionContext,
        pastKnowledgeBlock,
        originalMessages: requestBody!.messages,
      }, res);

      if (result.phaseFinished) {
        // Gatherer finished on first turn (possibly with an empty handoff).
        // Restore original messages — the gatherer may have mutated
        // the body's messages during its execution, so reset to the
        // clean snapshot before injecting the analysis.
        finalizeGathererCompletion(
          requestBody!,
          getGathererPhase(sessionId!),
          projectId,
          sessionId!,
          result.capturedText,
        );
        // Fall through to the main model pipe below.
      } else {
        // Gatherer streamed tool calls to IDE — wait for next request.
        return;
      }
    }
    // Finished gatherer phases are cleaned up before falling through to
    // the main model pipe. In-progress phases return early until the
    // gatherer emits finish_reason: "stop".
  }

  try {
    if (!requestBody || !adapter) {
      throw new Error('Streaming proxy requires a request body and adapter.');
    }

    const finalMessageCount = requestBody.messages?.length ?? 0;
    const finalSystemCount = requestBody.messages?.filter((m: ChatMessage) => m.role === 'system').length ?? 0;
    const finalUserCount = requestBody.messages?.filter((m: ChatMessage) => m.role === 'user').length ?? 0;
    const finalToolCount = requestBody.messages?.filter((m: ChatMessage) => m.role === 'tool').length ?? 0;

    logger.info('Sending streaming request to upstream', {
      projectId,
      sessionId,
      requestId,
      url,
      model: requestBody.model,
      providerName,
      providerType,
      messageCount: finalMessageCount,
      systemMessages: finalSystemCount,
      userMessages: finalUserCount,
      toolMessages: finalToolCount,
      hasTools: Array.isArray(requestBody.tools) && requestBody.tools.length > 0,
      toolChoice: requestBody.tool_choice,
      stream: true,
      assistantContinuation: requestBody.messages?.some((m: ChatMessage) => m.role === 'assistant' && (m as unknown as Record<string, unknown>).tool_calls !== undefined),
      lastMessageRole: finalMessageCount > 0 ? requestBody.messages?.[finalMessageCount - 1]?.role : undefined,
      lastMessageContentPreview: finalMessageCount > 0
        ? JSON.stringify(requestBody.messages?.[finalMessageCount - 1]?.content ?? '').slice(0, 300)
        : undefined,
    });

    const { result: upstream } = await withParamFallback(
      requestBody,
      adapter,
      {
        projectId,
        sessionId,
        requestId,
        model: requestBody.model ?? 'unknown',
        providerName,
        providerType,
        url,
        requestHeaders: headers,
      },
      async (payload) => axios.post(url, payload, {
        headers,
        responseType: 'stream',
        timeout: 120_000,
      }),
    );

    // ── Anthropic protocol: handle IC interception at SSE level ──
    // The UnifiedProxyStream only understands OpenAI-format SSE
    // delta.tool_calls for detection.  For Anthropic SSE the tool_use
    // blocks have a different event shape, so we buffer the entire
    // response and handle it in a separate path.
    if (clientProtocol === 'anthropic' && projectId && requestBody && adapter) {
      await handleAnthropicStreamingResponse(
        upstream,
        {
          url,
          headers,
          projectId,
          sessionId,
          requestId,
          providerType,
          providerName,
          requestBody,
          adapter,
          separateLearningModel,
          res,
        },
      );
      return;
    }

    const enableIcIntercept =
      projectId !== undefined &&
      clientProtocol === 'openai' &&
      requestBody !== undefined &&
      adapter !== undefined;

    // Wire separate learning extraction into stream completion callback
    // so it fires at end-of-turn (finish_reason === 'stop') when a
    // separate learning model is configured.
    const streamCallbacks = (separateLearningModel && projectId && requestBody)
      ? {
          onComplete: (result: { visibleText: string; finishReason: string | null }) => {
            if (result.finishReason === 'stop') {
              void performSeparateLearningExtraction({
                learningModel: separateLearningModel,
                responsePayload: { stream: true, visibleText: result.visibleText },
                visibleResponseText: result.visibleText,
                requestMessages: requestBody!.messages as ChatMessage[] | undefined,
                projectId,
                sessionId,
                requestId,
              });
            }
          },
        }
      : undefined;

    const unified = enableIcIntercept
      ? new UnifiedProxyStream({
          projectId: projectId!,
          sessionId,
          requestId,
          callbacks: streamCallbacks,
          enableIcIntercept: true as const,
          upstreamUrl: url,
          upstreamHeaders: headers,
          adapter: adapter!,
          requestBody: requestBody!,
          providerName,
          providerType,
        })
      : new UnifiedProxyStream({
          sessionId,
          requestId,
          callbacks: streamCallbacks,
          enableIcIntercept: false as const,
          upstreamUrl: url,
          upstreamHeaders: headers,
          providerName,
          providerType,
        });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Source: optionally wrap in Anthropic-to-OpenAI bridge
    const sourceStream = (clientProtocol === 'openai' && providerType === 'anthropic')
      ? upstream.data.pipe(new AnthropicToOpenAiStream())
      : upstream.data;

    sourceStream.pipe(unified).pipe(res);

    sourceStream.on('error', (err: Error) => {
      logger.error('Upstream stream error', { error: err.message });
      if (!res.headersSent) res.status(502).end();
    });
  } catch (err) {
    const status = axios.isAxiosError(err) ? (err.response?.status ?? 502) : 502;
    const message = formatUpstreamErrorMessage(err);
    //decode the body if it is abuffer
    var body = '';
    if (axios.isAxiosError(err) && err.response?.data) {
      if (Buffer.isBuffer(err.response.data)) {
        body = err.response.data.toString('utf8');
      } else if (typeof err.response.data === 'string') {
        body = err.response.data;
      }
    }
    logger.error('Upstream request failed', {
      projectId,
      sessionId,
      body,
    });
    if (!res.headersSent) {
      res.status(status).json({ error: { message, type: 'upstream_error' } });
    }
  }
}

// ── Non-streaming handler ────────────────────────────────────────────

async function handleNonStreaming(
  url: string,
  headers: Record<string, string>,
  requestBody: ProxyRequest,
  adapter: Adapter,
  projectId: string | undefined,
  sessionId: string | undefined,
  requestId: string,
  providerType: ProviderType,
  providerName: string,
  clientProtocol: ClientProtocol,
  separateLearningModel: string,
  res: Response
): Promise<void> {
  const finalMessageCount = requestBody.messages?.length ?? 0;
  const finalSystemCount = requestBody.messages?.filter((m: ChatMessage) => m.role === 'system').length ?? 0;
  const finalUserCount = requestBody.messages?.filter((m: ChatMessage) => m.role === 'user').length ?? 0;
  const finalToolCount = requestBody.messages?.filter((m: ChatMessage) => m.role === 'tool').length ?? 0;

  logger.info('Sending non-streaming request to upstream', {
    projectId,
    sessionId,
    requestId,
    url,
    model: requestBody.model,
    providerName,
    providerType,
    messageCount: finalMessageCount,
    systemMessages: finalSystemCount,
    userMessages: finalUserCount,
    toolMessages: finalToolCount,
    hasTools: Array.isArray(requestBody.tools) && requestBody.tools.length > 0,
    toolChoice: requestBody.tool_choice,
    stream: false,
    assistantContinuation: requestBody.messages?.some((m: ChatMessage) => m.role === 'assistant' && (m as unknown as Record<string, unknown>).tool_calls !== undefined),
    lastMessageRole: finalMessageCount > 0 ? requestBody.messages?.[finalMessageCount - 1]?.role : undefined,
    lastMessageContentPreview: finalMessageCount > 0
      ? JSON.stringify(requestBody.messages?.[finalMessageCount - 1]?.content ?? '').slice(0, 300)
      : undefined,
  });

  try {
    const { result: response } = await withParamFallback(
      requestBody,
      adapter,
      {
        projectId,
        sessionId,
        requestId,
        model: requestBody.model ?? 'unknown',
        providerName,
        providerType,
        url,
        requestHeaders: headers,
      },
      async (payload) => axios.post(url, payload, {
        headers,
        timeout: 120_000,
      }),
    );

    let responseData = response.data;
    let normalised = adapter.parseResponse(responseData);

    const initialToolCalls = (normalised.choices?.[0]?.message as { tool_calls?: unknown } | undefined)?.tool_calls;
    const shouldRunLearningToolLoop =
      projectId !== undefined &&
      (normalised.choices?.[0]?.finish_reason === 'tool_calls' || Array.isArray(initialToolCalls));

    if (shouldRunLearningToolLoop) {
      try {
        const loopResult = await runLearningToolAgentLoop({
          url,
          headers,
          adapter,
          request: requestBody,
          projectId,
          sessionId,
          requestId,
          providerName,
          providerType,
          initialResponseData: responseData,
          initialNormalizedResponse: normalised,
          toolClientProtocol: providerTypeToToolProtocol(providerType),
        });
        responseData = loopResult.responseData;
        normalised = loopResult.normalizedResponse;
        if (loopResult.internalTurnCount > 0) {
          logger.info('Non-streaming learning tool loop replaced response', {
            projectId,
            sessionId,
            requestId,
            internalTurnCount: loopResult.internalTurnCount,
            finalFinishReason: normalised.choices?.[0]?.finish_reason,
          });
        }
      } catch (loopErr) {
        // The loop can fail in ways it doesn't know how to recover
        // from (e.g. exceeding `maxTurns`, or a non-turn failure like
        // a malformed initial response).  We log the failure and fall
        // back to the *original* non-loop response so the IDE still
        // gets something back, rather than a generic 502.
        logger.error('Non-streaming learning tool loop failed; returning initial response', {
          projectId,
          sessionId,
          requestId,
          error: loopErr instanceof Error ? loopErr.message : String(loopErr),
        });
        // Keep `responseData` / `normalised` as the initial upstream
        // response so the IDE sees a tool-call turn it can act on.
      }
    }

    // ── Separate learning extraction ──
    // When a separate learning model is configured, fire a non-blocking
    // extraction call after the main model completes (only at end-of-turn,
    // not mid-turn tool-use).  The extraction runs in the background so
    // the client is not delayed.
    const finishReason = normalised.choices?.[0]?.finish_reason;
    const visibleResponseText = contentToText(normalised.choices?.[0]?.message?.content);

    // ── Anthropic native protocol path ──
    if (clientProtocol === 'anthropic' && providerType === 'anthropic') {
      if (separateLearningModel && finishReason === 'stop' && projectId) {
        const anthropicStopReason = (responseData as { stop_reason?: string })?.stop_reason;
        if (anthropicStopReason !== 'tool_use') {
          res.json(responseData);
          void performSeparateLearningExtraction({
            learningModel: separateLearningModel,
            responsePayload: responseData,
            visibleResponseText,
            requestMessages: requestBody.messages as ChatMessage[] | undefined,
            projectId,
            sessionId,
            requestId,
          });
          return;
        }
      }
      res.json(responseData);
      return;
    }

    // ── OpenAI (or bridged) protocol path ──
    if (separateLearningModel && finishReason === 'stop' && projectId) {
      res.json(normalised);
      void performSeparateLearningExtraction({
        learningModel: separateLearningModel,
        responsePayload: normalised,
        visibleResponseText,
        requestMessages: requestBody.messages as ChatMessage[] | undefined,
        projectId,
        sessionId,
        requestId,
      });
      return;
    }

    res.json(normalised);
  } catch (err) {
    const status = axios.isAxiosError(err) ? (err.response?.status ?? 502) : 502;
    const message = formatUpstreamErrorMessage(err);
    res.status(status).json({ error: { message, type: 'upstream_error' } });
  }
}
