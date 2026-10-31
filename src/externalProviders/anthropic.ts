import type { ExternalProviderDef } from './types';

/**
 * Anthropic direct — https://api.anthropic.com/v1
 *
 * Single Anthropic-compatible provider. All models returned by /models are
 * routed to a single internal provider with prefix ANTH.
 */
export const anthropicDef: ExternalProviderDef = {
  key: 'anthropic',
  displayName: 'Anthropic',
  displayNameKey: 'externalProvider.anthropic.displayName',
  descriptionKey: 'externalProvider.anthropic.description',
  baseUrl: 'https://api.anthropic.com',
  modelsPath: '/v1/models',

  subProviders: [
    {
      type: 'anthropic',
      prefix: 'ANTH',
      nameSuffix: '',
    },
  ],

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  },

  classifyModel(_modelId: string): number {
    return 0;
  },
};
