import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attachAuthContext: vi.fn(),
  getConfig: vi.fn(),
  usersRepo: {
    count: vi.fn(),
  },
  t: vi.fn((_: unknown, key: string) => key),
}));

vi.mock('../../src/auth/context', () => ({
  attachAuthContext: mocks.attachAuthContext,
}));

vi.mock('../../src/config/config', () => ({
  getConfig: mocks.getConfig,
}));

vi.mock('../../src/db/repositories/users', () => ({
  usersRepo: mocks.usersRepo,
}));

vi.mock('../../src/i18n', () => ({
  t: mocks.t,
}));

import { authMiddleware } from '../../src/proxy/middleware/auth';

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ proxy: { apiKey: 'proxy-secret' } });
    mocks.usersRepo.count.mockResolvedValue(1);
    mocks.attachAuthContext.mockResolvedValue(null);
  });

  it('allows the request through when attachAuthContext resolves a user', async () => {
    const next = vi.fn();
    mocks.attachAuthContext.mockResolvedValue({ id: 'user-1' });

    await authMiddleware({ headers: {} } as any, makeRes(), next);

    expect(mocks.attachAuthContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowLegacyProxyKey: true, allowSessionCookie: true })
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns a translated missing-header error when no credentials are provided', async () => {
    const res = makeRes();

    await authMiddleware({ headers: {} } as any, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'api.error.missingAuthorizationHeader', type: 'auth_error' },
    });
  });

  it('returns a translated invalid-key error when credentials are present but invalid', async () => {
    const res = makeRes();

    await authMiddleware({ headers: { authorization: 'Bearer bad-token' } } as any, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'api.error.invalidApiKey', type: 'auth_error' },
    });
  });
});