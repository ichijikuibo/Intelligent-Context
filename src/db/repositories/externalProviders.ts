import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type ExternalProvider, type NewExternalProvider } from '../schema';
import { providersRepo } from './providers';
import { getExternalProviderDef } from '../../externalProviders/registry';
import type { ExternalSubProviderDef } from '../../externalProviders/types';
import { logger } from '../../utils/logger';

function tables() {
  return getSchema();
}

export interface CreateExternalProviderData {
  providerKey: string;
  apiKey: string;
}

function buildSubProviderName(baseName: string, suffix: string): string {
  return `${baseName}${suffix}`;
}

/**
 * Compute the next available prefix for a sub-provider.
 * If providers with "OCO" already exist, uses "OCO2", "OCO3", etc.
 */
async function nextAvailablePrefix(desiredPrefix: string): Promise<string> {
  const allProviders = await providersRepo.findAll();

  // Check if the base prefix is available
  const baseTaken = allProviders.some(
    (p) => (p.shortPrefix ?? '').toUpperCase() === desiredPrefix.toUpperCase()
  );
  if (!baseTaken) return desiredPrefix;

  // Find next available number suffix
  let counter = 2;
  const upperBase = desiredPrefix.toUpperCase();
  while (allProviders.some((p) => (p.shortPrefix ?? '').toUpperCase() === `${upperBase}${counter}`)) {
    counter++;
  }
  return `${upperBase}${counter}`;
}

export const externalProvidersRepo = {
  async findAll(): Promise<ExternalProvider[]> {
    const { externalProviders } = tables();
    return selectAll(db().select().from(externalProviders));
  },

  async findById(id: string): Promise<ExternalProvider | undefined> {
    const { externalProviders } = tables();
    return selectOne(
      db().select().from(externalProviders).where(eq(externalProviders.id, id))
    );
  },

  async findByProviderKey(key: string): Promise<ExternalProvider | undefined> {
    const { externalProviders } = tables();
    return selectOne(
      db().select().from(externalProviders).where(eq(externalProviders.providerKey, key))
    );
  },

  /**
   * Create an external provider and auto-create its internal sub-providers.
   */
  async create(data: CreateExternalProviderData): Promise<ExternalProvider> {
    const def = getExternalProviderDef(data.providerKey);
    if (!def) {
      throw new Error(`Unknown external provider key: ${data.providerKey}`);
    }

    const now = new Date();
    const { externalProviders } = tables();

    const row: NewExternalProvider = {
      id: uuidv4(),
      name: def.displayName,
      providerKey: data.providerKey,
      apiKey: data.apiKey,
      isEnabled: true,
      lastSyncAt: null,
      syncStatus: null,
      syncError: null,
      createdAt: now,
      updatedAt: now,
    };

    await execute(db().insert(externalProviders).values(row));
    markDirty();

    const created = (await this.findById(row.id))!;

    // Auto-create the internal sub-providers
    await this.createSubProviders(created, def);

    return created;
  },

  /**
   * Create the internal provider_configs rows for each sub-provider.
   * Called both on initial creation and on re-sync.
   */
  async createSubProviders(
    externalProvider: ExternalProvider,
    def = getExternalProviderDef(externalProvider.providerKey)
  ): Promise<void> {
    if (!def) return;

    for (const sub of def.subProviders) {
      const prefix = await nextAvailablePrefix(sub.prefix);
      const name = buildSubProviderName(def.displayName, sub.nameSuffix);
      const baseUrl = def.baseUrl;

      try {
        await providersRepo.insert({
          name,
          type: sub.type,
          baseUrl,
          apiKey: externalProvider.apiKey,
          shortPrefix: prefix,
          models: '', // Will be populated by sync
        });

        // Tag the newly created provider with the external provider ID.
        // We need to find it by shortPrefix since we just created it.
        const created = await providersRepo.findByShortPrefix(prefix);
        if (created) {
          const { providerConfigs } = tables();
          await execute(
            db()
              .update(providerConfigs)
              .set({ externalProviderId: externalProvider.id } as any)
              .where(eq(providerConfigs.id, created.id))
          );
          markDirty();
        }
      } catch (err) {
        logger.error('Failed to create sub-provider', {
          externalProvider: externalProvider.name,
          subProvider: sub.prefix,
          error: String(err),
        });
      }
    }
  },

  /**
   * Find all internal providers that belong to an external provider.
   */
  async findSubProviders(externalProviderId: string) {
    const { providerConfigs } = tables();
    return selectAll(
      db()
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.externalProviderId, externalProviderId))
    );
  },

  /**
   * Update sync status after attempting a model sync.
   */
  async updateSyncStatus(
    id: string,
    status: 'success' | 'error',
    errorMessage?: string
  ): Promise<void> {
    const { externalProviders } = tables();
    await execute(
      db()
        .update(externalProviders)
        .set({
          lastSyncAt: new Date(),
          syncStatus: status,
          syncError: errorMessage ?? null,
          updatedAt: new Date(),
        } as any)
        .where(eq(externalProviders.id, id))
    );
    markDirty();
  },

  /**
   * Update the API key for an external provider and all its sub-providers.
   */
  async updateApiKey(id: string, apiKey: string): Promise<ExternalProvider | undefined> {
    const existing = await this.findById(id);
    if (!existing) return undefined;

    const { externalProviders } = tables();
    await execute(
      db()
        .update(externalProviders)
        .set({ apiKey, updatedAt: new Date() } as any)
        .where(eq(externalProviders.id, id))
    );
    markDirty();

    // Also update all linked sub-providers
    const subProviders = await this.findSubProviders(id);
    for (const sub of subProviders) {
      await providersRepo.update(sub.id, { apiKey });
    }

    return this.findById(id);
  },

  /**
   * Delete an external provider and all its linked sub-providers.
   */
  async delete(id: string): Promise<void> {
    const subProviders = await this.findSubProviders(id);

    // Each sub-provider's per-model metadata and overrides are dropped by
    // providersRepo.delete before the provider rows are removed.
    for (const sub of subProviders) {
      await providersRepo.delete(sub.id);
    }

    const { externalProviders } = tables();
    await execute(
      db().delete(externalProviders).where(eq(externalProviders.id, id))
    );
    markDirty();
  },

  async count(): Promise<number> {
    const { externalProviders } = tables();
    return (await selectAll(db().select().from(externalProviders))).length;
  },
};
