import type {
  ExternalModelListEntry,
  ExternalProviderDef,
  NormalizedExternalModel,
} from './types';
import { classifyByEndpoint, contextLengthFromEntry } from './types';

/**
 * CommandCode — https://api.commandcode.ai/provider/v1
 *
 * A single gateway that serves both OpenAI- and Anthropic-compatible models
 * through one API key. The `/models` catalog follows the newer provider
 * convention: every entry carries richer metadata than the bare OpenAI triple,
 * so we classify by the endpoints the model advertises rather than by name.
 *
 *   GET /provider/v1/models
 *   {
 *     "object": "list",
 *     "data": [{
 *       "id": "claude-sonnet-5",
 *       "object": "model",
 *       "created": 1790451354,
 *       "owned_by": "command-code",
 *       "name": "Claude Sonnet 5",
 *       "context_length": 1000000,
 *       "supported_endpoints": ["/messages"]
 *     }, ...]
 *   }
 *
 * Classification:
 *   - `/messages`                          → Anthropic sub-provider (CCA)
 *   - `/chat/completions` or `/responses`  → OpenAI sub-provider (CCO)
 */
export const commandCodeDef: ExternalProviderDef = {
  key: 'command-code',
  displayName: 'CommandCode',
  displayNameKey: 'externalProvider.command-code.displayName',
  descriptionKey: 'externalProvider.command-code.description',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  modelsPath: '/models',

  subProviders: [
    {
      type: 'openai',
      prefix: 'CCO',
      nameSuffix: ' (OpenAI)',
    },
    {
      type: 'anthropic',
      prefix: 'CCA',
      nameSuffix: ' (Anthropic)',
    },
  ],

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  },

  classifyModel(modelId: string, entry?: ExternalModelListEntry): number {
    // Prefer the endpoint metadata the provider advertises.
    if (entry) {
      const byEndpoint = classifyByEndpoint(entry);
      if (byEndpoint === 'anthropic') return 1;
      if (byEndpoint === 'openai') return 0;
    }

    // Fall back to ID heuristics for entries without endpoint metadata.
    return isAnthropicModelId(modelId) ? 1 : 0;
  },

  normalizeModel(entry: ExternalModelListEntry): NormalizedExternalModel | null {
    const id = (entry.id ?? '').trim();
    if (!id) return null;

    const contextLength = contextLengthFromEntry(entry);
    const byEndpoint = classifyByEndpoint(entry);

    return {
      id,
      bucketIndex: byEndpoint === 'anthropic' ? 1 : byEndpoint === 'openai' ? 0 : -1,
      metadata: {
        contextLength,
        displayName: entry.name?.trim() || undefined,
        apiFormat: byEndpoint,
      },
    };
  },
};

/** Claude- and Anthropic-branded models speak the Messages API. */
function isAnthropicModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('claude') || lower.includes('anthropic');
}
