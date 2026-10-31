import type { NextFunction, Request, Response } from 'express';
import { normalizeRequestForClientProtocol } from '../clientProtocols';
import { logger } from '../../utils/logger';

export function normalizeAnthropicRequestMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const originalKeys = typeof req.body === 'object' && req.body !== null ? Object.keys(req.body as object) : [];
  const originalModel = (req.body as Record<string, unknown> | undefined)?.model;
  req.body = normalizeRequestForClientProtocol(req.body, 'anthropic');
  const body = req.body as Record<string, unknown> | undefined;
  logger.info('Request body normalized from Anthropic to internal format', {
    projectId: req.projectId,
    sessionId: req.headers['x-session-id'] ?? req.headers['x-interaction-id'],
    requestId: req.headers['x-ic-request-id'],
    originalModel,
    originalBodyKeys: originalKeys,
    messageCount: Array.isArray(body?.messages) ? (body?.messages as unknown[]).length : 0,
    model: body?.model,
  });
  next();
}