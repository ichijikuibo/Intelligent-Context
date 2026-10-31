/**
 * Builds the enriched `/v1/models` catalog.
 *
 * The catalog is consumed by IDE extensions (notably the Intelligent Context
 * VS Code extension) so they can auto-populate their model picker without the
 * user hand-typing model IDs. Each entry therefore carries more than the bare
 * OpenAI `id`/`object`/`owned_by` triple:
 *
 *   - `api_format`        — which wire protocol the model speaks (`openai` | `anthropic`)
 *   - `context_window`    — the model's raw maximum context size, in tokens
 *   - `supports_reasoning`— whether the model accepts reasoning-effort levels
 *   - `supports_vision`   — whether the model can be sent images
 *   - `max_input_tokens`  — the usable prompt budget after reserving room for the
 *                           response and per-request context overhead
 *   - `max_output_tokens` — tokens reserved for the model's reply
 *
 * Where a provider's `/models` endpoint advertises a real context window, that
 * value is used for `context_window` instead of the built-in name heuristic;
 * see `modelMetadataCache`. Per-model overrides from the management UI's Models
 * dialog take precedence over reported values.
 *
 * `supports_vision` is true for a model the user marked as vision-capable, and
 * for **every** model once a vision model is configured in Settings — the proxy
 * then interprets images on behalf of models that cannot see them.
 *
 * Duplicate model IDs across providers are already disambiguated by the
 * provider-scoped ID prefix (`OCO-deepseek-chat` vs `DSK-deepseek-chat`), so
 * the same underlying model can be offered by two providers at once.
 */
import { modelMaxTokens } from '../context/budget';
import { getEffectiveContextConfig } from '../config/configOverrides';
import { getSystemModelConfig } from '../config/systemModels';
import {
  getModelSupportsReasoningForProvider,
  getModelSupportsVisionForProvider,
  getReportedApiFormatForProvider,
} from './modelMetadataCache';
import { getModelReference } from './modelReferenceCache';
import { buildModelDisplayName, modelLabelFor } from './modelLabels';
import type { ProviderConfig } from '../db/schema';
import { buildProviderScopedModelId } from './modelSelection';

export interface ModelCatalogEntry {
  id: string;
  object: 'model';
  owned_by: string;
  created: number;
  provider_type: string;
  provider_name: string;
  provider_id: string;
  base_url: string;
  /** Wire protocol the model accepts: 'openai' (chat/completions) or 'anthropic' (messages). */
  api_format: 'openai' | 'anthropic';
  /** Raw model context window in tokens. */
  context_window: number;
  /**
   * Whether the model accepts reasoning-effort levels. Clients can use this to
   * offer (and send) a reasoning configuration without probing the upstream.
   */
  supports_reasoning: boolean;
  /**
   * Whether the model can be sent images. True when the model itself was marked
   * vision-capable, or when a vision model is configured to interpret images on
   * its behalf.
   */
  supports_vision: boolean;
  /** Prompt budget the client should use (context window minus reserved response/overhead). */
  max_input_tokens: number;
  /** Tokens reserved for the model's reply. */
  max_output_tokens: number;
  /**
   * Raw upstream model ID. Clients must echo this back (together with
   * `provider_id`) when requesting the model — `display_name` is for humans.
   */
  model_id: string;
  /**
   * Human-readable label for pickers, prefixed with the provider name so the
   * same model offered by two providers stays distinguishable.
   */
  display_name: string;
}

/** Tokens reserved for the response when sizing the client's prompt budget. */
function reservedResponseTokens(): number {
  return Math.max(0, getEffectiveContextConfig().reservedResponseTokens);
}

/** Per-request framing overhead that must also be subtracted from the budget. */
function contextOverheadTokens(): number {
  return Math.max(0, getEffectiveContextConfig().contextOverheadTokens);
}

/**
 * True when a vision model is configured, in which case every model is reported
 * as vision-capable: the proxy forwards images to the vision model and injects
 * the description as text.
 */
function hasConfiguredVisionModel(): boolean {
  return getSystemModelConfig().vision.trim().length > 0;
}

/**
 * Compute the prompt budget advertised to clients for a given model.
 * Never returns less than 1 so clients cannot end up with a zero/negative budget.
 */
export function computeMaxInputTokens(modelId: string): {
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
} {
  const contextWindow = modelMaxTokens(modelId);
  const maxOutputTokens = reservedResponseTokens();
  const reserved = maxOutputTokens + contextOverheadTokens();
  const maxInputTokens = Math.max(1, contextWindow - reserved);

  return { contextWindow, maxInputTokens, maxOutputTokens };
}

/** Build a single catalog entry for a provider + raw model ID. */
export function buildModelCatalogEntry(
  provider: Pick<ProviderConfig, 'id' | 'name' | 'type' | 'baseUrl' | 'shortPrefix' | 'createdAt'>,
  modelId: string,
  /** Optional provider-scoped ID override; defaults to the prefix/UUID form. */
  scopedId?: string,
): ModelCatalogEntry {
  const { contextWindow, maxInputTokens, maxOutputTokens } = computeMaxInputTokens(modelId);

  // The provider's reported name is a human label (e.g. "GPT-6 Astra"), which is
  // not a valid wire model. Keep it for display and expose the raw ID separately.
  const modelLabel = modelLabelFor(provider.id, modelId);

  return {
    id: scopedId ?? buildProviderScopedModelId(provider, modelId),
    object: 'model',
    owned_by: provider.name,
    created: Math.floor(new Date(provider.createdAt).getTime() / 1000),
    provider_type: provider.type,
    provider_name: provider.name,
    provider_id: provider.id,
    base_url: provider.baseUrl,
    api_format:
      getReportedApiFormatForProvider(provider.id, modelId) ??
      (provider.type === 'anthropic' ? 'anthropic' : 'openai'),
    context_window: contextWindow,
    supports_reasoning:
      getModelSupportsReasoningForProvider(provider.id, modelId) ??
      getModelReference(modelId)?.supportsReasoning ??
      false,
    supports_vision:
      hasConfiguredVisionModel() ||
      getModelSupportsVisionForProvider(provider.id, modelId) === true ||
      getModelReference(modelId)?.supportsVision === true,
    max_input_tokens: maxInputTokens,
    max_output_tokens: maxOutputTokens,
    model_id: modelId,
    // Provider first: it is the disambiguator when several providers expose the
    // same underlying model, and it reads better than trailing nested parens
    // for external sub-providers like "CommandCode (OpenAI)".
    display_name: buildModelDisplayName(provider.name, modelLabel),
  };
}
