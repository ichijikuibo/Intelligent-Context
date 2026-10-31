interface TextContentBlock {
  type?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
  return typeof value === 'object' && value !== null;
}

export function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content as string;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (isTextContentBlock(item) && item.type === 'text' && typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .filter((item) => item.length > 0)
      .join('\n');
  }

  if (content == null) {
    return '';
  }

  return JSON.stringify(content);
}

export function appendTextToContent(content: unknown, appendedText: string): string | unknown {
  if (typeof content === 'string') {
    return `${content}\n\n${appendedText}`;
  }

  if (Array.isArray(content)) {
    const next = [...content];
    const lastIndex = next.length - 1;
    const last = lastIndex >= 0 ? next[lastIndex] : undefined;

    if (isTextContentBlock(last) && last.type === 'text' && typeof last.text === 'string') {
      next[lastIndex] = {
        ...last,
        text: `${last.text}\n\n${appendedText}`,
      };
    } else {
      next.push({ type: 'text', text: appendedText });
    }

    return next;
  }

  const existing = contentToText(content);
  return existing.length > 0 ? `${existing}\n\n${appendedText}` : appendedText;
}

export function prependTextToContent(content: unknown, prependedText: string): string | unknown {
  if (typeof content === 'string') {
    return `${prependedText}\n\n${content}`;
  }

  if (Array.isArray(content)) {
    return [{ type: 'text', text: prependedText }, ...content];
  }

  const existing = contentToText(content);
  return existing.length > 0 ? `${prependedText}\n\n${existing}` : prependedText;
}

/**
 * Strip every occurrence of `needle` from a content payload (string or
 * content-block array). Used to remove a previously-injected instruction
 * before re-injecting it elsewhere. Empty text blocks produced by the
 * removal are dropped from array content.
 */
export function stripTextFromContent(content: unknown, needle: string): unknown {
  if (!needle) return content;

  if (typeof content === 'string') {
    return content.split(needle).join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          const stripped = item.split(needle).join('').replace(/\n{3,}/g, '\n\n').trim();
          return stripped;
        }
        if (
          typeof item === 'object' &&
          item !== null &&
          (item as TextContentBlock).type === 'text' &&
          typeof (item as TextContentBlock).text === 'string'
        ) {
          const text = (item as TextContentBlock).text as string;
          const stripped = text.split(needle).join('').replace(/\n{3,}/g, '\n\n').trim();
          if (!stripped) return null;
          return { ...(item as TextContentBlock), text: stripped };
        }
        return item;
      })
      .filter((item): item is string | TextContentBlock => item !== null && item !== '');
  }

  return content;
}