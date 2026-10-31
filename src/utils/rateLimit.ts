import type { Request, Response, NextFunction } from 'express';

interface BucketEntry {
  timestamps: number[];
}

const buckets = new Map<string, BucketEntry>();

// Periodically clean up stale entries
const CLEANUP_INTERVAL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets.entries()) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < CLEANUP_INTERVAL);
    if (entry.timestamps.length === 0) {
      buckets.delete(key);
    }
  }
}, CLEANUP_INTERVAL).unref();

export function createRateLimiter(maxAttempts: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = buckets.get(key) ?? { timestamps: [] };

    // Prune expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxAttempts) {
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }

    entry.timestamps.push(now);
    buckets.set(key, entry);
    next();
  };
}
