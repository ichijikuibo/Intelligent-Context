import type { ExternalProviderDef } from './types';
import { opencodeGoDef } from './opencodeGo';
import { commandCodeDef } from './commandCode';
import { openaiDef } from './openai';
import { anthropicDef } from './anthropic';
import { deepseekDef } from './deepseek';

/** All known external provider definitions, keyed by providerKey. */
const registry = new Map<string, ExternalProviderDef>();

function register(def: ExternalProviderDef): void {
  if (registry.has(def.key)) {
    throw new Error(`Duplicate external provider key: ${def.key}`);
  }
  registry.set(def.key, def);
}

// ── Register built-in providers ────────────────────────────────────────────
register(opencodeGoDef);
register(commandCodeDef);
register(openaiDef);
register(anthropicDef);
register(deepseekDef);

// Future providers will be registered here:
// register(githubCopilotDef);
// etc.

/** Get a provider definition by key. */
export function getExternalProviderDef(key: string): ExternalProviderDef | undefined {
  return registry.get(key);
}

/** List all available external provider definitions (for the UI). */
export function listExternalProviderDefs(): ExternalProviderDef[] {
  return Array.from(registry.values());
}
