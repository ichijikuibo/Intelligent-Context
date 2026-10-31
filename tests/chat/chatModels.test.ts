import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicUser } from '../../src/db/repositories/users';

const mocks = vi.hoisted(() => ({
  providersRepo: {
    findAll: vi.fn(),
  },
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

import { buildChatModelOptions, canUseChatModel } from '../../src/chat/chatModels';

function makeUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    role: 'user',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: false,
    accessAllModels: false,
    allowedModels: [],
    hiddenModels: [],
    createdAt: new Date(0),
    lastLoginAt: null,
    ...overrides,
  };
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'key',
    models: 'gpt-4.1,gpt-4o-mini',
    isEnabled: true,
    isDefault: false,
    shortPrefix: 'OAI',
    externalProviderId: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

describe('chatModels.buildChatModelOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providersRepo.findAll.mockResolvedValue([makeProvider()]);
  });

  it('returns every enabled provider model for an unrestricted user', async () => {
    const options = await buildChatModelOptions(makeUser({ accessAllModels: true }));

    expect(options.map((option) => option.value)).toEqual(['OAI-gpt-4.1', 'OAI-gpt-4o-mini']);
    expect(options[0].label).toContain('OpenAI');
  });

  it('returns everything for an admin', async () => {
    const options = await buildChatModelOptions(makeUser({ role: 'admin' }));
    expect(options).toHaveLength(2);
  });

  it('only returns granted models for a restricted user', async () => {
    const options = await buildChatModelOptions(makeUser({ allowedModels: ['OAI-gpt-4.1'] }));

    expect(options.map((option) => option.value)).toEqual(['OAI-gpt-4.1']);
  });

  it('supports wildcard grants', async () => {
    const options = await buildChatModelOptions(makeUser({ allowedModels: ['OAI-*'] }));
    expect(options).toHaveLength(2);
  });

  it('returns nothing when the user has no grants', async () => {
    const options = await buildChatModelOptions(makeUser());
    expect(options).toEqual([]);
  });

  it('ignores disabled providers', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([makeProvider({ isEnabled: false })]);
    const options = await buildChatModelOptions(makeUser({ accessAllModels: true }));
    expect(options).toEqual([]);
  });
});

describe('chatModels.canUseChatModel', () => {
  it('allows any model for an unrestricted user', () => {
    expect(canUseChatModel(makeUser({ accessAllModels: true }), 'OAI-gpt-4.1')).toBe(true);
  });

  it('allows a granted model and rejects an ungranted one', () => {
    const user = makeUser({ allowedModels: ['OAI-gpt-4.1'] });
    expect(canUseChatModel(user, 'OAI-gpt-4.1')).toBe(true);
    expect(canUseChatModel(user, 'OAI-gpt-4o-mini')).toBe(false);
  });

  it('rejects an empty selection for a restricted user', () => {
    expect(canUseChatModel(makeUser(), '')).toBe(false);
  });
});
