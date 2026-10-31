import express from 'express';
import cors from 'cors';
import { createProxyRouter } from './router';
import { localeMiddleware } from '../i18n';
import { logger } from '../utils/logger';
import { setLastActivity } from '../utils/processErrors';
import { createJsonErrorHandler, wrapAsyncHandlers } from '../utils/expressErrors';

export function createProxyApp(): express.Application {
  const app = express();

  // Parse JSON bodies (limit generous for large context windows)
  app.use(express.json({ limit: '16mb' }));

  // CORS — allow all origins for local development; restrict for server mode
  app.use(cors());
  app.use(localeMiddleware);

  // Track the most recent request so crash reports can say what was in flight
  app.use((req, _res, next) => {
    setLastActivity(`${req.method} ${req.originalUrl}`);
    next();
  });

  // Mount proxy router
  app.use('/', createProxyRouter());

  wrapAsyncHandlers(app);

  // Global error handler
  app.use(createJsonErrorHandler('proxy'));

  return app;
}

export function startProxyServer(host: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    const app = createProxyApp();
    app.listen(port, host, () => {
      logger.info('Proxy server started', { host, port, url: `http://${host}:${port}` });
      logger.info('Configure your IDE to use this endpoint:', {
        openai_base_url: `http://${host}:${port}/v1`,
        anthropic_base_url: `http://${host}:${port}`,
      });
      resolve();
    });
  });
}
