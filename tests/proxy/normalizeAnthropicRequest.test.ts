import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  normalizeRequestForClientProtocol: vi.fn(),
}));

vi.mock('../../src/proxy/clientProtocols', () => ({
  normalizeRequestForClientProtocol: mocks.normalizeRequestForClientProtocol,
}));

import { normalizeAnthropicRequestMiddleware } from '../../src/proxy/middleware/normalizeAnthropicRequest';

describe('normalizeAnthropicRequestMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes the request body for the anthropic protocol and calls next', () => {
    const req = { body: { model: 'claude', messages: [] }, headers: {} } as any;
    const next = vi.fn();
    const normalized = { model: 'claude', messages: [{ role: 'system', content: 'sys' }] };
    mocks.normalizeRequestForClientProtocol.mockReturnValue(normalized);

    normalizeAnthropicRequestMiddleware(req, {} as any, next);

    expect(mocks.normalizeRequestForClientProtocol).toHaveBeenCalledWith({ model: 'claude', messages: [] }, 'anthropic');
    expect(req.body).toBe(normalized);
    expect(next).toHaveBeenCalledTimes(1);
  });
});