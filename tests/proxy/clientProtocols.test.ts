import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../../src/proxy/adapters/anthropic';
import {
  extractAnthropicResponseText,
  normalizeRequestForClientProtocol,
  replaceAnthropicResponseText,
} from '../../src/proxy/clientProtocols';
import { appendTextToContent, contentToText, prependTextToContent } from '../../src/utils/messageContent';

describe('client protocol normalization', () => {
  it('normalizes Anthropic-style requests into proxy messages', () => {
    const normalized = normalizeRequestForClientProtocol(
      {
        model: 'claude-3-7-sonnet',
        system: [{ type: 'text', text: 'Be precise.' }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Explain this file.' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] },
          { role: 'user', content: 'Add more detail.' },
        ],
        stream: true,
      },
      'anthropic'
    );

    expect(normalized.model).toBe('claude-3-7-sonnet');
    expect(normalized).not.toHaveProperty('system');
    expect(normalized.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'Be precise.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Explain this file.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] },
      { role: 'user', content: 'Add more detail.' },
    ]);
  });

  it('builds anthropic system text from normalized messages instead of forwarding raw system payloads', () => {
    const payload = anthropicAdapter.buildRequest({
      model: 'claude-3-7-sonnet',
      messages: [
        { role: 'system', content: 'Injected context' },
        { role: 'system', content: [{ type: 'text', text: 'Be precise.' }] },
        { role: 'user', content: 'Explain this file.' },
      ],
      system: [{ type: 'text', text: 'stale upstream payload' }],
    });

    expect(payload).toEqual({
      model: 'claude-3-7-sonnet',
      max_tokens: 4096,
      system: 'Injected context\n\nBe precise.',
      messages: [{ role: 'user', content: 'Explain this file.' }],
    });
  });

  it('preserves text blocks when context or extraction instructions are appended', () => {
    const content = [{ type: 'text', text: 'Original prompt.' }];

    expect(contentToText(content)).toBe('Original prompt.');
    expect(appendTextToContent(content, 'Extraction block')).toEqual([
      { type: 'text', text: 'Original prompt.\n\nExtraction block' },
    ]);
    expect(prependTextToContent(content, 'Context block')).toEqual([
      { type: 'text', text: 'Context block' },
      { type: 'text', text: 'Original prompt.' },
    ]);
  });

  it('replaces cleaned Anthropic text without disturbing non-text blocks', () => {
    const response = {
      id: 'msg_1',
      type: 'message',
      content: [
        { type: 'text', text: 'Visible text\n\n<!--LEARN_START-->ignored<!--LEARN_END-->' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/index.ts' } },
      ],
    };

    expect(extractAnthropicResponseText(response)).toContain('Visible text');
    expect(replaceAnthropicResponseText(response, 'Visible text')).toEqual({
      id: 'msg_1',
      type: 'message',
      content: [
        { type: 'text', text: 'Visible text' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/index.ts' } },
      ],
    });
  });
});