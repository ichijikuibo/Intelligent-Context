import axios from 'axios';
import zlib from 'node:zlib';
import { proxyErrorsRepo } from '../db/repositories/proxyErrors';
import { logger } from '../utils/logger';
import { formatUpstreamErrorMessage } from './errorMessage';

const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie'];
const MAX_LOG_VALUE_LENGTH = 4_000;

function normalizeHeaderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ');
  }

  if (value === undefined || value === null) {
    return '';
  }

  return String(value);
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADERS.includes(key.toLowerCase())
      ? '[REDACTED]'
      : normalizeHeaderValue(value);
  }

  return redacted;
}

export async function readErrorResponseBody(err: unknown): Promise<string> {
  if (!axios.isAxiosError(err) || !err.response) return '';

  const data = err.response.data;

  if (data !== null && typeof data === 'object' && typeof (data as { pipe?: unknown }).pipe === 'function') {
    try {
      const chunks: Buffer[] = [];
      const stream = data as NodeJS.ReadableStream;
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const raw = Buffer.concat(chunks);
      try {
        return zlib.gunzipSync(raw).toString('utf-8');
      } catch {
        return raw.toString('utf-8');
      }
    } catch {
      return '[error response stream could not be read]';
    }
  }

  if (Buffer.isBuffer(data)) {
    try {
      return zlib.gunzipSync(data).toString('utf-8');
    } catch {
      return data.toString('utf-8');
    }
  }

  if (typeof data === 'string') return data;

  if (data !== undefined && data !== null) {
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }

  return '';
}

function safeReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${value.length} bytes]`;
  }

  return value;
}

export function safeStringifyBody(value: unknown): string {
  try {
    return JSON.stringify(value, safeReplacer);
  } catch {
    return String(value);
  }
}

function truncateForLog(value: string): string {
  if (value.length <= MAX_LOG_VALUE_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_LOG_VALUE_LENGTH)}...[truncated]`;
}

export interface LogModelRequestFailureParams {
  err: unknown;
  url: string;
  requestHeaders?: Record<string, unknown>;
  requestBody: unknown;
  projectId?: string;
  sessionId?: string;
  requestId?: string;
  model: string;
  providerName: string;
  providerType: string;
  logMessage: string;
  logLevel?: 'warn' | 'error';
  extra?: Record<string, unknown>;
  persist?: boolean;
  capturedResponseBody?: string;
}

export async function logModelRequestFailure(
  params: LogModelRequestFailureParams,
): Promise<{ message: string; statusCode: number | null }> {
  const requestHeaders = redactHeaders(params.requestHeaders ?? {});
  const requestBody = safeStringifyBody(params.requestBody);

  let statusCode: number | null = null;
  let errorType: 'http_error' | 'exception' = 'exception';
  let responseHeaders: Record<string, unknown> = {};
  let responseBody = params.capturedResponseBody ?? '';
  let errorMessage = String(params.err);

  if (axios.isAxiosError(params.err)) {
    errorMessage = formatUpstreamErrorMessage(params.err);
    statusCode = params.err.response?.status ?? null;
    errorType = statusCode != null ? 'http_error' : 'exception';

    if (params.err.response) {
      responseHeaders = redactHeaders((params.err.response.headers as Record<string, unknown>) ?? {});
      if (params.capturedResponseBody === undefined) {
        responseBody = await readErrorResponseBody(params.err);
      }
    }
  }

  if (params.persist !== false) {
    proxyErrorsRepo.insert({
      projectId: params.projectId ?? null,
      sessionId: params.sessionId,
      requestId: params.requestId,
      model: params.model,
      providerName: params.providerName,
      providerType: params.providerType,
      url: params.url,
      statusCode,
      errorMessage,
      errorType,
      requestHeaders,
      requestBody,
      responseHeaders,
      responseBody,
    }).catch((insertErr) => {
      logger.warn('Failed to log proxy error', { error: String(insertErr) });
    });
  }

  const log = params.logLevel === 'warn' ? logger.warn : logger.error;
  log(params.logMessage, {
    ...params.extra,
    url: params.url,
    model: params.model,
    providerName: params.providerName,
    providerType: params.providerType,
    statusCode,
    errorType,
    upstreamMessage: errorMessage,
    responseHeaders,
    responseBody: truncateForLog(responseBody),
    requestBody: truncateForLog(requestBody),
  });

  return {
    message: errorMessage,
    statusCode,
  };
}