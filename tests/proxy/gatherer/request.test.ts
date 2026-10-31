import { describe, expect, it } from 'vitest';
import { buildGathererRequest, buildGathererContextBlock } from '../../../src/proxy/gatherer/request';
import { GATHERER_SYSTEM_PROMPT } from '../../../src/learning/gathererPrompt';
import { LEARNING_CALL_TO_ACTION_TAG } from '../../../src/learning/systemInstruction';
import type { ProxyRequest } from '../../../src/proxy/adapters/adapter';

function makeBody(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: 'claude-opus-4-20250514',
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant.' },
      { role: 'user', content: 'Implement feature X' },
    ],
    stream: true,
    ...overrides,
  };
}

function expectGathererReminder(content: unknown, textPrefix: string) {
  expect(content).toBeTypeOf('string');
  expect(String(content)).toContain(textPrefix);
  expect(String(content)).toContain('[gatherer reminder: gather information only');
}

describe('buildGathererRequest', () => {
  it('prepends the gatherer system prompt as the first message', () => {
    const result = buildGathererRequest(makeBody(), 'deepseek-chat');

    expect(result.messages[0]).toEqual({
      role: 'system',
      content: GATHERER_SYSTEM_PROMPT,
    });
  });

  it('sets the model to the gatherer model', () => {
    const result = buildGathererRequest(makeBody(), 'deepseek-chat');
    expect(result.model).toBe('deepseek-chat');
  });

  it('forces stream to true even if the original had stream: false', () => {
    const result = buildGathererRequest(makeBody({ stream: false }), 'deepseek-chat');
    expect(result.stream).toBe(true);
  });

  it('strips IDE system messages (those without <project_context>)', () => {
    const body = makeBody({
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    const result = buildGathererRequest(body, 'deepseek-chat');

    // Only the gatherer instruction system message + the user message should remain
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system'); // gatherer instruction
    expect(result.messages[0].content).toBe(GATHERER_SYSTEM_PROMPT);
    expect(result.messages[1].role).toBe('user');
    expectGathererReminder(result.messages[1].content, 'Hello');
  });

  it('keeps system messages that contain <project_context>', () => {
    const body = makeBody({
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'system', content: '<project_context>Some relevant context</project_context>' },
        { role: 'user', content: 'Hello' },
      ],
    });
    const result = buildGathererRequest(body, 'deepseek-chat');

    // Should have: gatherer instruction, project context, user message
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe('system'); // gatherer instruction
    expect(result.messages[1]).toEqual({
      role: 'system',
      content: '<project_context>Some relevant context</project_context>',
    });
    expect(result.messages[2].role).toBe('user');
    expectGathererReminder(result.messages[2].content, 'Hello');
  });

  it('preserves non-system messages such as assistant and tool turns', () => {
    const body = makeBody({
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'Read the file' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
        { role: 'user', content: 'Continue' },
      ],
    });
    const result = buildGathererRequest(body, 'deepseek-chat');

    // Gatherer instruction + user + assistant(tool_calls) + tool + user
    expect(result.messages).toHaveLength(5);
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Read the file' });
    expect(result.messages[2].role).toBe('assistant');
    expect(result.messages[3].role).toBe('tool');
    expect(result.messages[4].role).toBe('user');
    expectGathererReminder(result.messages[4].content, 'Continue');
  });

  it('strips the learning call-to-action user message and keeps the reminder on the real user turn', () => {
    const body = makeBody({
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'Investigate the auth flow' },
        { role: 'user', content: `${LEARNING_CALL_TO_ACTION_TAG}\nCall record_learning before responding.` },
      ],
    });

    const result = buildGathererRequest(body, 'deepseek-chat');

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: GATHERER_SYSTEM_PROMPT,
    });
    expect(result.messages[1].role).toBe('user');
    expectGathererReminder(result.messages[1].content, 'Investigate the auth flow');
    expect(String(result.messages[1].content)).not.toContain(LEARNING_CALL_TO_ACTION_TAG);
  });

  it('replays the prior assistant tool-call message before continuation tool results', () => {
    const result = buildGathererRequest(
      makeBody({
        messages: [
          { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
        ],
      }),
      'deepseek-chat',
      undefined,
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'thought trail',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      } as any,
    );

    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'thought trail',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
    expect(result.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' });
  });

  it('merges stored reasoning_content into an existing continuation assistant message', () => {
    const result = buildGathererRequest(
      makeBody({
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
        ],
      }),
      'deepseek-chat',
      undefined,
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'thought trail',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      } as any,
    );

    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'thought trail',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
  });

  it('does not insert a duplicate assistant replay before anthropic tool_use continuations', () => {
    const result = buildGathererRequest(
      makeBody({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { filePath: 'src/index.ts' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
          },
        ],
      }),
      'deepseek-chat',
      undefined,
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'thought trail',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"filePath":"src/index.ts"}' } }],
      } as any,
    );

    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { filePath: 'src/index.ts' } }],
      reasoning_content: 'thought trail',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"filePath":"src/index.ts"}' } }],
    });
    expect(result.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
    });
  });

  it('passes through the original tools list', () => {
    const tools = [
      { type: 'function' as const, function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' as const, properties: {} as Record<string, unknown>, additionalProperties: false } } },
    ];
    const result = buildGathererRequest(makeBody({ tools }), 'deepseek-chat');
    expect(result.tools).toBe(tools);
  });

  it('does not mutate the original body', () => {
    const original = makeBody();
    const copy = { ...original, messages: [...original.messages] };
    const result = buildGathererRequest(original, 'deepseek-chat');

    // Original should still have the IDE system message
    expect(original.messages).toHaveLength(2);
    expect(original.messages[0].role).toBe('system');
    expect(original.messages[0].content).toBe('You are a helpful coding assistant.');

    // Result should have stripped it
    expect(result.messages).toHaveLength(2); // gatherer instruction + user
    expect(result.messages[0].content).toBe(GATHERER_SYSTEM_PROMPT);
  });

  it('handles empty messages array', () => {
    const body = makeBody({ messages: [] });
    const result = buildGathererRequest(body, 'deepseek-chat');
    expect(result.messages).toHaveLength(1); // just the gatherer instruction
    expect(result.messages[0].role).toBe('system');
  });

  it('handles messages with no system messages at all', () => {
    const body = makeBody({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
    });
    const result = buildGathererRequest(body, 'deepseek-chat');
    // Gatherer instruction + user + assistant
    expect(result.messages).toHaveLength(3);
  });

  it('strips all IDE system messages when none carry <project_context>', () => {
    const body = makeBody({
      messages: [
        { role: 'system', content: 'System prompt A' },
        { role: 'system', content: 'System prompt B' },
        { role: 'user', content: 'Hi' },
      ],
    });
    const result = buildGathererRequest(body, 'deepseek-chat');
    // Gatherer instruction + user
    expect(result.messages).toHaveLength(2);
  });

  it('adds a selector-generated shortlist message when provided', () => {
    const result = buildGathererRequest(makeBody(), 'deepseek-chat', {
      queryText: 'Inspect auth flow',
      referencedFiles: [],
      prioritySummaryIds: ['summary-auth'],
      summaryDescriptors: [{
        id: 'summary-auth',
        oneLineSummary: 'Auth refresh logic lives in the auth context pipeline.',
        categories: ['auth'],
        priority: 'file-linked',
        linkedFileIds: ['file-auth'],
      }],
      unsummarizedCategories: [],
      relevantFindings: [],
      shouldRefreshSummaries: false,
      summaryRefreshReasons: [],
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toEqual(expect.objectContaining({ role: 'system' }));
    expect(String(result.messages[1].content)).toContain('<project_context_shortlist>');
    expect(String(result.messages[1].content)).toContain('summary-auth');
  });

  it('injects the past-knowledge block between the gatherer prompt and the shortlist when provided', () => {
    const result = buildGathererRequest(
      makeBody(),
      'deepseek-chat',
      {
        queryText: 'Inspect auth flow',
        referencedFiles: [],
        prioritySummaryIds: ['summary-auth'],
        summaryDescriptors: [],
        unsummarizedCategories: [],
        relevantFindings: [],
        shouldRefreshSummaries: false,
        summaryRefreshReasons: [],
      },
      null,
      undefined,
      '## Project Context\n- fact: Auth uses signed session tokens',
    );

    // Layout: [gatherer system, past knowledge, shortlist, user]
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].content).toBe(GATHERER_SYSTEM_PROMPT);
    expect(String(result.messages[1].content)).toContain('## Project Context');
    expect(String(result.messages[1].content)).toContain('Auth uses signed session tokens');
    expect(String(result.messages[2].content)).toContain('<project_context_shortlist>');
    expect(result.messages[3].role).toBe('user');
  });

  it('injects only the past-knowledge block when no selection context is provided', () => {
    const result = buildGathererRequest(
      makeBody(),
      'deepseek-chat',
      null,
      null,
      undefined,
      '## Project Context\n- fact: Auth uses signed session tokens',
    );

    // Layout: [gatherer system, past knowledge, user]
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toBe(GATHERER_SYSTEM_PROMPT);
    expect(String(result.messages[1].content)).toContain('## Project Context');
    expect(result.messages[2].role).toBe('user');
  });

  it('omits the past-knowledge system message when the block is empty or whitespace', () => {
    const empty = buildGathererRequest(makeBody(), 'deepseek-chat', null, null, undefined, '   \n  ');
    expect(empty.messages).toHaveLength(2); // gatherer + user
    expect(empty.messages[0].content).toBe(GATHERER_SYSTEM_PROMPT);
    expect(empty.messages[1].role).toBe('user');
  });
});

describe('buildGathererContextBlock', () => {
  it('wraps gatherer text with a preamble and trailing separator', () => {
    const block = buildGathererContextBlock('<gatherer_analysis>file contents here</gatherer_analysis>');

    expect(block).toContain('The following context was retrieved by an automated codebase scan to save you time on file lookups.');
    expect(block).toContain('apply your own reasoning');
    expect(block).toContain('<gatherer_analysis>file contents here</gatherer_analysis>');
    expect(block).toContain('---');
  });

  it('handles empty text gracefully', () => {
    const block = buildGathererContextBlock('');
    expect(block).toContain('The following context was retrieved by an automated codebase scan');
    expect(block).toContain('---');
  });

  it('does not re-wrap text inside another <gatherer_analysis>', () => {
    const inner = '<gatherer_analysis>analysis</gatherer_analysis>';
    const block = buildGathererContextBlock(inner);
    // Count occurrences — should be exactly one
    const matches = block.match(/<gatherer_analysis>/g);
    expect(matches).toHaveLength(1);
  });
});
