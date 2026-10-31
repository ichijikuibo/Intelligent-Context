import axios from 'axios';
import type { ProxyRequest } from '../proxy/adapters/adapter';
import type { Adapter } from '../proxy/adapters/adapter';
import { logModelRequestFailure, readErrorResponseBody } from '../proxy/modelRequestDiagnostics';

export interface ParamFallbackContext {
  projectId?: string;
  model: string;
  providerName: string;
  providerType: string;
  url: string;
  requestHeaders: Record<string, string>;
  sessionId?: string;
  requestId?: string;
}

type FallbackParam = {
  key: string;
  aliases: string[];
  replacementKey?: string;
};

/**
 * Parameters that newer OpenAI reasoning models (o3, gpt-5, gpt-5.5, etc.)
 * are known to reject. We try sending the request normally first; if a 400
 * error mentions one of these, we strip it and retry.
 */
const FALLBACK_PARAMS: FallbackParam[] = [
  { key: 'temperature', aliases: ['temperature'] },
  {
    key: 'max_tokens',
    aliases: ['max_tokens', 'max completion tokens', 'max_completion_tokens'],
    replacementKey: 'max_completion_tokens',
  },
  { key: 'top_p', aliases: ['top_p', 'top p'] },
  { key: 'frequency_penalty', aliases: ['frequency_penalty', 'frequency penalty'] },
  { key: 'presence_penalty', aliases: ['presence_penalty', 'presence penalty'] },
  { key: 'stop', aliases: ['stop', 'stop_sequences', 'stop sequences'] },
  { key: 'seed', aliases: ['seed'] },
  { key: 'response_format', aliases: ['response_format', 'response format'] },
  { key: 'reasoning_effort', aliases: ['reasoning_effort', 'reasoning effort'] },
  { key: 'parallel_tool_calls', aliases: ['parallel_tool_calls', 'parallel tool calls'] },
  { key: 'tools', aliases: ['tools'] },
  { key: 'tool_choice', aliases: ['tool_choice', 'tool choice'] },
];

const UNSUPPORTED_PARAM_PATTERNS = [
  'not supported',
  'unsupported',
  'unknown parameter',
  'unknown field',
  'unrecognized parameter',
  'unrecognized field',
  'invalid parameter',
  'invalid field',
  'not allowed',
  'is not allowed',
  'not permitted',
  'is not permitted',
  'unexpected parameter',
  'unexpected field',
  'extra inputs are not permitted',
  'extra fields not permitted',
  'additional properties are not allowed',
  'does not support',
  'cannot be set',
  'must not be provided',
  'should not be provided',
  'is not available',
  'is not accepted',
  'unsupported value',
];

const BASE_RETRY_DELAY_MS = 250;

function hasUnsupportedSignal(errorBody: string): boolean {
  return UNSUPPORTED_PARAM_PATTERNS.some((pattern) => errorBody.includes(pattern));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeRequestParam(request: ProxyRequest, key: string): void {
  Reflect.deleteProperty(request, key);
}

function applyParamFallback(request: ProxyRequest, param: FallbackParam): void {
  if (param.key === 'max_tokens' && param.replacementKey) {
    const currentValue = request.max_tokens;
    if (typeof currentValue === 'number' && request[param.replacementKey] === undefined) {
      request[param.replacementKey] = currentValue;
    }
  }

  removeRequestParam(request, param.key);
}

/**
 * Determine which (if any) of the fallback params is causing a 400 error,
 * based on the error body text.
 */
function detectUnsupportedParam(errorBody: string): FallbackParam | null {
  const lower = errorBody.toLowerCase();
  if (!hasUnsupportedSignal(lower)) {
    return null;
  }

  for (const param of FALLBACK_PARAMS) {
    if (param.aliases.some((alias) => lower.includes(alias))) {
      return param;
    }
  }

  return null;
}

/**
 * Call an upstream API with automatic parameter-stripping retry on 400.
 *
 * If the first call fails with 400 and the error body indicates an
 * unsupported parameter (temperature, max_tokens), we strip that parameter
 * and retry. This repeats up to 5 times so multiple unsupported parameters
 * (e.g. temperature + max_tokens) are stripped one at a time.
 *
 * @returns The final result and the last parameter that was stripped (or null
 *          if no retry was needed).
 */
export async function withParamFallback<T>(
  request: ProxyRequest,
  adapter: Adapter,
  ctx: ParamFallbackContext,
  makeCall: (payload: Record<string, unknown>) => Promise<T>,
): Promise<{ result: T; paramStripped: string | null }> {
  const maxAttempts = 5;
  let lastParamStripped: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const payload = adapter.buildRequest(request);

    try {
      const result = await makeCall(payload);
      return { result, paramStripped: lastParamStripped };
    } catch (err) {
      const statusCode = axios.isAxiosError(err) ? (err.response?.status ?? null) : null;
      const errorBody = axios.isAxiosError(err)
        ? await readErrorResponseBody(err)
        : '';

      if (statusCode === 400) {
        const param = detectUnsupportedParam(errorBody);

        if (param) {
          lastParamStripped = param.key;
          await logModelRequestFailure({
            err,
            url: ctx.url,
            requestHeaders: ctx.requestHeaders,
            requestBody: payload,
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            requestId: ctx.requestId,
            model: ctx.model,
            providerName: ctx.providerName,
            providerType: ctx.providerType,
            logMessage: 'Upstream rejected model request; retrying without unsupported parameter',
            logLevel: 'warn',
            extra: {
              attempt: attempt + 1,
              parameter: param.key,
              replacementParameter: param.replacementKey,
            },
            persist: false,
            capturedResponseBody: errorBody,
          });

          // Strip the offending parameter from the original request so that
          // callers that reuse the same request later don't hit the same 400.
          // For max_tokens, preserve the numeric budget by copying it to
          // max_completion_tokens when that field is not already set.
          applyParamFallback(request, param);

          if (attempt < maxAttempts - 1) {
            await sleep(BASE_RETRY_DELAY_MS * (attempt + 1));
          }
          continue;
        }
      }

      await logModelRequestFailure({
        err,
        url: ctx.url,
        requestHeaders: ctx.requestHeaders,
        requestBody: payload,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
        model: ctx.model,
        providerName: ctx.providerName,
        providerType: ctx.providerType,
        logMessage: 'Upstream model request failed',
        capturedResponseBody: errorBody || undefined,
      });

      throw err;
    }
  }

  throw new Error(`withParamFallback exhausted ${maxAttempts} attempts`);
}
