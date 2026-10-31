import { and, eq, inArray } from 'drizzle-orm';
import { db, markDirty, selectAll, execute } from '../connection';
import { getSchema } from '../schema';
import {
  setModelReference,
  clearModelReference,
  normalizeReferenceModelId,
  MODEL_REFERENCE_SOURCE_OPENROUTER,
  type ModelReferenceDefaults,
} from '../../proxy/modelReferenceCache';

function tables() {
  return getSchema();
}

/**
 * Reference catalog of well-known models (context window, vision/reasoning
 * support) synced from a public model list.
 *
 * Rows are only ever used as a **default**: a user override or a value the
 * provider reports itself always wins. Writes refresh the in-memory cache the
 * synchronous token-budget path reads.
 */
export const modelReferenceRepo = {
  /** Every row for one source. */
  async findBySource(source: string): Promise<ModelReferenceDefaults[]> {
    const { modelReference } = tables();
    const rows = await selectAll(
      db().select().from(modelReference).where(eq(modelReference.source, source))
    );

    return rows.map((row: any) => ({
      source: row.source,
      modelId: row.modelId,
      vendor: row.vendor ?? undefined,
      displayName: row.displayName ?? undefined,
      contextLength: row.contextLength ?? undefined,
      maxOutputTokens: row.maxOutputTokens ?? undefined,
      supportsVision:
        typeof row.supportsVision === 'boolean' ? row.supportsVision : undefined,
      supportsReasoning:
        typeof row.supportsReasoning === 'boolean' ? row.supportsReasoning : undefined,
    }));
  },

  /** Every row, used to prime the cache at startup. */
  async findAll(): Promise<ModelReferenceDefaults[]> {
    const { modelReference } = tables();
    const rows = await selectAll(db().select().from(modelReference));

    return rows.map((row: any) => ({
      source: row.source,
      modelId: row.modelId,
      vendor: row.vendor ?? undefined,
      displayName: row.displayName ?? undefined,
      contextLength: row.contextLength ?? undefined,
      maxOutputTokens: row.maxOutputTokens ?? undefined,
      supportsVision:
        typeof row.supportsVision === 'boolean' ? row.supportsVision : undefined,
      supportsReasoning:
        typeof row.supportsReasoning === 'boolean' ? row.supportsReasoning : undefined,
    }));
  },

  /** Number of rows for a source (surfaced in the Models tab). */
  async countBySource(source: string): Promise<number> {
    const rows = await this.findBySource(source);
    return rows.length;
  },

  /**
   * Replace one source's catalog in a single delete-then-insert, so models that
   * disappeared upstream are removed rather than left stale. The in-memory
   * cache is refreshed to match.
   */
  async replaceSource(source: string, rows: ModelReferenceDefaults[]): Promise<number> {
    const { modelReference } = tables();
    const now = new Date();

    await execute(
      db().delete(modelReference).where(eq(modelReference.source, source))
    );

    // Two upstream rows can normalize to the same key (`:free` variants), so
    // de-duplicate before insert to avoid a primary-key violation.
    const byId = new Map<string, ModelReferenceDefaults>();
    for (const row of rows) {
      const modelId = normalizeReferenceModelId(row.modelId);
      if (!modelId) continue;
      byId.set(modelId, { ...row, modelId, source });
    }

    const values = [...byId.values()].map((row) => ({
      source,
      modelId: row.modelId,
      vendor: row.vendor ?? null,
      displayName: row.displayName ?? null,
      contextLength:
        typeof row.contextLength === 'number' && row.contextLength > 0
          ? Math.floor(row.contextLength)
          : null,
      maxOutputTokens:
        typeof row.maxOutputTokens === 'number' && row.maxOutputTokens > 0
          ? Math.floor(row.maxOutputTokens)
          : null,
      supportsVision: typeof row.supportsVision === 'boolean' ? row.supportsVision : null,
      supportsReasoning: typeof row.supportsReasoning === 'boolean' ? row.supportsReasoning : null,
      updatedAt: now,
    }));

    // Insert in chunks so a large catalog does not build one huge statement.
    const CHUNK_SIZE = 200;
    for (let index = 0; index < values.length; index += CHUNK_SIZE) {
      const chunk = values.slice(index, index + CHUNK_SIZE);
      if (chunk.length > 0) {
        await execute(db().insert(modelReference).values(chunk as any));
      }
    }

    markDirty();
    setModelReference(source, byId.values());

    return values.length;
  },

  /** Delete one source's rows and drop them from the cache. */
  async deleteSource(source: string): Promise<void> {
    const { modelReference } = tables();
    await execute(db().delete(modelReference).where(eq(modelReference.source, source)));
    markDirty();
    clearModelReference(source);
  },

  /** Delete several sources in one statement. */
  async deleteSources(sources: string[]): Promise<void> {
    if (sources.length === 0) return;
    const { modelReference } = tables();
    await execute(
      db().delete(modelReference).where(inArray(modelReference.source, sources))
    );
    markDirty();
    for (const source of sources) {
      clearModelReference(source);
    }
  },

  /** Load every stored row into the in-memory cache (startup). */
  async primeCache(): Promise<void> {
    const rows = await this.findAll();
    const bySource = new Map<string, ModelReferenceDefaults[]>();
    for (const row of rows) {
      const list = bySource.get(row.source) ?? [];
      list.push(row);
      bySource.set(row.source, list);
    }

    for (const [source, list] of bySource) {
      setModelReference(source, list);
    }
  },
};

/** Convenience re-export so callers do not import the cache module directly. */
export { MODEL_REFERENCE_SOURCE_OPENROUTER };

/**
 * Look up a single row by ID within one source.
 * Returns undefined when the model is not in the reference catalog.
 */
export async function findReferenceModel(
  source: string,
  modelId: string
): Promise<ModelReferenceDefaults | undefined> {
  const normalized = normalizeReferenceModelId(modelId);
  if (!normalized) return undefined;

  const { modelReference } = tables();
  const rows = await selectAll(
    db()
      .select()
      .from(modelReference)
      .where(
        and(eq(modelReference.source, source), eq(modelReference.modelId, normalized))
      )
  );

  const row = rows[0];
  if (!row) return undefined;

  return {
    source: row.source,
    modelId: row.modelId,
    vendor: row.vendor ?? undefined,
    displayName: row.displayName ?? undefined,
    contextLength: row.contextLength ?? undefined,
    maxOutputTokens: row.maxOutputTokens ?? undefined,
    supportsVision: typeof row.supportsVision === 'boolean' ? row.supportsVision : undefined,
    supportsReasoning:
      typeof row.supportsReasoning === 'boolean' ? row.supportsReasoning : undefined,
  };
}
