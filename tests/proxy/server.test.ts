import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

type ServerModule = typeof import('../../src/proxy/server');

describe('proxy/server', () => {
  let localeMiddleware = vi.fn();
  let wrapAsyncHandlers = vi.fn();
  let createJsonErrorHandler = vi.fn();
  let logger: Record<string, ReturnType<typeof vi.fn>>;
  let serverModule: ServerModule;

  async function loadModule() {
    vi.resetModules();

    localeMiddleware = vi.fn((_req: any, _res: any, next: () => void) => next());
    wrapAsyncHandlers = vi.fn();
    createJsonErrorHandler = vi.fn(() => (_err: unknown, _req: unknown, res: any, _next: unknown) => {
      res.status(500).json({ error: 'proxy' });
    });
    logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    vi.doMock('../../src/proxy/router', async () => {
      const express = await vi.importActual<typeof import('express')>('express');
      return {
        createProxyRouter: () => {
          const router = express.default.Router();
          router.get('/server-probe', (_req, res) => {
            res.json({ ok: true });
          });
          return router;
        },
      };
    });

    vi.doMock('../../src/i18n', () => ({
      localeMiddleware,
    }));

    vi.doMock('../../src/utils/logger', () => ({
      logger,
    }));

    vi.doMock('../../src/utils/expressErrors', () => ({
      createJsonErrorHandler,
      wrapAsyncHandlers,
    }));

    serverModule = await import('../../src/proxy/server');
    return serverModule;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the proxy app with the router, locale middleware, and proxy error handler wired in', async () => {
    const module = await loadModule();
    const app = module.createProxyApp();

    await withTestServer(app, async ({ request }) => {
      const response = await request('/server-probe');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    expect(localeMiddleware).toHaveBeenCalledTimes(1);
    expect(wrapAsyncHandlers).toHaveBeenCalledTimes(1);
    expect(createJsonErrorHandler).toHaveBeenCalledWith('proxy');
  });

  it('starts the proxy server on the requested host and port and logs the public endpoints', async () => {
    const module = await loadModule();
    const express = await import('express');
    const listenSpy = vi
      .spyOn((express.default as any).application, 'listen')
      .mockImplementation(function mockListen(_port: number, _host: string, callback?: () => void) {
        callback?.();
        return { close() {} } as any;
      });

    await module.startProxyServer('127.0.0.1', 1234);

    expect(listenSpy).toHaveBeenCalledWith(1234, '127.0.0.1', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith('Proxy server started', {
      host: '127.0.0.1',
      port: 1234,
      url: 'http://127.0.0.1:1234',
    });
    expect(logger.info).toHaveBeenCalledWith('Configure your IDE to use this endpoint:', {
      openai_base_url: 'http://127.0.0.1:1234/v1',
      anthropic_base_url: 'http://127.0.0.1:1234',
    });

    listenSpy.mockRestore();
  });
});