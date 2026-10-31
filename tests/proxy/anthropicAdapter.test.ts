import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../../src/proxy/adapters/anthropic';

describe('anthropicAdapter', () => {
  it('converts openai-style tools and tool messages into anthropic request payloads', () => {
    const payload = anthropicAdapter.buildRequest({
      model: 'claude-sonnet-4',
      messages: [
        { role: 'system', content: 'system rules' },
        { role: 'user', content: 'review summary' },
        {
          role: 'assistant',
          content: 'Checking summary first.',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: {
                name: 'ic_get_summary',
                arguments: '{"summaryId":"summary-1"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: '{"success":true,"result":{"id":"summary-1"}}',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'ic_get_summary',
            description: 'Get one summary.',
            parameters: {
              type: 'object',
              properties: {
                summaryId: { type: 'string' },
              },
              required: ['summaryId'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 2048,
    });

    expect(payload).toEqual({
      model: 'claude-sonnet-4',
      max_tokens: 2048,
      system: 'system rules',
      messages: [
        { role: 'user', content: 'review summary' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking summary first.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'ic_get_summary',
              input: { summaryId: 'summary-1' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '{"success":true,"result":{"id":"summary-1"}}',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'ic_get_summary',
          description: 'Get one summary.',
          input_schema: {
            type: 'object',
            properties: {
              summaryId: { type: 'string' },
            },
            required: ['summaryId'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'auto' },
    });
  });

  it('normalizes anthropic tool_use responses into openai-style tool_calls', () => {
    const response = anthropicAdapter.parseResponse({
      id: 'msg_1',
      model: 'claude-sonnet-4',
      content: [
        { type: 'text', text: 'Looking up the summary.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'ic_get_summary',
          input: { summaryId: 'summary-1' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 11,
        output_tokens: 7,
      },
    });

    expect(response).toEqual({
      id: 'msg_1',
      object: 'chat.completion',
      model: 'claude-sonnet-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Looking up the summary.',
            tool_calls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: {
                  name: 'ic_get_summary',
                  arguments: '{"summaryId":"summary-1"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
  });

  it('maps anthropic end_turn responses to stop', () => {
    const response = anthropicAdapter.parseResponse({
      id: 'msg_2',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    });

    expect(response.choices[0]?.finish_reason).toBe('stop');
    expect(response.choices[0]?.message.content).toBe('done');
  });
});
