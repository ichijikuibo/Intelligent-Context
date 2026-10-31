/**
 * Runtime overrides for the static `AppConfig`.
 *
 * The base config is loaded from YAML / env at startup.  A subset of the
 * `context.*` fields can be tuned from the Settings UI, and we persist those
 * values in the `system_config` table.  This module is the single source of
 * truth for the *effective* runtime configuration: it layers the DB overrides
 * on top of the YAML base config and returns a fully-typed snapshot.
 *
 * Callers (selector, budget, context-inject middleware) should prefer
 * `getEffectiveContextConfig()` over `getConfig().context` for fields that
 * the UI can override.
 */
import { getConfig, type ContextConfig } from './config';
import { getSystemConfigCacheValue } from './systemConfigCache';

function readOverride(key: string): string {
  return getSystemConfigCacheValue(key);
}

function overrideNumber(
  key: string,
  fallback: number
): number {
  const raw = readOverride(`context.${key}`);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Returns the effective `ContextConfig` for this request, with any
 * DB-stored UI overrides layered on top of the YAML/env base config.
 */
export function getEffectiveContextConfig(): ContextConfig {
  const base = getConfig().context;
  return {
    ...base,
    bypassSelectorItemThreshold: overrideNumber(
      'bypassSelectorItemThreshold',
      base.bypassSelectorItemThreshold
    ),
    bypassSelectorTokenThreshold: overrideNumber(
      'bypassSelectorTokenThreshold',
      base.bypassSelectorTokenThreshold
    ),
    contextReplayTtlMinutes: overrideNumber(
      'contextReplayTtlMinutes',
      base.contextReplayTtlMinutes
    ),
    maxCachedContexts: overrideNumber('maxCachedContexts', base.maxCachedContexts),
    reservedResponseTokens: overrideNumber(
      'reservedResponseTokens',
      base.reservedResponseTokens
    ),
    contextOverheadTokens: overrideNumber(
      'contextOverheadTokens',
      base.contextOverheadTokens
    ),
    defaultModelMaxTokens: overrideNumber('defaultModelMaxTokens', base.defaultModelMaxTokens),
    maxRecordLearnings: overrideNumber('maxRecordLearnings', base.maxRecordLearnings),
    tokenBudget: overrideNumber('tokenBudget', base.tokenBudget),
  };
}

/** Reset cached config (useful for tests). */
export function resetConfigOverrides(): void {
  // No internal cache — every call reads from DB — so nothing to reset.
  // Function exists for symmetry with `resetConfig()` and future use.
}
