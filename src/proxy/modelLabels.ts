/**
 * Helpers for the human-readable model labels the `/v1/models` catalog
 * advertises.
 *
 * Catalog entries expose three identifiers:
 *
 *   - `id`           — provider-scoped routing ID (`CCO-deepseek-v4.1-flash`)
 *   - `model_id`     — raw upstream model ID (`deepseek/deepseek-v4.1-flash`)
 *   - `display_name` — human label (`CommandCode (OpenAI) · DeepSeek V4.1 Flash`)
 *
 * Clients are supposed to echo `id` (or `model_id`), but `display_name` is the
 * most prominent field and integrations commonly send that instead. It is not a
 * valid upstream model, so the proxy has to translate it back to a real
 * provider + model pair — otherwise the request falls through to type-based
 * provider guessing and is forwarded with an unusable model name.
 */
import { getReportedDisplayNameForProvider } from './modelMetadataCache';

/** Separator between the provider name and the model label, e.g. `"A · B"`. */
export const MODEL_LABEL_SEPARATOR = ' \u00b7 ';

/** Build the catalog `display_name` for a provider + model label. */
export function buildModelDisplayName(providerName: string, modelLabel: string): string {
  return `${providerName}${MODEL_LABEL_SEPARATOR}${modelLabel}`;
}

/**
 * Split a display label into its provider name and model label.
 * Returns `undefined` when the label carries no `"provider · model"` prefix.
 */
export function parseModelDisplayName(
  displayName: string
): { providerName: string; modelLabel: string } | undefined {
  const index = displayName.indexOf(MODEL_LABEL_SEPARATOR);
  if (index <= 0) return undefined;

  const providerName = displayName.slice(0, index).trim();
  const modelLabel = displayName.slice(index + MODEL_LABEL_SEPARATOR.length).trim();
  if (!providerName || !modelLabel) return undefined;

  return { providerName, modelLabel };
}

/**
 * True when a requested model looks like a catalog label rather than a model ID.
 *
 * Reported labels contain spaces (`"DeepSeek V4.1 Flash"`, `"GPT-6 Astra"`)
 * while model IDs do not, so whitespace is a reliable signal. Callers use this
 * to decide whether a label lookup is worth attempting.
 */
export function looksLikeModelLabel(model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed) return false;
  return trimmed.includes(MODEL_LABEL_SEPARATOR) || /\s/.test(trimmed);
}

/** The label a provider shows for one of its models. */
export function modelLabelFor(providerId: string, modelId: string): string {
  return getReportedDisplayNameForProvider(providerId, modelId) ?? modelId;
}
