import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../../config/config';

/**
 * Fallback when the configured value is missing or invalid. Deliberately
 * generous: a single agentic chat turn issues many requests (tool
 * continuations, re-prompts) on top of extension model-catalog polling, so a
 * low limit produces spurious 429s.
 */
const FALLBACK_REQUESTS_PER_MINUTE = 600;
const REFILL_WINDOW_MS = 60_000;

interface BucketState {
  tokens: number;
  lastRefillAt: number;
}

const buckets = new Map<string, BucketState>();

/**
 * Requests allowed per minute for a single key (user, API key or IP).
 *
 * Tune via `proxy.rateLimitPerMinute` in `intelligent-context.yaml` or the
 * `IC_RATE_LIMIT_PER_MINUTE` environment variable. The value is read per
 * request so changes take effect without a restart of the bucket state.
 */
function requestsPerMinute(): number {
  const configured = getConfig().proxy.rateLimitPerMinute;
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : FALLBACK_REQUESTS_PER_MINUTE;
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const limit = requestsPerMinute();
  const key = req.userId || req.headers.authorization || (req.headers['x-api-key'] as string | undefined) || req.ip || 'anonymous';
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: limit, lastRefillAt: now };

  refillBucket(bucket, now, limit);
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    res.status(429).json({
      error: {
        message: `Rate limit exceeded (${limit} requests/min). Try again in a moment.`,
        type: 'rate_limit',
      },
    });
    return;
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  next();
}

function refillBucket(bucket: BucketState, now: number, limit: number): void {
  const elapsed = now - bucket.lastRefillAt;
  if (elapsed <= 0) return;

  const replenished = (elapsed / REFILL_WINDOW_MS) * limit;
  bucket.tokens = Math.min(limit, bucket.tokens + replenished);
  bucket.lastRefillAt = now;
}