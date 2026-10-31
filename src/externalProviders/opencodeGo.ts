import type { ExternalProviderDef } from './types';

/**
 * opencode Go — https://opencode.ai/zen/go
 *
 * Provides both OpenAI-compatible and Anthropic-compatible models through
 * a single API key. Models are classified by prefix:
 *   - Qwen / MiniMax models → Anthropic-compatible
 *   - Everything else (DeepSeek, Kimi, GLM, Mimo, HY) → OpenAI-compatible
 */
export const opencodeGoDef: ExternalProviderDef = {
  key: 'opencode-go',
  displayName: 'opencode Go',
  displayNameKey: 'externalProvider.opencode-go.displayName',
  descriptionKey: 'externalProvider.opencode-go.description',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  modelsPath: '/models',

  subProviders: [
    {
      type: 'openai',
      prefix: 'OCO',
      nameSuffix: ' (OpenAI)',
    },
    {
      type: 'anthropic',
      prefix: 'OCA',
      nameSuffix: ' (Anthropic)',
    },
  ],

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  },

  classifyModel(modelId: string): number {
    const lower = modelId.toLowerCase();
    // Qwen and MiniMax models are Anthropic-compatible
    if (lower.startsWith('qwen') || lower.startsWith('minimax')) {
      return 1; // Anthropic sub-provider
    }
    // Everything else (deepseek, kimi, glm, mimo, hy) → OpenAI-compatible
    return 0; // OpenAI sub-provider
  },
};
