import { describe, expect, it } from 'vitest';
import { openaiAdapter } from '../../src/proxy/adapters/openai';

describe('openaiAdapter', () => {
  it('keeps openai-style requests intact apart from null stripping', () => {
    const request = { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] } as any;
    const response = { id: 'resp-1', object: 'chat.completion', choices: [] } as any;

    expect(openaiAdapter.buildRequest({ ...request, max_tokens: null })).toEqual(request);
    expect(openaiAdapter.parseResponse(response)).toBe(response);
  });

  it('converts anthropic-style tool messages and tool metadata for openai providers', () => {
    const payload = openaiAdapter.buildRequest({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Gather only.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the file now.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { filePath: 'src/index.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' },
            { type: 'text', text: 'Continue.' },
          ],
        },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
            required: ['filePath'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'read_file' },
    } as any);

    expect(payload).toEqual({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'Gather only.' },
        {
          role: 'assistant',
          content: 'Reading the file now.',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"filePath":"src/index.ts"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: 'file contents',
        },
        {
          role: 'user',
          content: 'Continue.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file.',
            parameters: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
              },
              required: ['filePath'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: {
          name: 'read_file',
        },
      },
    });
  });

  it('builds bearer headers and trims the provider base url', () => {
    expect(openaiAdapter.headers('secret-key')).toEqual({
      Authorization: 'Bearer secret-key',
      'Content-Type': 'application/json',
    });
    expect(openaiAdapter.endpoint('https://example.test/v1/')).toBe('https://example.test/v1/chat/completions');
  });
});