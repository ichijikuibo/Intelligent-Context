import { eq, inArray } from 'drizzle-orm';
import { db, markDirty, selectAll, execute } from '../connection';
import { getSchema } from '../schema';
import {
  setProviderModelMetadata,
  clearProviderModelMetadata,
} from '../../proxy/modelMetadataCache';

function tables() {
  return getSchema();
}

export interface ProviderModelMetadataInput {
  modelId: string;
  contextLength?: number;
  displayName?: string;
  apiFormat?: 'openai' | 'anthropic';
}

export interface ProviderModelMetadataRecord extends ProviderModelMetadataInput {
  providerId: string;
}

/**
 * Per-model metadata reported by a provider's /models endpoint.
 *
 * Writes also refresh the in-memory cache consumed by the (synchronous) token
 * budget calculation, so callers never have to think about both stores.
 */
export const providerModelMetadataRepo = {
  /** All metadata rows for one provider. */
  async findByProvider(providerId: string): Promise<ProviderModelMetadataRecord[]> {
    const { providerModelMetadata } = tables();
    const rows = await selectAll(
      db()
        .select()
        .from(providerModelMetadata)
        .where(eq(providerModelMetadata.providerId, providerId))
    );

    return rows.map((row: any) => ({
      providerId: row.providerId,
      modelId: row.modelId,
      contextLength: row.contextLength ?? undefined,
      displayName: row.displayName ?? undefined,
      apiFormat: row.apiFormat ?? undefined,
    }));
  },

  /** Every metadata row, used to prime the cache at startup. */
  async findAll(): Promise<ProviderModelMetadataRecord[]> {
    const { providerModelMetadata } = tables();
    const rows = await selectAll(db().select().from(providerModelMetadata));

    return rows.map((row: any) => ({
      providerId: row.providerId,
      modelId: row.modelId,
      contextLength: row.contextLength ?? undefined,
      displayName: row.displayName ?? undefined,
      apiFormat: row.apiFormat ?? undefined,
    }));
  },

  /**
   * Replace the metadata for one provider with `models`.
   *
   * Runs as a delete-then-insert so models that disappeared upstream are
   * removed rather than left stale. The in-memory cache is refreshed to match.
   */
  async replaceForProvider(
    providerId: string,
    models: ProviderModelMetadataInput[]
  ): Promise<void> {
    const { providerModelMetadata } = tables();
    const now = new Date();

    await execute(
      db()
        .delete(providerModelMetadata)
        .where(eq(providerModelMetadata.providerId, providerId))
    );

    const rows = models
      .filter((model) => model.modelId)
      .map((model) => ({
        providerId,
        modelId: model.modelId,
        contextLength:
          typeof model.contextLength === 'number' && model.contextLength > 0
            ? Math.floor(model.contextLength)
            : null,
        displayName: model.displayName ?? null,
        apiFormat: model.apiFormat ?? null,
        updatedAt: now,
      }));

    if (rows.length > 0) {
      await execute(db().insert(providerModelMetadata).values(rows as any));
    }

    markDirty();
    setProviderModelMetadata(
      providerId,
      rows.map((row) => ({
        modelId: row.modelId,
        contextLength: row.contextLength ?? undefined,
        displayName: row.displayName ?? undefined,
        apiFormat: row.apiFormat ?? undefined,
      }))
    );
  },

  /** Delete all metadata for a provider (used when a provider is removed). */
  async deleteForProvider(providerId: string): Promise<void> {
    const { providerModelMetadata } = tables();
    await execute(
      db()
        .delete(providerModelMetadata)
        .where(eq(providerModelMetadata.providerId, providerId))
    );
    markDirty();
    clearProviderModelMetadata(providerId);
  },

  /** Delete metadata for several providers in one statement. */
  async deleteForProviders(providerIds: string[]): Promise<void> {
    if (providerIds.length === 0) return;
    const { providerModelMetadata } = tables();
    await execute(
      db()
        .delete(providerModelMetadata)
        .where(inArray(providerModelMetadata.providerId, providerIds))
    );
    markDirty();
    for (const id of providerIds) {
      clearProviderModelMetadata(id);
    }
  },

  /**
   * Load every stored row into the in-memory cache.
   * Called once during startup, after migrations.
   */
  async primeCache(): Promise<void> {
    const rows = await this.findAll();
    const byProvider = new Map<string, ProviderModelMetadataInput[]>();
    for (const row of rows) {
      const list = byProvider.get(row.providerId) ?? [];
      list.push({
        modelId: row.modelId,
        contextLength: row.contextLength,
        displayName: row.displayName,
        apiFormat: row.apiFormat,
      });
      byProvider.set(row.providerId, list);
    }

    for (const [providerId, models] of byProvider) {
      setProviderModelMetadata(providerId, models);
    }
  },
};
