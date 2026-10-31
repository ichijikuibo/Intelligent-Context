import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  generateApiKey,
  hashApiKey,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from '../../src/auth/credentials';

describe('credentials', () => {
  it('hashes and verifies passwords', () => {
    const hashed = hashPassword('correct horse battery staple');

    expect(hashed).not.toBe('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hashed)).toBe(true);
    expect(verifyPassword('wrong password', hashed)).toBe(false);
  });

  it('generates opaque API keys and hashes them deterministically', () => {
    const apiKey = generateApiKey();
    const firstHash = hashApiKey(apiKey);
    const secondHash = hashApiKey(apiKey);

    expect(apiKey.startsWith('icu_')).toBe(true);
    expect(firstHash).toBe(secondHash);
    expect(firstHash).not.toBe(apiKey);
  });

  it('signs and verifies session tokens', () => {
    const token = createSessionToken(
      { userId: 'user-1', role: 'admin' },
      'test-secret',
      60_000,
    );

    const payload = verifySessionToken(token, 'test-secret');

    expect(payload).toMatchObject({ userId: 'user-1', role: 'admin' });
    expect(payload?.expiresAt).toBeGreaterThan(payload?.issuedAt ?? 0);
  });

  it('rejects tampered session tokens', () => {
    const token = createSessionToken({ userId: 'user-1', role: 'user' }, 'test-secret');
    const tampered = `${token}tampered`;

    expect(verifySessionToken(tampered, 'test-secret')).toBeNull();
  });
});