import type { ChatMessage } from './adapters/adapter';

export function isToolContinuation(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'system') continue;
    if (isEmptyContent(message.content)) continue;

    if (message.role === 'tool') return true;
    if (message.role === 'user') return isPureToolBlockMessage(message.content, 'tool_result');
    if (message.role === 'assistant') {
      return isPureToolBlockMessage(message.content, 'tool_use');
    }

    return false;
  }

  return false;
}

function isPureToolBlockMessage(content: unknown, toolBlockType: 'tool_result' | 'tool_use'): boolean {
  if (!Array.isArray(content)) return false;

  let hasToolBlock = false;
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim().length === 0) continue;
      return false;
    }

    if (typeof block !== 'object' || block === null) return false;

    const type = (block as Record<string, unknown>).type;
    if (type === toolBlockType) {
      hasToolBlock = true;
      continue;
    }

    if (type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim().length === 0) continue;
    }

    return false;
  }

  return hasToolBlock;
}

function isEmptyContent(content: unknown): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim().length === 0;
  if (!Array.isArray(content)) return false;

  return content.every((block) => {
    if (typeof block === 'string') return block.trim().length === 0;
    if (typeof block !== 'object' || block === null) return false;
    if ((block as Record<string, unknown>).type !== 'text') return false;

    const text = (block as Record<string, unknown>).text;
    return typeof text === 'string' && text.trim().length === 0;
  });
}