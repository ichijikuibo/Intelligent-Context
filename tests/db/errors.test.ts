import { describe, expect, it } from 'vitest';
import { isDuplicateKeyError } from '../../src/db/errors';

describe('isDuplicateKeyError', () => {
  it('detects SQLite unique-constraint failures', () => {
    expect(isDuplicateKeyError(new Error('UNIQUE constraint failed: projects.root_path'))).toBe(true);
  });

  it('detects PostgreSQL duplicate-key failures', () => {
    expect(
      isDuplicateKeyError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "projects_root_path_key"',
      })
    ).toBe(true);
  });
});