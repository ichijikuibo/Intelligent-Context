import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicUser } from '../../src/db/repositories/users';

const helpers = vi.hoisted(() => ({
  buildStoredUser: (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'stored-password-hash',
    role: 'power_user',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: false,
    accessAllModels: false,
    allowedModels: '["gpt-4.1-mini"]',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  }),
  buildPublicUser: (overrides: Partial<PublicUser> = {}): PublicUser => ({
    id: 'user-1',
    email: 'user@example.com',
    role: 'power_user',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: false,
    accessAllModels: false,
    allowedModels: ['gpt-4.1-mini'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: null,
    ...overrides,
  }),
}));

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  extractBearerToken: vi.fn((header?: string) => {
    if (!header || !header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length);
  }),
  hashApiKey: vi.fn((token: string) => `hash:${token}`),
  getSessionSecret: vi.fn().mockReturnValue('proxy-secret'),
  verifySessionToken: vi.fn(),
  usersRepo: {
    findById: vi.fn(),
    toPublicUser: vi.fn(),
    resolveByApiKeyHash: vi.fn(),
    touchApiKeyLastUsed: vi.fn(),
  },
}));

vi.mock('../../src/config/config', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/auth/credentials', () => ({
  extractBearerToken: mocks.extractBearerToken,
  getSessionSecret: mocks.getSessionSecret,
  hashApiKey: mocks.hashApiKey,
  verifySessionToken: mocks.verifySessionToken,
}));

vi.mock('../../src/db/repositories/users', () => ({
  usersRepo: mocks.usersRepo,
}));

import {
  SESSION_COOKIE_NAME,
  attachAuthContext,
  clearSessionCookieHeader,
  createSessionCookieHeader,
  hasModelAccess,
  hasUnrestrictedModelAccess,
  modelGrantMatches,
  normalizeModelGrants,
  requireAuthenticated,
  requireRole,
  resolveAuthenticatedUser,
} from '../../src/auth/context';

function makeReq(headers: Record<string, string | undefined> = {}) {
  return { headers } as any;
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
}

