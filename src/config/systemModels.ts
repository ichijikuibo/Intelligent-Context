/**
 * Reads model selections from the system_config DB table.
 * Returns empty strings if not yet configured (Settings tab not visited).
 */
import { getSystemConfigCacheValue } from './systemConfigCache';

export type RequestContextMode = 'basic' | 'selector' | 'gatherer';

export interface SystemModelConfig {
  requestContextMode: RequestContextMode;
  contextSelector: string;
  summarizer: string;
  analyzer: string;
  learning: string;
  gatherer: string;
  /**
   * Model that interprets images on behalf of models that cannot see them.
   * When set, the proxy forwards images from any model to this one and injects
   * the returned description as text.
   */
  vision: string;
  /**
   * Dedicated model for the explicit `ic_select_context` tool. Falls back to
   * the context selector model when unset.
   */
  icTools: string;
  /**
   * Model used by the management-UI project chat. Falls back to the ic-tools
   * model (and then the context selector) when unset.
   */
  chat: string;
  enableAgentAnalyzer: boolean;
  analyzerAgentMaxTurns: number;
}

function readConfigKey(key: string): string {
  return getSystemConfigCacheValue(key);
}

function readBooleanKey(key: string, fallback = false): boolean {
  const value = readConfigKey(key).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readNumberKey(key: string, fallback: number): number {
  const value = readConfigKey(key).trim();
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

export function normalizeRequestContextMode(value: string | undefined | null): RequestContextMode | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'basic':
    case 'selector':
    case 'gatherer':
      return (value ?? '').trim().toLowerCase() as RequestContextMode;
    default:
      return null;
  }
}

export function resolveRequestContextMode(
  rawMode: string | undefined | null,
  gathererModel: string | undefined | null,
): RequestContextMode {
  const normalized = normalizeRequestContextMode(rawMode);
  if (normalized) return normalized;

  return (gathererModel ?? '').trim().length > 0 ? 'gatherer' : 'selector';
}

/** Returns the currently configured model selections from the DB. */
export function getSystemModelConfig(): SystemModelConfig {
  const gatherer = readConfigKey('gathererModel');

  return {
    requestContextMode: resolveRequestContextMode(readConfigKey('requestContextMode'), gatherer),
    contextSelector: readConfigKey('contextSelectorModel'),
    summarizer: readConfigKey('summarizerModel'),
    analyzer: readConfigKey('analyzerModel'),
    learning: readConfigKey('learningModel'),
    gatherer,
    vision: readConfigKey('visionModel'),
    icTools: readConfigKey('icToolsModel') || readConfigKey('contextSelectorModel'),
    chat: readConfigKey('chatModel'),
    enableAgentAnalyzer: readBooleanKey('enableAgentAnalyzer', false),
    analyzerAgentMaxTurns: readNumberKey('analyzerAgentMaxTurns', 60),
  };
}
