import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../src/utils/appErrors';
import { createMockDbHarness, createSchemaTables } from './helpers/mockDb';

type UsersRepoModule = typeof import('../../src/db/repositories/users');

describe('usersRepo', () => {
  const schemaTables = createSchemaTables();

  let dbHarness = createMockDbHarness();
  let selectAll = vi.fn();
  let selectOne = vi.fn();
  let execute = vi.fn();
  let markDirty = vi.fn();
  let usersModule: UsersRepoModule;

  async function loadModule() {
    vi.resetModules();

    dbHarness = createMockDbHarness();
    selectAll = vi.fn();
    selectOne = vi.fn();
    execute = vi.fn();
    markDirty = vi.fn();

    const uuids = ['user-uuid', 'api-key-uuid'];

    vi.doMock('drizzle-orm', () => ({
      eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
      and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
      isNull: (value: unknown) => ({ op: 'isNull', value }),
    }));

    vi.doMock('uuid', () => ({
      v4: vi.fn(() => uuids.shift() ?? 'extra-uuid'),
    }));

    vi.doMock('../../src/db/connection', () => ({
      db: () => dbHarness.api,
      selectAll,
      selectOne,
      execute,
      markDirty,
    }));

    vi.doMock('../../src/db/schema', async () => {
      const actual = await vi.importActual<typeof import('../../src/db/schema')>('../../src/db/schema');
      return {
        ...actual,
        getSchema: () => schemaTables,
      };
    });

    usersModule = await import('../../src/db/repositories/users');
  }

  beforeEach(async () => {
    await loadModule();
  });

  it('normalizes email and applies admin defaults when creating users', async () => {
    selectOne.mockResolvedValueOnce({
      id: 'user-uuid',
      email: 'admin@example.com',
      passwordHash: 'hash',
      role: 'admin',
      isApproved: false,
      isDisabled: false,
      accessAllProjects: true,
      accessAllModels: true,
      allowedModels: '[]',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
    });

    const created = await usersModule.usersRepo.create({
      email: ' Admin@Example.com ',
      passwordHash: 'hash',
      role: 'admin',
    });

    const insertRecord = dbHarness.lastRecord('insert');

    expect(created.email).toBe('admin@example.com');
    expect(insertRecord?.values).toEqual(
      expect.objectContaining({
        id: 'user-uuid',
        email: 'admin@example.com',
        passwordHash: 'hash',
        role: 'admin',
        isApproved: false,
        isDisabled: false,
        accessAllProjects: true,
        accessAllModels: true,
        allowedModels: '[]',
      })
    );
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('normalizes email lookups before querying the database', async () => {
    selectOne.mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.com' });

    await usersModule.usersRepo.findByEmail(' Admin@Example.com ');

    const selectRecord = dbHarness.lastRecord('select');

    expect(selectRecord?.where).toMatchObject({
      op: 'eq',
      right: 'admin@example.com',
    });
  });

  it('stringifies allowed models when updating a user', async () => {
    selectOne.mockResolvedValueOnce({
      id: 'user-1',
      email: 'user@example.com',
      allowedModels: '["gpt-4.1-mini"]',
    });

    await usersModule.usersRepo.update('user-1', {
      isApproved: true,
      allowedModels: ['gpt-4.1-mini'],
    });

    const updateRecord = dbHarness.lastRecord('update');

    expect(updateRecord?.set).toEqual({
      isApproved: true,
      allowedModels: '["gpt-4.1-mini"]',
    });
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate-email failures to a user conflict error', async () => {
    execute.mockRejectedValueOnce({
      code: '23505',
      message: 'duplicate key value violates unique constraint "users_email_key"',
    });

    const error = await usersModule.usersRepo
      .create({
        email: 'admin@example.com',
        passwordHash: 'hash',
        role: 'admin',
      })
      .catch((caught) => caught as AppError);

    expect(error.code).toBe('user_conflict');
    expect(error.statusCode).toBe(409);
    expect(error.publicMessage).toContain('admin@example.com');
  });

  it('returns null from api-key resolution when the matched user is disabled', async () => {
    const findKeySpy = vi
      .spyOn(usersModule.usersRepo, 'findActiveApiKeyByHash')
      .mockResolvedValue({ id: 'key-1', userId: 'user-1' } as any);
    const findUserSpy = vi
      .spyOn(usersModule.usersRepo, 'findById')
      .mockResolvedValue({ id: 'user-1', isApproved: true, isDisabled: true } as any);

    const result = await usersModule.usersRepo.resolveByApiKeyHash('key-hash');

    expect(result).toBeNull();

    findKeySpy.mockRestore();
    findUserSpy.mockRestore();
  });

  it('parses allowed models and converts date fields when shaping a public user', () => {
    const publicUser = usersModule.usersRepo.toPublicUser({
      id: 'user-1',
      email: 'user@example.com',
      role: 'power_user',
      isApproved: 1,
      isDisabled: 0,
      accessAllProjects: 0,
      accessAllModels: 1,
      allowedModels: '["gpt-4.1-mini",123]',
      hiddenModels: '["OCA-glm-5"]',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-02T00:00:00.000Z',
    } as any);

    expect(publicUser).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      role: 'power_user',
      isApproved: true,
      isDisabled: false,
      accessAllProjects: false,
      accessAllModels: true,
      allowedModels: ['gpt-4.1-mini'],
      hiddenModels: ['OCA-glm-5'],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: new Date('2026-01-02T00:00:00.000Z'),
    });
  });

  it('reads a missing hidden-models column as an empty preference list', () => {
    // Rows written before the column existed must not break the shape.
    const publicUser = usersModule.usersRepo.toPublicUser({
      id: 'user-2',
      email: 'legacy@example.com',
      role: 'user',
      isApproved: 1,
      isDisabled: 0,
      accessAllProjects: 0,
      accessAllModels: 0,
      allowedModels: '[]',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
    } as any);

    expect(publicUser.hiddenModels).toEqual([]);
  });
});