describe('auth context', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getConfig.mockReturnValue({
      proxy: { apiKey: 'proxy-secret' },
    });
    mocks.hashApiKey.mockImplementation((token: string) => `hash:${token}`);
    mocks.verifySessionToken.mockReturnValue(null);
    mocks.usersRepo.findById.mockResolvedValue(undefined);
    mocks.usersRepo.toPublicUser.mockImplementation((user: any) =>
      helpers.buildPublicUser({
        id: user.id,
        email: user.email,
        role: user.role,
        isApproved: !!user.isApproved,
        isDisabled: !!user.isDisabled,
        accessAllProjects: !!user.accessAllProjects,
        accessAllModels: !!user.accessAllModels,
        allowedModels: user.allowedModels ? JSON.parse(user.allowedModels) : [],
      })
    );
    mocks.usersRepo.resolveByApiKeyHash.mockResolvedValue(null);
    mocks.usersRepo.touchApiKeyLastUsed.mockResolvedValue(undefined);
  });

  it('resolves authenticated users from the signed session cookie', async () => {
    const storedUser = helpers.buildStoredUser({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'admin',
      accessAllProjects: true,
      accessAllModels: true,
      allowedModels: '[]',
    });
    const publicUser = helpers.buildPublicUser({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'admin',
      accessAllProjects: true,
      accessAllModels: true,
      allowedModels: [],
    });
    mocks.verifySessionToken.mockReturnValue({ userId: 'admin-1', role: 'admin' });
    mocks.usersRepo.findById.mockResolvedValue(storedUser);
    mocks.usersRepo.toPublicUser.mockReturnValue(publicUser);

    const result = await resolveAuthenticatedUser(
      makeReq({ cookie: `${SESSION_COOKIE_NAME}=session%20token; theme=dark` })
    );

    expect(result).toEqual({ user: publicUser, kind: 'session' });
    expect(mocks.verifySessionToken).toHaveBeenCalledWith('session token', 'proxy-secret');
  });

  it('ignores session cookies when allowSessionCookie is disabled', async () => {
    mocks.verifySessionToken.mockReturnValue({ userId: 'user-1', role: 'power_user' });

    const result = await resolveAuthenticatedUser(
      makeReq({ cookie: `${SESSION_COOKIE_NAME}=session-token` }),
      { allowSessionCookie: false }
    );

    expect(result).toBeNull();
    expect(mocks.verifySessionToken).not.toHaveBeenCalled();
  });

  it('falls back to API key authentication when the header token is not a valid session', async () => {
    const storedUser = helpers.buildStoredUser();
    const publicUser = helpers.buildPublicUser();
    mocks.usersRepo.resolveByApiKeyHash.mockResolvedValue({
      user: storedUser,
      apiKey: { id: 'key-1' },
    });
    mocks.usersRepo.toPublicUser.mockReturnValue(publicUser);

    const result = await resolveAuthenticatedUser(makeReq({ 'x-api-key': 'plain-api-key' }));

    expect(mocks.hashApiKey).toHaveBeenCalledWith('plain-api-key');
    expect(mocks.usersRepo.touchApiKeyLastUsed).toHaveBeenCalledWith('key-1');
    expect(result).toEqual({ user: publicUser, kind: 'api_key' });
  });

  it('returns the legacy admin when the configured proxy key is explicitly allowed', async () => {
    const result = await resolveAuthenticatedUser(
      makeReq({ authorization: 'Bearer proxy-secret' }),
      { allowLegacyProxyKey: true }
    );

    expect(result).toEqual({
      user: expect.objectContaining({
        id: 'legacy-admin',
        role: 'admin',
        accessAllProjects: true,
        accessAllModels: true,
      }),
      kind: 'legacy_proxy_key',
    });
  });

  it('allows legacy unscoped model permissions to match scoped model ids', () => {
    const user = helpers.buildPublicUser({
      allowedModels: ['gpt-4.1-mini'],
    });

    expect(hasModelAccess(user, 'OAI-gpt-4.1-mini')).toBe(true);
  });

  it('requires matching provider scope when a permission entry is provider-scoped', () => {
    const user = helpers.buildPublicUser({
      allowedModels: ['OAI-gpt-4.1-mini'],
    });

    expect(hasModelAccess(user, 'OAI-gpt-4.1-mini')).toBe(true);
    expect(hasModelAccess(user, 'ANTH-gpt-4.1-mini')).toBe(false);
    expect(hasModelAccess(user, 'gpt-4.1-mini')).toBe(false);
  });

  it('rejects session tokens for users that are disabled or awaiting approval', async () => {
    mocks.verifySessionToken.mockReturnValue({ userId: 'user-1', role: 'power_user' });
    mocks.usersRepo.findById.mockResolvedValue(
      helpers.buildStoredUser({ isApproved: false, isDisabled: true })
    );

    const result = await resolveAuthenticatedUser(makeReq({ authorization: 'Bearer signed-token' }));

    expect(result).toBeNull();
    expect(mocks.usersRepo.toPublicUser).not.toHaveBeenCalled();
  });

  it('clears stale auth context when no authentication can be resolved', async () => {
    const req = {
      headers: {},
      user: helpers.buildPublicUser(),
      userId: 'stale-user',
      userRole: 'admin',
      authKind: 'session',
    } as any;

    const result = await attachAuthContext(req);

    expect(result).toBeNull();
    expect(req.user).toBeUndefined();
    expect(req.userId).toBeUndefined();
    expect(req.userRole).toBeUndefined();
    expect(req.authKind).toBeUndefined();
  });

  it('requireAuthenticated returns 401 when no user can be resolved', async () => {
    const middleware = requireAuthenticated();
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('requireAuthenticated attaches the resolved user and continues', async () => {
    const storedUser = helpers.buildStoredUser();
    const publicUser = helpers.buildPublicUser();
    mocks.usersRepo.resolveByApiKeyHash.mockResolvedValue({
      user: storedUser,
      apiKey: { id: 'key-1' },
    });
    mocks.usersRepo.toPublicUser.mockReturnValue(publicUser);

    const middleware = requireAuthenticated();
    const req = makeReq({ 'x-api-key': 'plain-api-key' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(publicUser);
    expect(req.userId).toBe('user-1');
    expect(req.userRole).toBe('power_user');
    expect(req.authKind).toBe('api_key');
  });

  it('requireRole rejects callers below the required role', () => {
    const middleware = requireRole('admin');
    const req = { userRole: 'power_user' } as any;
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'You do not have access to this action.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('requireRole allows callers that meet the minimum role', () => {
    const middleware = requireRole('power_user');
    const req = { userRole: 'admin' } as any;
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('checks model access using admin, access-all, and explicit allow lists', () => {
    const scopedUser = helpers.buildPublicUser({
      role: 'user',
      accessAllModels: false,
      allowedModels: ['gpt-4.1-mini'],
    });
    const adminUser = helpers.buildPublicUser({
      role: 'admin',
      accessAllModels: false,
      allowedModels: [],
    });

    expect(hasModelAccess(scopedUser, 'gpt-4.1-mini')).toBe(true);
    expect(hasModelAccess(scopedUser, 'gpt-4.1')).toBe(false);
    expect(hasModelAccess(scopedUser, '')).toBe(true);
    expect(hasModelAccess(adminUser, 'any-model')).toBe(true);
  });

  it('grants access through provider, model and global wildcards', () => {
    const providerGrant = helpers.buildPublicUser({ role: 'user', allowedModels: ['OCA-*'] });
    const modelWildcard = helpers.buildPublicUser({ role: 'user', allowedModels: ['*-deepseek-v4'] });
    const prefixWildcard = helpers.buildPublicUser({ role: 'user', allowedModels: ['OCA-deepseek-*'] });
    const everything = helpers.buildPublicUser({ role: 'user', allowedModels: ['*-*'] });

    // Whole provider.
    expect(hasModelAccess(providerGrant, 'OCA-deepseek-v4')).toBe(true);
    expect(hasModelAccess(providerGrant, 'OCO-deepseek-v4')).toBe(false);
    // A bare model name still resolves once the caller's provider is known.
    expect(hasModelAccess(providerGrant, 'deepseek-v4')).toBe(false);

    // Same model on any provider.
    expect(hasModelAccess(modelWildcard, 'OCA-deepseek-v4')).toBe(true);
    expect(hasModelAccess(modelWildcard, 'DSK-deepseek-v4')).toBe(true);
    expect(hasModelAccess(modelWildcard, 'OCA-deepseek-v4-pro')).toBe(false);

    // Prefix within one provider.
    expect(hasModelAccess(prefixWildcard, 'OCA-deepseek-v4')).toBe(true);
    expect(hasModelAccess(prefixWildcard, 'OCA-glm-5')).toBe(false);

    // Everything.
    expect(hasModelAccess(everything, 'anything-at-all')).toBe(true);
    expect(hasModelAccess(everything, 'OCO-glm-5')).toBe(true);
  });

  it('matches wildcard grants case-insensitively and leaves plain grants strict', () => {
    expect(modelGrantMatches('oca-*', 'OCA-deepseek-v4')).toBe(true);
    expect(modelGrantMatches('*-*', 'literally-anything')).toBe(true);
    expect(modelGrantMatches('*', 'anything')).toBe(true);
    // No wildcard → exact match only, never a prefix match.
    expect(modelGrantMatches('OCA-deepseek-v4', 'OCA-deepseek-v4')).toBe(true);
    expect(modelGrantMatches('OCA-deepseek-v4', 'OCA-deepseek-v4-pro')).toBe(false);
    expect(modelGrantMatches('', 'OCA-deepseek-v4')).toBe(false);
  });

  it('normalises grants by trimming, de-duplicating and dropping covered entries', () => {
    expect(normalizeModelGrants([' OCA-deepseek-v4 ', 'oca-deepseek-v4', '', '  ']))
      .toEqual(['OCA-deepseek-v4']);

    // A broader grant makes the narrower ones redundant.
    expect(normalizeModelGrants(['OCA-*', 'OCA-deepseek-v4', 'OCA-glm-5']))
      .toEqual(['OCA-*']);
    expect(normalizeModelGrants(['*-*', 'OCA-*', 'OCA-deepseek-v4']))
      .toEqual(['*-*']);

    // Unrelated grants are all kept.
    expect(normalizeModelGrants(['OCA-*', 'DSK-glm-5']))
      .toEqual(['OCA-*', 'DSK-glm-5']);

    // Non-strings are ignored rather than crashing the route.
    expect(normalizeModelGrants([1, null, 'OCA-*'] as unknown[])).toEqual(['OCA-*']);
  });

  it('reports unrestricted access for admins regardless of their grant list', () => {
    expect(hasUnrestrictedModelAccess(helpers.buildPublicUser({ role: 'admin', accessAllModels: false }))).toBe(true);
    expect(hasUnrestrictedModelAccess(helpers.buildPublicUser({ role: 'user', accessAllModels: true }))).toBe(true);
    expect(hasUnrestrictedModelAccess(helpers.buildPublicUser({ role: 'user', accessAllModels: false }))).toBe(false);
  });

  it('formats the session cookie helpers consistently', () => {    expect(createSessionCookieHeader('token value')).toBe(
      `${SESSION_COOKIE_NAME}=token%20value; Path=/; HttpOnly; Secure; SameSite=Lax`
    );
    expect(clearSessionCookieHeader()).toBe(
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    );
  });
});