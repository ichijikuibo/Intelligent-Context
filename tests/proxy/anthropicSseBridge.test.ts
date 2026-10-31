import { describe, expect, it } from 'vitest';
import {
  AnthropicToOpenAiStream,
  convertOpenAiSseToAnthropic,
} from '../../src/proxy/anthropicSseBridge';

describe('convertOpenAiSseToAnthropic', () => {
  it('converts openai tool-call streams into anthropic message events', () => {
    const rawSse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"content":"Checking the file."},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\":\\"src/index.ts\\"}"}}]},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const bridged = convertOpenAiSseToAnthropic(rawSse);

    expect(bridged).toContain('"type":"message_start"');
    expect(bridged).toContain('"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking the file."}');
    expect(bridged).toContain('"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"read_file"}');
    expect(bridged).toContain('"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"src/index.ts\\"}"');
    expect(bridged).toContain('"stop_reason":"tool_use"');
    expect(bridged).toContain('"type":"message_stop"');
  });
});

async function collectOutput(chunks: string[]): Promise<string> {
  const bridge = new AnthropicToOpenAiStream();
  const buffers: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    bridge.on('data', (chunk: Buffer | string) => {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    bridge.on('error', reject);
    bridge.on('end', resolve);

    for (const chunk of chunks) {
      bridge.write(Buffer.from(chunk, 'utf8'));
    }

    bridge.end();
  });

  return Buffer.concat(buffers).toString('utf8');
}

describe('AnthropicToOpenAiStream', () => {
  it('converts Anthropic text deltas into OpenAI chat completion chunks', async () => {
    const events = [
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-3-7-sonnet"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];

    const output = await collectOutput([
      events[0].slice(0, 22),
      events[0].slice(22) + events[1],
      events[2] + events[3] + events[4],
    ]);

    const lines = output
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]');
    const chunks = lines.map((line) => JSON.parse(line.slice('data: '.length)) as {
      model: string;
      choices: Array<{ delta: { role?: string; content?: string }; finish_reason: string | null }>;
    });

    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join('')).toBe('Hello world');
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop');
    expect(chunks[0].model).toBe('claude-3-7-sonnet');
    expect(output).toContain('data: [DONE]');
  });
});