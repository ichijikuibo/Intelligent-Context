import { and, eq, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, execute, markDirty, selectAll, selectOne } from '../connection';
import {
  getSchema,
  parseAllowedModels,
  type NewUser,
  type NewUserApiKey,
  type User,
  type UserApiKey,
} from '../schema';
import { createUserConflictError, isDuplicateKeyError } from '../errors';

function tables() {
  return getSchema();
}

/**
 * Visibility preferences share the grant syntax, so they are parsed the same
 * way; a pre-migration row without the column simply reads as empty.
 */
function parseHiddenModels(user: { hiddenModels?: string | null }): string[] {
  return parseAllowedModels({ allowedModels: user.hiddenModels ?? '[]' });
}

export type UserRole = 'admin' | 'power_user' | 'user';

export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  isApproved: boolean;
  isDisabled: boolean;
  accessAllProjects: boolean;
  accessAllModels: boolean;
  allowedModels: string[];
  /** Scoped model IDs the user chose to hide from their IDE picker. */
  hiddenModels: string[];
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface CreateUserData {
  email: string;
  passwordHash: string;
  role: UserRole;
  isApproved?: boolean;
  isDisabled?: boolean;
  accessAllProjects?: boolean;
  accessAllModels?: boolean;
  allowedModels?: string[];
  hiddenModels?: string[];
}

export interface UpdateUserData {
  passwordHash?: string;
  role?: UserRole;
  isApproved?: boolean;
  isDisabled?: boolean;
  accessAllProjects?: boolean;
  accessAllModels?: boolean;
  allowedModels?: string[];
  hiddenModels?: string[];
}

export interface CreateUserApiKeyData {
  userId: string;
  keyHash: string;
  name: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const usersRepo = {
  async count(): Promise<number> {
    const { users } = tables();
    return (await selectAll(db().select().from(users))).length;
  },

  async findAll(): Promise<User[]> {
    const { users } = tables();
    return selectAll(db().select().from(users));
  },

  async findById(id: string): Promise<User | undefined> {
    const { users } = tables();
    return selectOne(db().select().from(users).where(eq(users.id, id)));
  },

  async findByEmail(email: string): Promise<User | undefined> {
    const { users } = tables();
    return selectOne(db().select().from(users).where(eq(users.email, normalizeEmail(email))));
  },

  async create(data: CreateUserData): Promise<User> {
    const { users } = tables();
    const now = new Date();
    const row: NewUser = {
      id: uuidv4(),
      email: normalizeEmail(data.email),
      passwordHash: data.passwordHash,
      role: data.role,
      isApproved: data.isApproved ?? false,
      isDisabled: data.isDisabled ?? false,
      accessAllProjects: data.accessAllProjects ?? data.role === 'admin',
      accessAllModels: data.accessAllModels ?? data.role === 'admin',
      allowedModels: JSON.stringify(data.allowedModels ?? []),
      hiddenModels: JSON.stringify(data.hiddenModels ?? []),
      createdAt: now,
      lastLoginAt: null,
    };

    try {
      await execute(db().insert(users).values(row));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw createUserConflictError(row.email, error);
      }
      throw error;
    }

    markDirty();
    return (await this.findById(row.id))!;
  },

  async update(id: string, data: UpdateUserData): Promise<User | undefined> {
    const { users } = tables();
    const updates: Partial<NewUser> = {};

    if (data.passwordHash !== undefined) updates.passwordHash = data.passwordHash;
    if (data.role !== undefined) updates.role = data.role;
    if (data.isApproved !== undefined) updates.isApproved = data.isApproved;
    if (data.isDisabled !== undefined) updates.isDisabled = data.isDisabled;
    if (data.accessAllProjects !== undefined) updates.accessAllProjects = data.accessAllProjects;
    if (data.accessAllModels !== undefined) updates.accessAllModels = data.accessAllModels;
    if (data.allowedModels !== undefined) updates.allowedModels = JSON.stringify(data.allowedModels);
    if (data.hiddenModels !== undefined) updates.hiddenModels = JSON.stringify(data.hiddenModels);

    await execute(db().update(users).set(updates).where(eq(users.id, id)));
    markDirty();
    return this.findById(id);
  },

  async touchLastLogin(id: string): Promise<void> {
    const { users } = tables();
    await execute(db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id)));
    markDirty();
  },

  async createApiKey(data: CreateUserApiKeyData): Promise<UserApiKey> {
    const { userApiKeys } = tables();
    const row: NewUserApiKey = {
      id: uuidv4(),
      userId: data.userId,
      keyHash: data.keyHash,
      name: data.name,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };

    await execute(db().insert(userApiKeys).values(row));
    markDirty();
    return (await this.findApiKeyById(row.id))!;
  },

  async listApiKeys(userId: string): Promise<UserApiKey[]> {
    const { userApiKeys } = tables();
    return selectAll(db().select().from(userApiKeys).where(eq(userApiKeys.userId, userId)));
  },

  async findApiKeyById(id: string): Promise<UserApiKey | undefined> {
    const { userApiKeys } = tables();
    return selectOne(db().select().from(userApiKeys).where(eq(userApiKeys.id, id)));
  },

  async findActiveApiKeyByHash(keyHash: string): Promise<UserApiKey | undefined> {
    const { userApiKeys } = tables();
    return selectOne(
      db()
        .select()
        .from(userApiKeys)
        .where(and(eq(userApiKeys.keyHash, keyHash), isNull(userApiKeys.revokedAt)))
    );
  },

  async touchApiKeyLastUsed(id: string): Promise<void> {
    const { userApiKeys } = tables();
    await execute(db().update(userApiKeys).set({ lastUsedAt: new Date() }).where(eq(userApiKeys.id, id)));
    markDirty();
  },

  async revokeApiKey(id: string): Promise<void> {
    const { userApiKeys } = tables();
    await execute(db().update(userApiKeys).set({ revokedAt: new Date() }).where(eq(userApiKeys.id, id)));
    markDirty();
  },

  async resolveByApiKeyHash(keyHash: string): Promise<{ user: User; apiKey: UserApiKey } | null> {
    const apiKey = await this.findActiveApiKeyByHash(keyHash);
    if (!apiKey) return null;

    const user = await this.findById(apiKey.userId);
    if (!user || user.isDisabled || !user.isApproved) {
      return null;
    }

    return { user, apiKey };
  },

  toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role as UserRole,
      isApproved: !!user.isApproved,
      isDisabled: !!user.isDisabled,
      accessAllProjects: !!user.accessAllProjects,
      accessAllModels: !!user.accessAllModels,
      allowedModels: parseAllowedModels(user),
      hiddenModels: parseHiddenModels(user),
      createdAt: new Date(user.createdAt),
      lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : null,
    };
  },
};