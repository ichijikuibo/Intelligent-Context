import type express from 'express';
import { t } from '../i18n';
import { logger } from './logger';
import { isAppError, serializeError } from './appErrors';

const WRAPPED_HANDLER = Symbol('wrappedAsyncHandler');

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function';
}

export function wrapAsyncHandler<T extends Function>(handler: T): T {
  if (typeof handler !== 'function') return handler;
  if ((handler as T & { [WRAPPED_HANDLER]?: boolean })[WRAPPED_HANDLER]) {
    return handler;
  }

  let wrapped: Function;
  if (handler.length === 4) {
    wrapped = function asyncErrorHandler(
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) {
      try {
        const result = (handler as unknown as express.ErrorRequestHandler)(err, req, res, next);
        if (isPromiseLike(result)) {
          return Promise.resolve(result).catch(next);
        }
        return result;
      } catch (caught) {
        next(caught);
        return undefined;
      }
    };
  } else {
    wrapped = function asyncRequestHandler(
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) {
      try {
        const result = (handler as unknown as express.RequestHandler)(req, res, next);
        if (isPromiseLike(result)) {
          return Promise.resolve(result).catch(next);
        }
        return result;
      } catch (caught) {
        next(caught);
        return undefined;
      }
    };
  }

  Object.defineProperty(wrapped, WRAPPED_HANDLER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return wrapped as T;
}

export function wrapAsyncHandlers(target: express.Application | express.Router): void {
  const visited = new Set<unknown>();

  const visit = (candidate: unknown): void => {
    if (!candidate || visited.has(candidate)) return;
    visited.add(candidate);

    const stack = Array.isArray((candidate as { stack?: unknown[] }).stack)
      ? (candidate as { stack: Array<{ handle?: unknown; route?: { stack?: Array<{ handle?: unknown }> } }> }).stack
      : Array.isArray((candidate as { _router?: { stack?: unknown[] } })._router?.stack)
        ? ((candidate as { _router: { stack: Array<{ handle?: unknown; route?: { stack?: Array<{ handle?: unknown }> } }> } })._router.stack)
        : undefined;

    if (!stack) return;

    for (const layer of stack) {
      if (layer.route?.stack) {
        for (const routeLayer of layer.route.stack) {
          if (routeLayer.handle) {
            visit(routeLayer.handle);
            if (typeof routeLayer.handle === 'function') {
              routeLayer.handle = wrapAsyncHandler(routeLayer.handle);
            }
          }
        }
      }

      if (layer.handle) {
        visit(layer.handle);
        if (typeof layer.handle === 'function') {
          layer.handle = wrapAsyncHandler(layer.handle);
        }
      }
    }
  };

  visit(target);
}
export function createJsonErrorHandler(
  scope: 'management' | 'proxy'
): express.ErrorRequestHandler {
  const fallbackKey = scope === 'proxy' ? 'api.error.proxyInternal' : 'api.error.managementInternal';
  const logMessage = scope === 'proxy' ? 'Unhandled proxy error' : 'Unhandled management API error';

  return (err, req, res, _next) => {
    const appError = isAppError(err) ? err : undefined;
    const statusCode = appError?.statusCode ?? 500;
    const publicMessage =
      statusCode >= 500
        ? t(req, fallbackKey)
        : appError?.messageKey
          ? t(req, appError.messageKey, appError.messageVars)
          : appError?.publicMessage ?? t(req, fallbackKey);

    logger.error(logMessage, {
      ...serializeError(err),
      statusCode,
      code: appError?.code,
      method: req.method,
      path: req.originalUrl,
      projectId: req.projectId,
    });

    if (res.headersSent) return;

    if (scope === 'proxy') {
      res.status(statusCode).json({
        error: {
          message: publicMessage,
          type: appError?.code ?? 'proxy_error',
        },
      });
      return;
    }

    res.status(statusCode).json({ error: publicMessage });
  };
}