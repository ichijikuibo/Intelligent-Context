import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../../src/utils/tokens';
import { estimateCandidateInjectionTokens, fillBudget, type BudgetCandidate } from '../../src/context/budget';

function repeatedWord(word: string, count: number): string {
  return Array.from({ length: count }, () => word).join(' ');
}

function makeSummaryCandidate(index: number): BudgetCandidate {
  return {
    id: `summary-${index}`,
    type: 'summary',
    content: `One line summary ${index}`,
    fullContent: repeatedWord(`detail${index}`, 100),
    compactContent: [
      `- summary-${index} [auth] - confidence: 0.50`,
      `One line summary ${index}`,
      `Full details: use tool ic_get_summary with summary-${index}`,
    ].join('\n'),
    similarity: 1 - index * 0.01,
    categories: ['auth'],
  };
}

describe('fillBudget', () => {
  it('budgets summaries after the first five using their compact payload', () => {
    const candidates = Array.from({ length: 6 }, (_, index) => makeSummaryCandidate(index + 1));

    const allFullTokens = candidates.reduce((total, candidate) => total + estimateTokens(candidate.fullContent), 0);
    const injectedTokens = estimateCandidateInjectionTokens(candidates);
    const selected = fillBudget(candidates, injectedTokens);

    expect(injectedTokens).toBeLessThan(allFullTokens);
    expect(selected.map((candidate) => candidate.id)).toEqual(candidates.map((candidate) => candidate.id));
  });
});