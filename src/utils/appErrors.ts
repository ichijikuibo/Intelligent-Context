type MessageVars = Record<string, string | number | boolean | null | undefined>;

export interface AppErrorOptions {
  statusCode?: number;
  code?: string;
  publicMessage?: string;
  messageKey?: string;
  messageVars?: MessageVars;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  statusCode: number;
  code: string;
  publicMessage?: string;
  messageKey?: string;
  messageVars?: MessageVars;
  details?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'internal_error';
    this.publicMessage = options.publicMessage;
    this.messageKey = options.messageKey;
    this.messageVars = options.messageVars;
    this.details = options.details;

    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const maybeExtended = error as Error & {
      code?: unknown;
      statusCode?: unknown;
      details?: unknown;
      cause?: unknown;
    };

    return {
      errorName: error.name,
      error: error.message,
      stack: error.stack,
      errorCode: maybeExtended.code,
      errorStatusCode: maybeExtended.statusCode,
      errorDetails: maybeExtended.details,
      errorCause:
        maybeExtended.cause instanceof Error
          ? maybeExtended.cause.message
          : maybeExtended.cause,
    };
  }

  return { error: String(error) };
}