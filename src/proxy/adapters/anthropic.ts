import type { Adapter, ChatMessage, ChatToolCall, ProxyRequest, ProxyResponse } from './adapter';
import { contentToText } from '../../utils/messageContent';
import { normalizeImagePartsForAnthropic } from '../vision';

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicMessageContent = string | unknown[];

interface AnthropicRequestMessage {
  role: 'user' | 'assistant';
  content: AnthropicMessageContent;
}

interface AnthropicResponseContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

function mapFinishReason(reason: unknown): string {
  if (reason === 'max_tokens') {
    return 'length';
  }

  if (reason === 'end_turn' || reason === 'stop_sequence') {
    return 'stop';
  }

  if (reason === 'tool_use') {
    return 'tool_calls';
  }

  return typeof reason === 'string' ? reason : 'stop';
}

function toAnthropicContent(content: string | unknown): string | unknown[] {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    // OpenAI-shaped image blocks are converted so a protocol switch keeps the
    // image instead of forwarding a shape Anthropic rejects.
    return normalizeImagePartsForAnthropic(content) as unknown[];
  }

  return JSON.stringify(content);
}

function isOpenAiFunctionTool(tool: unknown): tool is {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
} {
  return !!tool && typeof tool === 'object' &&
    (tool as { type?: unknown }).type === 'function' &&
    typeof (tool as { function?: { name?: unknown } }).function?.name === 'string';
}

function normalizeAnthropicTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;

  return tools.map((tool) => {
    if (isOpenAiFunctionTool(tool)) {
      return {
        name: tool.function.name,
        description: tool.function.description ?? '',
        input_schema: tool.function.parameters ?? {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      };
    }

    return tool;
  });
}

function normalizeAnthropicToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null || toolChoice === 'none') {
    return undefined;
  }

  if (toolChoice === 'auto') {
    return { type: 'auto' };
  }

  if (toolChoice === 'required') {
    return { type: 'any' };
  }

  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    !Array.isArray(toolChoice) &&
    typeof (toolChoice as { type?: unknown }).type === 'string'
  ) {
    const candidate = toolChoice as {
      type?: string;
      name?: string;
      function?: { name?: string };
    };

    if (candidate.type === 'function' && typeof candidate.function?.name === 'string') {
      return { type: 'tool', name: candidate.function.name };
    }

    return toolChoice;
  }

  return toolChoice;
}

function contentToAnthropicTextBlocks(content: unknown): AnthropicTextBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }

  if (!Array.isArray(content)) {
    const asText = contentToText(content);
    return asText.length > 0 ? [{ type: 'text', text: asText }] : [];
  }

  return content.flatMap<AnthropicTextBlock>((item) => {
    if (typeof item === 'string' && item.length > 0) {
      return [{ type: 'text', text: item }];
    }

    if (
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
    ) {
      return [{ type: 'text', text: (item as { text: string }).text }];
    }

    return [];
  });
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}

function parseToolInput(rawArguments: unknown): Record<string, unknown> {
  if (rawArguments == null || rawArguments === '') {
    return {};
  }

  if (typeof rawArguments === 'string') {
    try {
      return normalizeToolInput(JSON.parse(rawArguments));
    } catch {
      return { _raw: rawArguments };
    }
  }

  return normalizeToolInput(rawArguments);
}

function buildAnthropicAssistantMessage(message: ChatMessage): AnthropicRequestMessage {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const contentBlocks: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [
    ...contentToAnthropicTextBlocks(message.content),
    ...toolCalls.flatMap<AnthropicToolUseBlock>((toolCall, index) => {
      const name = typeof toolCall.function?.name === 'string' ? toolCall.function.name : '';
      if (!name) return [];

      const id = typeof toolCall.id === 'string' && toolCall.id.length > 0
        ? toolCall.id
        : `tool_call_${index + 1}`;

      return [{
        type: 'tool_use',
        id,
        name,
        input: parseToolInput(toolCall.function?.arguments),
      }];
    }),
  ];

  return {
    role: 'assistant',
    content: contentBlocks,
  };
}

