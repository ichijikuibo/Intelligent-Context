import { describe, expect, it } from 'vitest';
import { isToolContinuation } from '../../src/proxy/toolContinuation';

describe('isToolContinuation', () => {
  it('treats a trailing assistant tool_use block as a continuation', () => {
    expect(
      isToolContinuation([
        { role: 'system', content: 'ignored system message' },
        { role: 'assistant', content: [{ type: 'text', text: '   ' }, { type: 'tool_use', id: '1', name: 'read_file' }] },
      ] as any)
    ).toBe(true);
  });

  it('treats a trailing user tool_result block as a continuation', () => {
    expect(
      isToolContinuation([
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'read_file' }] },
        { role: 'user', content: [{ type: 'text', text: '   ' }, { type: 'tool_result', tool_use_id: '1', content: 'body' }] },
      ] as any)
    ).toBe(true);
  });

  it('treats a trailing tool role message as a continuation', () => {
    expect(
      isToolContinuation([
        { role: 'tool', content: 'tool output' },
      ] as any)
    ).toBe(true);
  });

  it('does not treat a fresh trailing user message as a continuation even with earlier tool history', () => {
    expect(
      isToolContinuation([
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'read_file' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'body' }] },
        { role: 'user', content: 'Now answer the question directly' },
      ] as any)
    ).toBe(false);
  });

  it('rejects mixed assistant content that contains visible text alongside tool blocks', () => {
    expect(
      isToolContinuation([
        { role: 'assistant', content: [{ type: 'text', text: 'I found this' }, { type: 'tool_use', id: '1', name: 'read_file' }] },
      ] as any)
    ).toBe(false);
  });
});