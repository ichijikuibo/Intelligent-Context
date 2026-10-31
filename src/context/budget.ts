import { estimateTokens } from '../utils/tokens';
import type { ChatMessage } from '../proxy/adapters/adapter';
import { contentToText } from '../utils/messageContent';
import { getEffectiveContextConfig } from '../config/configOverrides';
import { getReportedContextLength } from '../proxy/modelMetadataCache';
import { getModelReference } from '../proxy/modelReferenceCache';
import { MAX_FULL_SUMMARY_DETAILS } from './summaryInjection';

export function computeContextBudget(
  modelMaxTokens: number,
  requestMessages: ChatMessage[],
  reservedForResponse?: number,
  overhead?: number
): number {
  const ctx = getEffectiveContextConfig();
  const reserved = reservedForResponse ?? ctx.reservedResponseTokens;
  const over = overhead ?? ctx.contextOverheadTokens;
  const usedTokens = requestMessages.reduce(
    (sum, msg) => sum + estimateTokens(contentToText(msg.content)) + 4,
    3
  );
  const budget = modelMaxTokens - usedTokens - reserved - over;
  return Math.max(0, budget);
}

export interface BudgetCandidate {
  id: string;
  type: 'chunk' | 'summary' | 'finding';
  content: string;
  fullContent: string;
  compactContent?: string;
  similarity?: number;
  category?: string;
  categories?: string[];
  guaranteed?: boolean;
}

export function estimateCandidateInjectionTokens(candidates: BudgetCandidate[]): number {
  let selectedSummaryCount = 0;
  let total = 0;

  for (const candidate of candidates) {
    total += estimateTokens(contentForInjectedCandidate(candidate, selectedSummaryCount));
    if (candidate.type === 'summary') {
      selectedSummaryCount++;
    }
  }

  return total;
}

export function fillBudget(
  ranked: BudgetCandidate[],
  budget: number
): BudgetCandidate[] {
  const selected: BudgetCandidate[] = [];
  let used = 0;
  let selectedSummaryCount = 0;

  const trySelect = (candidate: BudgetCandidate): void => {
    const tokens = estimateTokens(contentForInjectedCandidate(candidate, selectedSummaryCount));
    if (used + tokens > budget) return;
    selected.push(candidate);
    used += tokens;
    if (candidate.type === 'summary') {
      selectedSummaryCount++;
    }
  };

  // ── Phase 0: Guaranteed candidates first ──
  // File-linked chunks are attached because the request explicitly referenced
  // them, so they get first access to the budget ahead of general retrieval.
  const guaranteedCandidates = ranked.filter((c) => c.guaranteed === true);
  const remainingAfterGuaranteed = ranked.filter((c) => !guaranteedCandidates.includes(c));

  for (const candidate of guaranteedCandidates) {
    trySelect(candidate);
  }

  // ── Phase 1: Global candidates first ──
  // Global summaries carry system-wide conventions (date formats, coding
  // standards, etc.) and should be attached to nearly every prompt.
  // Processing them first gives them priority access to the budget;
  // high-scoring domain-specific candidates fill what remains.
  const globalCandidates = remainingAfterGuaranteed.filter((c) => c.categories?.includes('global') ?? false);
  const nonGlobalCandidates = remainingAfterGuaranteed.filter((c) => !globalCandidates.includes(c));

  for (const candidate of globalCandidates) {
    // Global candidates consume from the global reserve first;
    // they can spill into main budget but are never skipped entirely.
    trySelect(candidate);
  }

  // ── Phase 2: Remaining candidates fill the leftover budget ──
  // Sort by relevance (similarity descending) so that the most relevant
  // candidates are prioritised within the token budget.

  nonGlobalCandidates.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  for (const candidate of nonGlobalCandidates) {
    trySelect(candidate);
  }

  return selected;
}

/** Estimated max context for well-known models */
export function modelMaxTokens(modelName: string): number {
  // Prefer the context window the provider actually reported for this model
  // (persisted from its /models endpoint). Newer gateways advertise a real
  // per-model window, which beats any name-based guess below.
  const reported = getReportedContextLength(modelName);
  if (reported !== undefined) return reported;

  // Fall back to the shared reference catalog (synced from OpenRouter). It
  // covers models whose own provider reports nothing beyond the model ID.
  const reference = getModelReference(modelName)?.contextLength;
  if (typeof reference === 'number' && reference > 0) return reference;

  return heuristicModelMaxTokens(modelName);
}

/** Name-based fallback used when the provider reports no context window. */
function heuristicModelMaxTokens(modelName: string): number {
  const lower = modelName.toLowerCase();
  if (lower.includes('gpt-4o')) return 128_000;
  if (lower.includes('gpt-4-turbo')) return 128_000;
  if (lower.includes('gpt-4')) return 8_192;
  if (lower.includes('gpt-3.5')) return 16_385;
  if (lower.includes('claude-3')) return 200_000;
  if (lower.includes('claude-2')) return 100_000;
  if (lower.includes('deepseek')) return 128_000;
  if (lower.includes('gemini')) return 1_000_000;
  return getEffectiveContextConfig().defaultModelMaxTokens;
}

function contentForInjectedCandidate(candidate: BudgetCandidate, selectedSummaryCount: number): string {
  if (candidate.type === 'summary' && selectedSummaryCount >= MAX_FULL_SUMMARY_DETAILS) {
    return candidate.compactContent ?? candidate.content;
  }

  return candidate.fullContent;
}
