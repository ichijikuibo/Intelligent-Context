import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RateLimitModule = typeof import('../../src/proxy/middleware/rateLimit');

/** Small burst so the tests stay fast regardless of the shipped default. */
const TEST_LIMIT = 5;

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    ip: '127.0.0.1',
    ...overrides,
  } as any;
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
}

describe('rateLimitMiddleware', () => {
  let rateLimitModule: RateLimitModule;

  async function loadModule() {
    vi.resetModules();
    rateLimitModule = await import('../../src/proxy/middleware/rateLimit');
    return rateLimitModule;
  }

  beforeEach(() => {
    process.env.IC_RATE_LIMIT_PER_MINUTE = String(TEST_LIMIT);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    delete process.env.IC_RATE_LIMIT_PER_MINUTE;
    vi.useRealTimers();
  });

  it('allows up to the configured burst and rejects the next request', async () => {
    const { rateLimitMiddleware } = await loadModule();

    for (let index = 0; index < TEST_LIMIT; index += 1) {
      const res = makeRes();
      const next = vi.fn();
      rateLimitMiddleware(makeReq({ userId: 'user-1' }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }

    const res = makeRes();
    const next = vi.fn();
    rateLimitMiddleware(makeReq({ userId: 'user-1' }), res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: `Rate limit exceeded (${TEST_LIMIT} requests/min). Try again in a moment.`,
        type: 'rate_limit',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('refills the bucket after enough time has elapsed', async () => {
    const { rateLimitMiddleware } = await loadModule();

    for (let index = 0; index < TEST_LIMIT; index += 1) {
      rateLimitMiddleware(makeReq({ headers: { authorization: 'Bearer token' } }), makeRes(), vi.fn());
    }

    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));

    const res = makeRes();
    const next = vi.fn();
    rateLimitMiddleware(makeReq({ headers: { authorization: 'Bearer token' } }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});