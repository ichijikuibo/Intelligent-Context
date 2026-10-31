import type { ChatMessage, ProxyRequest } from './adapters/adapter';

export type ClientProtocol = 'openai' | 'anthropic';

interface AnthropicRequestMessage {
  role?: unknown;
  content?: unknown;
}

interface AnthropicResponseContentBlock {
  type?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

export interface AnthropicResponseBody {
  content?: AnthropicResponseContentBlock[];
  [key: string]: unknown;
}

export function normalizeRequestForClientProtocol(
  body: unknown,
  clientProtocol: ClientProtocol
): ProxyRequest {
  if (clientProtocol === 'openai') {
    return body as ProxyRequest;
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const { system: rawSystem, ...rest } = raw;
  const rawMessages = Array.isArray(raw.messages)
    ? (raw.messages as AnthropicRequestMessage[])
    : [];
  const messages: ChatMessage[] = [];

  if (rawSystem !== undefined) {
    messages.push({ role: 'system', content: rawSystem });
  }

  for (const message of rawMessages) {
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content ?? '',
    });
  }

  return {
    ...rest,
    model: typeof raw.model === 'string' ? raw.model : '',
    messages,
  };
}

export function extractAnthropicResponseText(data: unknown): string {
  const response = data as AnthropicResponseBody;
  if (!Array.isArray(response.content)) {
    return '';
  }

  return response.content
    .filter(
      (block): block is AnthropicResponseContentBlock & { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('');
}

export function replaceAnthropicResponseText(
  data: unknown,
  cleanedText: string
): AnthropicResponseBody {
  const response = data as AnthropicResponseBody;
  const existingContent = Array.isArray(response.content) ? response.content : [];
  const nextContent: AnthropicResponseContentBlock[] = [];
  let textInserted = false;

  for (const block of existingContent) {
    if (block.type === 'text') {
      if (!textInserted && cleanedText.length > 0) {
        nextContent.push({
          ...block,
          text: cleanedText,
        });
        textInserted = true;
      }
      continue;
    }

    nextContent.push(block);
  }

  if (!textInserted && cleanedText.length > 0) {
    nextContent.unshift({ type: 'text', text: cleanedText });
  }

  return {
    ...response,
    content: nextContent,
  };
}