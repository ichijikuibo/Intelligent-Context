import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, selectAll, selectOne, execute } from '../connection';
import { getSchema, type ProviderConfig, type NewProviderConfig, parseModels } from '../schema';
import {
  createProviderConflictError,
  createProviderShortPrefixConflictError,
  isDuplicateKeyError,
} from '../errors';
import { buildModelDisplayName, modelLabelFor, parseModelDisplayName } from '../../proxy/modelLabels';
import { providerModelMetadataRepo } from './providerModelMetadata';
import { modelOverridesRepo } from './modelOverrides';

function tables() {
  return getSchema();
}

function normalizeShortPrefix(value: string | null | undefined): string | null {
  const normalized = String(value ?? '')
    .trim()
    .replace(/-+$/, '')
    .toUpperCase();

  return normalized.length > 0 ? normalized : null;
}

export type ProviderType = 'openai' | 'anthropic';

export interface CreateProviderData {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  shortPrefix?: string;
  models?: string;
}

export interface UpdateProviderData {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  shortPrefix?: string;
  models?: string;
  isEnabled?: boolean;
}

export const providersRepo = {
  async findAll(): Promise<ProviderConfig[]> {
    const { providerConfigs } = tables();
    return selectAll(db().select().from(providerConfigs));
  },

  async findById(id: string): Promise<ProviderConfig | undefined> {
    const { providerConfigs } = tables();
    return selectOne(db()
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id)));
  },

  async findByShortPrefix(shortPrefix: string): Promise<ProviderConfig | undefined> {
    const normalized = normalizeShortPrefix(shortPrefix);
    if (!normalized) return undefined;

    const { providerConfigs } = tables();
    return selectOne(db()
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.shortPrefix, normalized)));
  },

  async assertShortPrefixAvailable(shortPrefix: string | null, excludeId?: string): Promise<void> {
    if (!shortPrefix) return;

    const existing = await this.findByShortPrefix(shortPrefix);
    if (existing && existing.id !== excludeId) {
      throw createProviderShortPrefixConflictError(shortPrefix);
    }
  },

  /**
   * Find the best provider for a given adapter type.
   * Preference: enabled + default > enabled + first.
   */
  async findBestForType(type: ProviderType): Promise<ProviderConfig | undefined> {
    const { providerConfigs } = tables();
    const enabled = await selectAll(db()
      .select()
      .from(providerConfigs)
      .where(and(eq(providerConfigs.type, type), eq(providerConfigs.isEnabled, true))));

    if (enabled.length === 0) return undefined;
    return enabled.find((p: ProviderConfig) => p.isDefault) ?? enabled[0];
  },

  /**
   * Find any enabled provider (used as a last resort fallback).
   */
  async findAnyEnabled(): Promise<ProviderConfig | undefined> {
    const { providerConfigs } = tables();
    return selectOne(db()
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.isEnabled, true)));
  },

  /**
   * Find the best provider that includes a specific model ID.
   * Scans all enabled providers' models lists for a match.
   * Prefers exact match on a default provider.
   */
  async findProviderForModel(modelId: string): Promise<ProviderConfig | undefined> {
    if (!modelId) return undefined;
    const { providerConfigs } = tables();
    const lower = modelId.toLowerCase();
    const all = await selectAll(db()
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.isEnabled, true)));

    // Score: exact model match preferred, default providers weighted higher
    const scored = all
      .map((p: ProviderConfig) => {
        const modelList = parseModels(p);
        const exact = modelList.some((m) => m.toLowerCase() === lower);
        const partial = modelList.some((m) => m.toLowerCase().includes(lower) || lower.includes(m.toLowerCase()));
        let score = 0;
        if (exact) score = 200;
        else if (partial) score = 100;
        if (p.isDefault) score += 50;
        return { provider: p, score };
      })
      .filter((x: { provider: ProviderConfig; score: number }) => x.score > 0)
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

    return scored[0]?.provider;
  },

  /**
   * Resolve a human-facing model label back to a provider and raw model ID.
   *
   * Clients frequently send the catalog's `display_name`
   * (`"CommandCode (OpenAI) · DeepSeek V4.1 Flash"`) instead of the routing
   * `id`/`model_id`. A label is not a valid upstream model name, so callers must
   * translate it before forwarding the request — otherwise it falls through to
   * provider-type guessing and the upstream rejects the model.
   *
   * The provider name embedded in the label is treated as authoritative when it
   * matches a configured provider, so two gateways exposing the same model
   * cannot shadow each other.
   */
  async findModelForLabel(
    label: string
  ): Promise<{ provider: ProviderConfig; modelId: string } | undefined> {
    const wanted = label.trim();
    if (!wanted) return undefined;

    const { providerConfigs } = tables();
    const enabled = await selectAll(db()
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.isEnabled, true)));

    const matchInProvider = (
      provider: ProviderConfig,
      candidate: string
    ): string | undefined => {
      const target = candidate.trim().toLowerCase();
      if (!target) return undefined;

      for (const modelId of parseModels(provider)) {
        const reported = modelLabelFor(provider.id, modelId);
        const candidates = [
          modelId,
          reported,
          buildModelDisplayName(provider.name, reported),
          buildModelDisplayName(provider.name, modelId),
        ];
        if (candidates.some((value) => value.toLowerCase() === target)) {
          return modelId;
        }
      }
      return undefined;
    };

    const parsed = parseModelDisplayName(wanted);

    // Pass 1 — the label names a provider, so only consider that provider.
    if (parsed) {
      const named = enabled.filter(
        (p: ProviderConfig) => p.name.toLowerCase() === parsed.providerName.toLowerCase()
      );
      for (const provider of named) {
        const modelId = matchInProvider(provider, wanted);
        if (modelId) return { provider, modelId };
      }
    }

    // Pass 2 — no provider prefix, or a stale one (e.g. the provider was
    // renamed). Fall back to matching the whole label, then the bare model
    // label, across every provider.
    for (const provider of enabled) {
      const modelId =
        matchInProvider(provider, wanted) ??
        (parsed ? matchInProvider(provider, parsed.modelLabel) : undefined);
      if (modelId) return { provider, modelId };
    }

    return undefined;
  },

  async insert(data: CreateProviderData): Promise<ProviderConfig> {
    const now = new Date();
    const { providerConfigs } = tables();
    const shortPrefix = normalizeShortPrefix(data.shortPrefix);
    // First provider of its type automatically becomes the default
    const existingSameType = await selectAll(db()
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.type, data.type)));

    await this.assertShortPrefixAvailable(shortPrefix);

    const row: NewProviderConfig = {
      id: uuidv4(),
      name: data.name,
      type: data.type,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey,
      shortPrefix,
      models: data.models ?? '',
      isEnabled: true,
      isDefault: existingSameType.length === 0, // first of its type = default
      createdAt: now,
      updatedAt: now,
    };

    try {
      await execute(db().insert(providerConfigs).values(row));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        if (shortPrefix) {
          throw createProviderShortPrefixConflictError(shortPrefix, error);
        }
        throw createProviderConflictError(data.name, error);
      }
      throw error;
    }

    markDirty();
    return (await this.findById(row.id))!;
  },

  async update(id: string, data: UpdateProviderData): Promise<ProviderConfig | undefined> {
    const { providerConfigs } = tables();
    const updates: Partial<NewProviderConfig> = { updatedAt: new Date() };
    if (data.shortPrefix !== undefined) {
      const shortPrefix = normalizeShortPrefix(data.shortPrefix);
      await this.assertShortPrefixAvailable(shortPrefix, id);
      updates.shortPrefix = shortPrefix;
    }
    if (data.name !== undefined) updates.name = data.name;
    if (data.baseUrl !== undefined) updates.baseUrl = data.baseUrl;
    if (data.apiKey !== undefined && data.apiKey !== '') updates.apiKey = data.apiKey;
    if (data.models !== undefined) updates.models = data.models;
    if (data.isEnabled !== undefined) updates.isEnabled = data.isEnabled;

    try {
      await execute(db()
        .update(providerConfigs)
        .set(updates)
        .where(eq(providerConfigs.id, id)));
    } catch (error) {
      if (isDuplicateKeyError(error) && updates.shortPrefix) {
        throw createProviderShortPrefixConflictError(updates.shortPrefix, error);
      }
      throw error;
    }
    markDirty();
    return this.findById(id);
  },

  /**
   * Set a provider as the default for its type (unsets any existing default of that type).
   */
  async setDefault(id: string): Promise<void> {
    const { providerConfigs } = tables();
    const provider = await this.findById(id);
    if (!provider) return;

    const d = db();
    // Unset all defaults for this type in one update
    await execute(d.update(providerConfigs)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(providerConfigs.type, provider.type)));

    // Set this provider as default
    await execute(d.update(providerConfigs)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(providerConfigs.id, id)));
    markDirty();
  },

  async delete(id: string): Promise<void> {
    const { providerConfigs } = tables();
    const provider = await this.findById(id);

    // Drop per-model rows (and their cached values) before the provider row
    // they reference disappears, so the synchronous token-budget cache cannot
    // outlive them. Overrides are user-authored, reported metadata is synced;
    // both belong to the provider being removed.
    await providerModelMetadataRepo.deleteForProviders([id]);
    await modelOverridesRepo.deleteForProviders([id]);

    await execute(db().delete(providerConfigs).where(eq(providerConfigs.id, id)));

    // If deleted provider was default, promote next enabled of same type
    if (provider?.isDefault) {
      const next = await selectOne(db()
        .select()
        .from(providerConfigs)
        .where(and(eq(providerConfigs.type, provider.type), eq(providerConfigs.isEnabled, true))));
      if (next) {
        await execute(db()
          .update(providerConfigs)
          .set({ isDefault: true })
          .where(eq(providerConfigs.id, next.id)));
      }
    }
    markDirty();
  },

  async count(): Promise<number> {
    const { providerConfigs } = tables();
    return (await selectAll(db().select().from(providerConfigs))).length;
  },

  /** Returns masked key for safe display — never returns the real key */
  maskKey(key: string): string {
    if (!key || key.length <= 8) return '••••••••';
    return '••••' + key.slice(-4);
  },
};
