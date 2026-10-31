import type { ExternalProviderDef } from './types';

/**
 * DeepSeek — https://api.deepseek.com/v1
 *
 * Single OpenAI-compatible provider. All models returned by /models are
 * routed to a single internal provider with prefix DSK.
 */
export const deepseekDef: ExternalProviderDef = {
  key: 'deepseek',
  displayName: 'DeepSeek',
  displayNameKey: 'externalProvider.deepseek.displayName',
  descriptionKey: 'externalProvider.deepseek.description',
  baseUrl: 'https://api.deepseek.com/v1',
  modelsPath: '/models',

  subProviders: [
    {
      type: 'openai',
      prefix: 'DSK',
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
