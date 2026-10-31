import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

export function loggingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const t0 = Date.now();
  const { method, path, headers } = req;

  res.on('finish', () => {
    logger.info('Proxy request', {
      method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - t0,
      projectId: req.projectId,
      model: (req.body as Record<string, unknown>)?.model,
      userAgent: headers['user-agent'],
    });
  });

  next();
}
