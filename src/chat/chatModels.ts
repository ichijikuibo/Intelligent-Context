/**
 * Chat model options.
 *
 * The Chat tab lets the user pick the model for the conversation, like any
 * other chat UI. The list is deliberately scoped to the caller: it reuses the
 * exact same access rules as `/v1/models` and the Models tab
 * (`hasModelAccess`), so a user can only ever select a model they are allowed
 * to reach — and the chat service re-checks on every turn rather than trusting
 * the client.
 *
 * Visibility preferences (`hiddenModels`) are intentionally NOT applied here:
 * hiding a model only controls the IDE picker, not what the user may use.
 */
import { hasModelAccess, hasUnrestrictedModelAccess } from '../auth/context';
import { providersRepo } from '../db/repositories/providers';
import { parseModels, type ProviderConfig } from '../db/schema';
import { buildProviderScopedModelId, normalizeRequestedModelSelection } from '../proxy/modelSelection';
import { buildModelDisplayName, modelLabelFor } from '../proxy/modelLabels';
import type { PublicUser } from '../db/repositories/users';

export interface ChatModelOption {
  /** Provider-scoped model ID to send as the chat `model`. */
  value: string;
  /** Human label for the picker: "<provider> · <model label>". */
  label: string;
  providerId: string;
  providerName: string;
}

/** Build the chat model picker options visible to `user`. */
export async function buildChatModelOptions(user: PublicUser | undefined): Promise<ChatModelOption[]> {
  const providers = (await providersRepo.findAll()).filter((p) => p.isEnabled);
  const unrestricted = !user || hasUnrestrictedModelAccess(user);
  const options: ChatModelOption[] = [];

  for (const provider of providers) {
    for (const modelId of parseModels(provider as ProviderConfig)) {
      const scopedId = buildProviderScopedModelId(provider, modelId);
      if (!unrestricted && !hasModelAccess(user!, scopedId)) continue;
      options.push({
        value: scopedId,
        label: buildModelDisplayName(provider.name, modelLabelFor(provider.id, modelId)),
        providerId: provider.id,
        providerName: provider.name,
      });
    }
  }

  return options.sort(
    (a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)
  );
}

/** True when the caller may use the given chat model selection. */
export function canUseChatModel(user: PublicUser | undefined, modelSelection: string): boolean {
  if (!user || hasUnrestrictedModelAccess(user)) return true;
  const trimmed = modelSelection.trim();
  if (!trimmed) return false;
  // `hasModelAccess` normalises the provider-scoped ID back into every form a
  // grant could have been written against.
  return hasModelAccess(user, trimmed);
}

/**
 * Resolve a stored chat model selection to one of `options`.
 *
 * The Settings dropdown stores the provider-scoped ID (`OAI-gpt-4.1`), but an
 * older or hand-edited value may be the raw model ID (`gpt-4.1`). Both forms
 * are matched so the picker can preselect the configured default; returns `''`
 * when the selection is not in the caller's accessible list.
 */
export function resolveChatModelOption(options: ChatModelOption[], selection: string): string {
  const trimmed = selection.trim();
  if (!trimmed) return '';

  const exact = options.find((option) => option.value === trimmed);
  if (exact) return exact.value;

  const rawModel = normalizeRequestedModelSelection(trimmed).model || trimmed;
  const byModel = options.find((option) => {
    const optionModel = normalizeRequestedModelSelection(option.value).model || option.value;
    return optionModel === rawModel || option.value.endsWith(`-${rawModel}`);
  });
  return byModel?.value ?? '';
}
