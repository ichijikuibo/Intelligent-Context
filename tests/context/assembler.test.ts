import { describe, expect, it } from 'vitest';

import { assembleContextMessage } from '../../src/context/assembler';
import type { ContextCandidate } from '../../src/context/selector';

function makeSummaryCandidate(index: number): ContextCandidate {
  return {
    id: `summary-${index}`,
    type: 'summary',
    content: `One line summary ${index}`,
    fullContent: `Full summary content ${index}`,
    compactContent: [
      `- summary-${index} [auth, api] - confidence: 0.42`,
      `One line summary ${index}`,
      `Full details: use tool ic_get_summary with summary-${index}`,
    ].join('\n'),
    oneLineSummary: `One line summary ${index}`,
    category: 'auth',
    categories: ['auth', 'api'],
    similarity: 0.42,
  };
}

describe('assembleContextMessage', () => {
  it('keeps only the first five summaries at full detail and compacts the rest', () => {
    const candidates = Array.from({ length: 6 }, (_, index) => makeSummaryCandidate(index + 1));

    const contextBlock = assembleContextMessage(candidates, 'Project One');

    expect(contextBlock).toContain('Full summary content 1');
    expect(contextBlock).toContain('Full summary content 5');
    expect(contextBlock).not.toContain('Full summary content 6');
    expect(contextBlock).toContain('### Additional Summaries That Might Be Relevant');
    expect(contextBlock).toContain('- summary-6 [auth, api] - confidence: 0.42');
    expect(contextBlock).toContain('One line summary 6');
    expect(contextBlock).toContain('Full details: use tool ic_get_summary with summary-6');
  });
});