function buildAnthropicToolResultMessage(message: ChatMessage): AnthropicRequestMessage {
  const toolUseId = typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
    ? message.tool_call_id
    : '';

  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: contentToText(message.content),
    } satisfies AnthropicToolResultBlock],
  };
}

function toAnthropicMessage(message: ChatMessage): AnthropicRequestMessage {
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return buildAnthropicAssistantMessage(message);
  }

  if (message.role === 'tool') {
    return buildAnthropicToolResultMessage(message);
  }

  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: toAnthropicContent(message.content) as AnthropicMessageContent,
  };
}

function extractToolCalls(content: AnthropicResponseContentBlock[] | undefined): ChatToolCall[] {
  if (!Array.isArray(content)) return [];

  return content.flatMap<ChatToolCall>((block, index) => {
    if (block.type !== 'tool_use' || typeof block.name !== 'string') {
      return [];
    }

    const toolId = typeof block.id === 'string' && block.id.length > 0
      ? block.id
      : `tool_call_${index + 1}`;

    return [{
      id: toolId,
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(
          block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? block.input
            : {}
        ),
      },
    }];
  });
}

function extractText(content: AnthropicResponseContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return '';

  return content
    .filter(
      (block): block is AnthropicResponseContentBlock & { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('');
}

/** Anthropic Messages API adapter — converts OpenAI format ↔ Anthropic format */
export const anthropicAdapter: Adapter = {
  buildRequest(req: ProxyRequest): Record<string, unknown> {
    const systemMessages = req.messages.filter((m) => m.role === 'system');
    const otherMessages = req.messages.filter((m) => m.role !== 'system');

    const systemText = systemMessages
      .map((m) => contentToText(m.content))
      .filter((content) => content.length > 0)
      .join('\n\n');

    // Extract known passthrough fields so they survive the round-trip.
    // Anthropic accepts: tools, tool_choice, top_k, top_p, stop_sequences, metadata.
    const {
      messages: _messages,
      model: _model,
      system: _system,
      temperature: _temp,
      max_tokens: _maxTok,
      stream: _stream,
      tools,
      tool_choice,
      top_k,
      stop_sequences,
      metadata,
      ...rest
    } = req as ProxyRequest & {
      tools?: unknown;
      tool_choice?: unknown;
      top_k?: number;
      stop_sequences?: string[];
      metadata?: Record<string, unknown>;
    };

    return {
      model: req.model,
      max_tokens: req.max_tokens ?? 4096,
      ...(systemText && { system: systemText }),
      messages: otherMessages.map((m) => toAnthropicMessage(m)),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.stream && { stream: true }),
      // Forward Anthropic-specific parameters when present
      ...(tools !== undefined && { tools: normalizeAnthropicTools(tools) }),
      ...(normalizeAnthropicToolChoice(tool_choice) !== undefined && {
        tool_choice: normalizeAnthropicToolChoice(tool_choice),
      }),
      ...(top_k !== undefined && { top_k }),
      ...(stop_sequences !== undefined && { stop_sequences }),
      ...(metadata !== undefined && { metadata }),
      // Passthrough any other unknown fields
      ...rest,
    };
  },

  parseResponse(data: unknown): ProxyResponse {
    const d = data as {
      id: string;
      model: string;
      content: AnthropicResponseContentBlock[];
      stop_reason: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const text = extractText(d.content);
    const toolCalls = extractToolCalls(d.content);

    return {
      id: d.id,
      object: 'chat.completion',
      model: d.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: mapFinishReason(d.stop_reason),
        },
      ],
      usage: d.usage
        ? {
            prompt_tokens: d.usage.input_tokens,
            completion_tokens: d.usage.output_tokens,
            total_tokens: d.usage.input_tokens + d.usage.output_tokens,
          }
        : undefined,
    };
  },

  headers(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };
  },

  endpoint(baseUrl: string): string {
    //if it already ends in v1 skip adding v1 just add messages
    if (baseUrl.endsWith('/v1')) {
      return `${baseUrl.replace(/\/$/, '')}/messages`;
    }
    if (baseUrl.endsWith('/v1/')) {
      return `${baseUrl.replace(/\/$/, '')}messages`;
    }
    return `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  },
};
