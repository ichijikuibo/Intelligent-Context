import { db, selectAll } from '../db/connection';
import { systemConfig } from '../db/schema';

const cache = new Map<string, string>();
let primed = false;
let priming: Promise<void> | null = null;

export async function primeSystemConfigCache(): Promise<void> {
  if (primed) return;
  if (priming) return priming;

  priming = (async () => {
    try {
      const rows = await selectAll<{ key: string; value: string }>(
        db().select().from(systemConfig)
      );
      cache.clear();
      for (const row of rows) {
        cache.set(row.key, row.value ?? '');
      }
      primed = true;
    } catch {
      // DB not ready yet or table missing during very early startup.
      // Callers will fall back to YAML/base config defaults.
    } finally {
      priming = null;
    }
  })();

  return priming;
}

export function getSystemConfigCacheValue(key: string): string {
  return cache.get(key) ?? '';
}

export function setSystemConfigCacheValue(key: string, value: string): void {
  cache.set(key, value);
}

export function resetSystemConfigCache(): void {
  cache.clear();
  primed = false;
  priming = null;
}
