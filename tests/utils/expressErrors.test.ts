import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  t: vi.fn((_: unknown, key: string) => key),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

vi.mock('../../src/i18n', () => ({
  t: mocks.t,
}));

import { AppError } from '../../src/utils/appErrors';
import { createJsonErrorHandler, wrapAsyncHandler } from '../../src/utils/expressErrors';

describe('wrapAsyncHandler', () => {
  it('forwards rejected async handlers to next', async () => {
    const next = vi.fn();
    const handler = wrapAsyncHandler(async () => {
      throw new Error('boom');
    });

    await Promise.resolve(handler({} as any, {} as any, next));

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe('createJsonErrorHandler', () => {
  beforeEach(() => {
    mocks.logger.error.mockReset();
    mocks.t.mockClear();
  });

  it('returns the app-error message for conflicts', () => {
    const handler = createJsonErrorHandler('management');
    const req = { method: 'POST', originalUrl: '/api/projects' } as any;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    handler(
      new AppError('duplicate project', {
        statusCode: 409,
        code: 'project_conflict',
        messageKey: 'api.error.projectAlreadyExists',
      }),
      req,
      res,
      vi.fn()
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'api.error.projectAlreadyExists' });
    expect(mocks.t).toHaveBeenCalledWith(req, 'api.error.projectAlreadyExists', undefined);
  });

  it('returns a generic message for unexpected proxy errors', () => {
    const handler = createJsonErrorHandler('proxy');
    const req = { method: 'POST', originalUrl: '/v1/chat/completions' } as any;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;

    handler(new Error('boom'), req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: 'api.error.proxyInternal',
        type: 'proxy_error',
      },
    });
    expect(mocks.t).toHaveBeenCalledWith(req, 'api.error.proxyInternal');
  });
});