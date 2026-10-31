import { describe, expect, it } from 'vitest';
import { parseSseToProxyResponse, streamCompletionAsSse } from '../../src/proxy/unifiedStream';

describe('unifiedStream reasoning preservation', () => {
  it('preserves reasoning_content when reconstructing a streamed tool-call response', () => {
    const rawSse = [
      'data: {"id":"resp_1","object":"chat.completion.chunk","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"id":"resp_1","object":"chat.completion.chunk","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"step "},"finish_reason":null}]}',
      'data: {"id":"resp_1","object":"chat.completion.chunk","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"1"},"finish_reason":null}]}',
      'data: {"id":"resp_1","object":"chat.completion.chunk","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"ic_list_findings","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"resp_1","object":"chat.completion.chunk","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}',
      'data: {"id":"resp_1","object":"chat.completion.chunk","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ].join('\n');

    const response = parseSseToProxyResponse(rawSse);
    const message = response.choices[0]?.message as Record<string, unknown>;

    expect(message.reasoning_content).toBe('step 1');
    expect(message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'ic_list_findings',
          arguments: '{}',
        },
      },
    ]);
  });

  it('re-emits reasoning_content when serializing a response back to SSE', () => {
    const chunks: string[] = [];

    streamCompletionAsSse({
      id: 'resp_2',
      object: 'chat.completion',
      model: 'deepseek-v4-flash',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'done',
          reasoning_content: 'thought trail',
        } as any,
        finish_reason: 'stop',
      }],
    }, (chunk) => chunks.push(chunk));

    const serialized = chunks.join('');
    expect(serialized).toContain('"reasoning_content":"thought trail"');
    expect(serialized).toContain('"content":"done"');
  });
});