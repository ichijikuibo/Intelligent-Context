import { contentToText } from '../../utils/messageContent';
import { normalizeImagePartsForOpenAi } from '../vision';
import type { Adapter, ChatMessage, ChatToolCall, ProxyRequest, ProxyResponse } from './adapter';

interface TextBlockLike {
  type?: unknown;
  text?: unknown;
}

interface AnthropicToolUseBlockLike {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface AnthropicToolResultBlockLike {
  type?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

interface AnthropicToolDefinitionLike {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
}

interface AnthropicToolChoiceLike {
  type?: unknown;
  name?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTextBlock(value: unknown): value is TextBlockLike & { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isAnthropicToolUseBlock(value: unknown): value is AnthropicToolUseBlockLike & { type: 'tool_use'; name: string } {
  return isRecord(value) && value.type === 'tool_use' && typeof value.name === 'string';
}

function isAnthropicToolResultBlock(
  value: unknown
): value is AnthropicToolResultBlockLike & { type: 'tool_result'; tool_use_id: string } {
  return isRecord(value) && value.type === 'tool_result' && typeof value.tool_use_id === 'string';
}

function hasAnthropicToolUseBlocks(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isAnthropicToolUseBlock(block));
}

function hasAnthropicToolResultBlocks(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isAnthropicToolResultBlock(block));
}

function isTextOnlyArray(content: unknown): content is Array<string | TextBlockLike> {
  return Array.isArray(content) && content.every((block) => typeof block === 'string' || isTextBlock(block));
}

function stringifyToolArguments(input: unknown): string {
  try {
    if (input == null) {
      return '{}';
    }
    if (typeof input === 'object' && !Array.isArray(input)) {
      return JSON.stringify(input);
    }
    return JSON.stringify({ value: input });
  } catch {
    return '{}';
  }
}

function extractToolCalls(content: unknown): ChatToolCall[] {
  if (!Array.isArray(content)) return [];

  return content.flatMap<ChatToolCall>((block, index) => {
    if (!isAnthropicToolUseBlock(block)) {
      return [];
    }

    const id = typeof block.id === 'string' && block.id.length > 0
      ? block.id
      : `tool_call_${index + 1}`;

    return [{
      id,
      type: 'function',
      function: {
        name: block.name,
        arguments: stringifyToolArguments(block.input),
      },
    }];
  });
}

function normalizeBasicContent(content: unknown): unknown {
  // Anthropic-shaped image blocks are converted first so a protocol switch
  // keeps the image instead of forwarding a shape OpenAI rejects.
  const normalized = normalizeImagePartsForOpenAi(content);
  if (isTextOnlyArray(normalized)) {
    return contentToText(normalized);
  }

  return normalized;
}

function normalizeAssistantMessage(message: ChatMessage): ChatMessage {
  const extractedToolCalls = extractToolCalls(message.content);
  const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    ? message.tool_calls
    : extractedToolCalls;

  return {
    ...message,
    content: contentToText(message.content),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function normalizeUserMessages(message: ChatMessage): ChatMessage[] {
  if (!Array.isArray(message.content) || !hasAnthropicToolResultBlocks(message.content)) {
    return [{
      ...message,
      content: normalizeBasicContent(message.content),
    }];
  }

  const normalized: ChatMessage[] = [];
  let pendingBlocks: unknown[] = [];

  const flushPendingUserText = () => {
    const text = contentToText(pendingBlocks).trim();
    pendingBlocks = [];

    if (!text) return;

    normalized.push({
      role: 'user',
      content: text,
      ...(message.name ? { name: message.name } : {}),
    });
  };

  for (const block of message.content) {
    if (isAnthropicToolResultBlock(block)) {
      flushPendingUserText();
      normalized.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: contentToText(block.content),
      });
      continue;
    }

    pendingBlocks.push(block);
  }

  flushPendingUserText();

  return normalized.length > 0
    ? normalized
    : [{ role: 'user', content: contentToText(message.content) }];
}

function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role === 'assistant' && hasAnthropicToolUseBlocks(message.content)) {
      return [normalizeAssistantMessage(message)];
    }

    if (message.role === 'user') {
      return normalizeUserMessages(message);
    }

    if (message.role === 'tool') {
      return [{
        ...message,
        content: contentToText(message.content),
      }];
    }

    return [{
      ...message,
      content: normalizeBasicContent(message.content),
    }];
  });
}

function normalizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;

  return tools.map((tool) => {
    if (
      isRecord(tool) &&
      tool.type === 'function' &&
      isRecord(tool.function) &&
      typeof tool.function.name === 'string'
    ) {
      return tool;
    }

    const candidate = tool as AnthropicToolDefinitionLike;
    if (typeof candidate.name === 'string') {
      return {
        type: 'function',
        function: {
          name: candidate.name,
          ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
          parameters: isRecord(candidate.input_schema) ? candidate.input_schema : { type: 'object', properties: {} },
        },
      };
    }

    return tool;
  });
}

function normalizeToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null || typeof toolChoice === 'string') {
    return toolChoice;
  }

  if (!isRecord(toolChoice)) {
    return toolChoice;
  }

  if (toolChoice.type === 'function') {
    return toolChoice;
  }

  const candidate = toolChoice as AnthropicToolChoiceLike;
  if (candidate.type === 'auto') {
    return 'auto';
  }
  if (candidate.type === 'any') {
    return 'required';
  }
  if (candidate.type === 'tool' && typeof candidate.name === 'string') {
    return {
      type: 'function',
      function: {
        name: candidate.name,
      },
    };
  }

  return toolChoice;
}

/**
 * Strip keys whose value is null or undefined.
 * OpenAI-compatible APIs reject null for fields like max_tokens,
 * temperature, top_p, etc. — they want the key omitted entirely.
 *
 * Note: The ProxyRequest type declares max_tokens as `number | undefined`,
 * but at runtime the IDE can send `max_tokens: null` through the JSON
 * body.  The spread operator in buildGathererRequest (and other callers)
 * copies it verbatim, so we must sanitize here at the adapter boundary
 * where we know the provider type.
 */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value != null) {
      result[key] = value;
    }
  }
  return result;
}

/** Pass-through adapter — OpenAI API format on both sides */
export const openaiAdapter: Adapter = {
  buildRequest(req: ProxyRequest): Record<string, unknown> {
    const {
      messages,
      tools,
      tool_choice,
      ...rest
    } = req as ProxyRequest & {
      tools?: unknown;
      tool_choice?: unknown;
    };

    return stripNulls({
      ...rest,
      messages: normalizeMessages(messages),
      ...(tools !== undefined ? { tools: normalizeTools(tools) } : {}),
      ...(tool_choice !== undefined ? { tool_choice: normalizeToolChoice(tool_choice) } : {}),
    });
  },

  parseResponse(data: unknown): ProxyResponse {
    return data as ProxyResponse;
  },

  headers(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  },

  endpoint(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  },
};
