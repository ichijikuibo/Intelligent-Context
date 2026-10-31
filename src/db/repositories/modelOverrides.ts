import { and, eq, inArray } from 'drizzle-orm';
import { db, markDirty, selectAll, execute } from '../connection';
import { getSchema } from '../schema';
import {
  setProviderModelOverrides,
  clearProviderModelOverrides,
} from '../../proxy/modelMetadataCache';

function tables() {
  return getSchema();
}

/**
 * Fields a user can override for one model. Every field is optional: an
 * omitted field stays `null` in the row and the provider's reported value
 * (or the built-in default) applies.
 */
export interface ModelOverrideInput {
  displayName?: string;
  contextLength?: number;
  apiFormat?: 'openai' | 'anthropic';
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

export interface ModelOverrideRecord extends ModelOverrideInput {
  providerId: string;
  modelId: string;
}

/**
 * Per-model overrides written from the management UI's Models dialog.
 *
 * Kept apart from `providerModelMetadataRepo` so an external provider sync can
 * replace its reported values without discarding user edits. Writes refresh
 * the in-memory cache consumed by the synchronous token-budget path and the
 * `/v1/models` catalog, so callers never have to think about both stores.
 */
export const modelOverridesRepo = {
  /** All override rows for one provider. */
  async findByProvider(providerId: string): Promise<ModelOverrideRecord[]> {
    const { providerModelOverrides } = tables();
    const rows = await selectAll(
      db()
        .select()
        .from(providerModelOverrides)
        .where(eq(providerModelOverrides.providerId, providerId))
    );

    return rows.map(mapRow);
  },

  /** Every override row, used to prime the cache at startup. */
  async findAll(): Promise<ModelOverrideRecord[]> {
    const { providerModelOverrides } = tables();
    const rows = await selectAll(db().select().from(providerModelOverrides));
    return rows.map(mapRow);
  },

  /** One override row, when present. */
  async find(providerId: string, modelId: string): Promise<ModelOverrideRecord | undefined> {
    const { providerModelOverrides } = tables();
    const rows = await selectAll(
      db()
        .select()
        .from(providerModelOverrides)
        .where(
          and(
            eq(providerModelOverrides.providerId, providerId),
            eq(providerModelOverrides.modelId, modelId)
          )
        )
    );

    const row = rows[0];
    return row ? mapRow(row) : undefined;
  },

  /**
   * Create or replace the override for one model. All fields are replaced, so
   * callers must send the complete set they want stored; an omitted field is
   * cleared (`null`) rather than preserved.
   */
  async upsert(
    providerId: string,
    modelId: string,
    input: ModelOverrideInput
  ): Promise<ModelOverrideRecord> {
    const { providerModelOverrides } = tables();
    const now = new Date();

    await execute(
      db()
        .delete(providerModelOverrides)
        .where(
          and(
            eq(providerModelOverrides.providerId, providerId),
            eq(providerModelOverrides.modelId, modelId)
          )
        )
    );

    await execute(
      db()
        .insert(providerModelOverrides)
        .values({
          providerId,
          modelId,
          displayName: input.displayName ?? null,
          contextLength:
            typeof input.contextLength === 'number' && input.contextLength > 0
              ? Math.floor(input.contextLength)
              : null,
          apiFormat: normalizeApiFormat(input.apiFormat),
          supportsReasoning:
            typeof input.supportsReasoning === 'boolean' ? input.supportsReasoning : null,
          supportsVision:
            typeof input.supportsVision === 'boolean' ? input.supportsVision : null,
          createdAt: now,
          updatedAt: now,
        } as any)
    );

    markDirty();
    await this.refreshCacheForProvider(providerId);

    return {
      providerId,
      modelId,
      displayName: input.displayName,
      contextLength:
        typeof input.contextLength === 'number' && input.contextLength > 0
          ? Math.floor(input.contextLength)
          : undefined,
      apiFormat: normalizeApiFormat(input.apiFormat) ?? undefined,
      supportsReasoning: input.supportsReasoning,
      supportsVision: input.supportsVision,
    };
  },

  /** Remove the override for one model (revert to reported values). */
  async delete(providerId: string, modelId: string): Promise<void> {
    const { providerModelOverrides } = tables();
    await execute(
      db()
        .delete(providerModelOverrides)
        .where(
          and(
            eq(providerModelOverrides.providerId, providerId),
            eq(providerModelOverrides.modelId, modelId)
          )
        )
    );

    markDirty();
    await this.refreshCacheForProvider(providerId);
  },

  /** Delete overrides for several providers in one statement (used on delete). */
  async deleteForProviders(providerIds: string[]): Promise<void> {
    if (providerIds.length === 0) return;
    const { providerModelOverrides } = tables();
    await execute(
      db()
        .delete(providerModelOverrides)
        .where(inArray(providerModelOverrides.providerId, providerIds))
    );

    markDirty();
    for (const id of providerIds) {
      clearProviderModelOverrides(id);
    }
  },

  /**
   * Load every stored row into the in-memory cache.
   * Called once during startup, after migrations.
   */
  async primeCache(): Promise<void> {
    const rows = await this.findAll();
    const byProvider = new Map<string, Array<ModelOverrideInput & { modelId: string }>>();
    for (const row of rows) {
      const list = byProvider.get(row.providerId) ?? [];
      list.push({
        modelId: row.modelId,
        displayName: row.displayName,
        contextLength: row.contextLength,
        apiFormat: row.apiFormat,
        supportsReasoning: row.supportsReasoning,
        supportsVision: row.supportsVision,
      });
      byProvider.set(row.providerId, list);
    }

    for (const [providerId, models] of byProvider) {
      setProviderModelOverrides(providerId, models);
    }
  },

  /** Re-read one provider's rows so the in-memory cache matches the table. */
  async refreshCacheForProvider(providerId: string): Promise<void> {
    const rows = await this.findByProvider(providerId);
    setProviderModelOverrides(
      providerId,
      rows.map((row) => ({
        modelId: row.modelId,
        displayName: row.displayName,
        contextLength: row.contextLength,
        apiFormat: row.apiFormat,
        supportsReasoning: row.supportsReasoning,
        supportsVision: row.supportsVision,
      }))
    );
  },
};

function mapRow(row: any): ModelOverrideRecord {
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName ?? undefined,
    contextLength: row.contextLength ?? undefined,
    apiFormat: row.apiFormat ?? undefined,
    supportsReasoning: typeof row.supportsReasoning === 'boolean' ? row.supportsReasoning : undefined,
    supportsVision: typeof row.supportsVision === 'boolean' ? row.supportsVision : undefined,
  };
}

function normalizeApiFormat(value: string | undefined): 'openai' | 'anthropic' | null {
  return value === 'openai' || value === 'anthropic' ? value : null;
}
