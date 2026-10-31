// Token estimation using a word-aware heuristic.
// Modern LLM tokenizers (cl100k_base, o200k_base) average ~4 chars/token
// for English prose but ~2.5-3 chars/token for code because short tokens
// like operators, brackets, and keywords each consume a full token.
//
// Our approach counts whitespace-delimited "words" and estimates:
//   - Alpha-numeric runs → subword splits at ~4 chars per token
//   - Adjacent punctuation/symbol runs → ~1 token per run
// This naturally penalises code-heavy content while staying accurate for prose.
// For higher accuracy in production, replace with tiktoken.

import { contentToText } from './messageContent';

export function estimateTokens(text: string): number {
  if (!text) return 0;

  let count = 0;

  for (const word of text.split(/\s+/)) {
    if (!word) continue;

    let alphaLen = 0;
    let symbolRuns = 0;
    let inSymbolRun = false;

    for (const ch of word) {
      if (/[a-zA-Z0-9]/.test(ch)) {
        alphaLen++;
        inSymbolRun = false;
      } else {
        if (!inSymbolRun) {
          symbolRuns++;
          inSymbolRun = true;
        }
      }
    }

    // Each ~4 alpha chars → 1 subword token; each symbol cluster → 1 token
    count += Math.max(1, Math.ceil(alphaLen / 4)) + symbolRuns;
  }

  return Math.max(1, count);
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string | unknown }>
): number {
  return messages.reduce((sum, msg) => {
    const content = contentToText(msg.content);
    return sum + estimateTokens(content) + 4; // ~4 token overhead per message
  }, 3); // 3 tokens for priming
}
