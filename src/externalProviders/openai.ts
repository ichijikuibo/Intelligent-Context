import type { ExternalProviderDef } from './types';

/**
 * OpenAI direct — https://api.openai.com/v1
 *
 * Single OpenAI-compatible provider. All models returned by /models are
 * routed to a single internal provider with prefix OAI.
 */
export const openaiDef: ExternalProviderDef = {
  key: 'openai',
  displayName: 'OpenAI',
  displayNameKey: 'externalProvider.openai.displayName',
  descriptionKey: 'externalProvider.openai.description',
  baseUrl: 'https://api.openai.com/v1',
  modelsPath: '/models',

  subProviders: [
    {
      type: 'openai',
      prefix: 'OAI',
      nameSuffix: '',
    },
  ],

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  },

  classifyModel(_modelId: string): number {
    return 0;
  },
};
