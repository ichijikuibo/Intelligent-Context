import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

const mocks = vi.hoisted(() => ({
  modelMaxTokens: vi.fn((modelId: string) => (modelId === 'unknown-model' ? 16_000 : 128_000)),
  providersRepo: {
    findAll: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  },
  providerModelMetadataRepo: {
    findByProvider: vi.fn(),
  },
  modelOverridesRepo: {
    findByProvider: vi.fn(),
    find: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  usersRepo: {
    update: vi.fn(),
  },
  formatZodError: vi.fn(() => 'validation.error'),
  t: vi.fn((_: unknown, key: string) => key),
}));

vi.mock('../../src/context/budget', () => ({
  modelMaxTokens: mocks.modelMaxTokens,
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

vi.mock('../../src/db/repositories/providerModelMetadata', () => ({
  providerModelMetadataRepo: mocks.providerModelMetadataRepo,
}));

vi.mock('../../src/db/repositories/modelOverrides', () => ({
  modelOverridesRepo: mocks.modelOverridesRepo,
}));

vi.mock('../../src/db/repositories/users', () => ({
  usersRepo: mocks.usersRepo,
}));

vi.mock('../../src/i18n', () => ({
  formatZodError: mocks.formatZodError,
  t: mocks.t,
}));

import { createModelsRouter } from '../../src/api/routes/models';

/**
 * Mount the router the way the management app does: an outer auth layer puts
 * the caller on the request, and the router gates its own writes.
 */
function createApp(user: Record<string, unknown> = adminUser()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    (req as any).userRole = user.role;
    next();
  });
  app.use(createModelsRouter());
  return app;
}

function adminUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'admin-1',
    email: 'admin@example.com',
    role: 'admin',
    isApproved: true,
    isDisabled: false,
    accessAllProjects: true,
    accessAllModels: true,
    allowedModels: [],
    hiddenModels: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: null,
    ...overrides,
  };
}

function manualProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    name: 'Local Gateway',
    type: 'openai',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'none',
    shortPrefix: 'LGW',
    models: 'model-a',
    isEnabled: true,
    isDefault: true,
    externalProviderId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('createModelsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerModelMetadataRepo.findByProvider.mockResolvedValue([]);
    mocks.modelOverridesRepo.findByProvider.mockResolvedValue([]);
    mocks.modelOverridesRepo.find.mockResolvedValue(undefined);
    mocks.modelOverridesRepo.upsert.mockResolvedValue({});
    mocks.modelOverridesRepo.delete.mockResolvedValue(undefined);
    mocks.providersRepo.update.mockResolvedValue(undefined);
  });

  it('merges provider, reported, and override values into effective model rows', async () => {
    const provider = manualProvider();
    mocks.providersRepo.findAll.mockResolvedValue([provider]);
    mocks.providerModelMetadataRepo.findByProvider.mockResolvedValue([
      { providerId: 'provider-1', modelId: 'model-a', contextLength: 64_000, displayName: 'Reported A', apiFormat: 'openai' },
    ]);
    mocks.modelOverridesRepo.findByProvider.mockResolvedValue([
      { providerId: 'provider-1', modelId: 'model-a', contextLength: 32_000, supportsReasoning: true, supportsVision: true },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/');
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.providers).toEqual([
        {
          id: 'provider-1',
          name: 'Local Gateway',
          type: 'openai',
          isEnabled: true,
          isExternal: false,
          shortPrefix: 'LGW',
        },
      ]);
      expect(body.models).toEqual([
        expect.objectContaining({
          providerId: 'provider-1',
          modelId: 'model-a',
          scopedId: 'LGW-model-a',
          displayName: 'Reported A',
          contextLength: 32_000,
          apiFormat: 'openai',
          supportsReasoning: true,
          supportsVision: true,
          inProviderList: true,
          override: expect.objectContaining({ contextLength: 32_000, supportsReasoning: true, supportsVision: true }),
          reported: expect.objectContaining({ contextLength: 64_000, displayName: 'Reported A' }),
        }),
      ]);
    });
  });

  it('falls back to the heuristic context window when nothing is reported', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([manualProvider({ models: 'unknown-model' })]);

    await withTestServer(createApp(), async ({ request }) => {
      const body = await (await request('/')).json();

      expect(body.models[0]).toMatchObject({
        modelId: 'unknown-model',
        contextLength: 16_000,
        defaultContextLength: 16_000,
      });
      expect(body.models[0].override).toBeUndefined();
    });
  });

  it('adds a model to a manual provider and stores its overrides', async () => {
    mocks.providersRepo.findById.mockResolvedValue(manualProvider());
    mocks.modelOverridesRepo.findByProvider.mockResolvedValue([]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'provider-1',
          modelId: 'model-b',
          displayName: 'Model B',
          contextLength: 200_000,
          apiFormat: 'anthropic',
          supportsReasoning: true,
          supportsVision: true,
        }),
      });

      expect(response.status).toBe(201);
      expect(mocks.providersRepo.update).toHaveBeenCalledWith('provider-1', { models: 'model-a,model-b' });
      expect(mocks.modelOverridesRepo.upsert).toHaveBeenCalledWith('provider-1', 'model-b', {
        displayName: 'Model B',
        contextLength: 200_000,
        apiFormat: 'anthropic',
        supportsReasoning: true,
        supportsVision: true,
      });
    });
  });

  it('rejects adding or removing models on an externally managed provider', async () => {
    mocks.providersRepo.findById.mockResolvedValue(
      manualProvider({ externalProviderId: 'external-1' })
    );

    await withTestServer(createApp(), async ({ request }) => {
      const addResponse = await request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-1', modelId: 'model-b' }),
      });
      expect(addResponse.status).toBe(400);
      expect(await addResponse.json()).toEqual({ error: 'api.error.externalProviderModelsManaged' });

      const deleteResponse = await request('/provider-1/model-a', { method: 'DELETE' });
      expect(deleteResponse.status).toBe(400);
      expect(mocks.providersRepo.update).not.toHaveBeenCalled();
    });
  });

  it('updates overrides and renames a model on a manual provider', async () => {
    mocks.providersRepo.findById.mockResolvedValue(manualProvider());
    mocks.modelOverridesRepo.find.mockResolvedValue({ providerId: 'provider-1', modelId: 'model-a' });

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/provider-1/model-a', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: 'model-a-renamed',
          displayName: 'Renamed',
          contextLength: 8_192,
          apiFormat: 'openai',
          supportsReasoning: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mocks.providersRepo.update).toHaveBeenCalledWith('provider-1', { models: 'model-a-renamed' });
      expect(mocks.modelOverridesRepo.delete).toHaveBeenCalledWith('provider-1', 'model-a');
      expect(mocks.modelOverridesRepo.upsert).toHaveBeenCalledWith('provider-1', 'model-a-renamed', {
        displayName: 'Renamed',
        contextLength: 8_192,
        apiFormat: 'openai',
        supportsReasoning: false,
      });
    });
  });

  it('clears an override without touching the model list', async () => {
    mocks.providersRepo.findById.mockResolvedValue(manualProvider());

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/provider-1/model-a/override', { method: 'DELETE' });

      expect(response.status).toBe(204);
      expect(mocks.modelOverridesRepo.delete).toHaveBeenCalledWith('provider-1', 'model-a');
      expect(mocks.providersRepo.update).not.toHaveBeenCalled();
    });
  });

  it('removes a model from a manual provider', async () => {
    mocks.providersRepo.findById.mockResolvedValue(manualProvider({ models: 'model-a,model-b' }));

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/provider-1/model-a', { method: 'DELETE' });

      expect(response.status).toBe(204);
      expect(mocks.providersRepo.update).toHaveBeenCalledWith('provider-1', { models: 'model-b' });
      expect(mocks.modelOverridesRepo.delete).toHaveBeenCalledWith('provider-1', 'model-a');
    });
  });

  it('returns 404 for an unknown model', async () => {
    mocks.providersRepo.findById.mockResolvedValue(manualProvider());

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/provider-1/missing-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'X' }),
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'api.error.modelNotFound' });
    });
  });

  it('rejects an invalid body before touching the repositories', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-1', modelId: '' }),
      });

      expect(response.status).toBe(400);
      expect(mocks.formatZodError).toHaveBeenCalled();
      expect(mocks.providersRepo.findById).not.toHaveBeenCalled();
    });
  });

  // ── Model access ────────────────────────────────────────────────────────

  it('reports full access for an admin and marks every row accessible', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([manualProvider()]);

    await withTestServer(createApp(), async ({ request }) => {
      const body = await (await request('/')).json();

      expect(body.canManage).toBe(true);
      expect(body.allModels).toBe(true);
      expect(body.grants).toEqual([]);
      expect(body.models[0]).toMatchObject({ scopedId: 'LGW-model-a', canAccess: true });
    });
  });

  it('shows a restricted user only the models they were granted', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([
      manualProvider({ models: 'model-a,model-b' }),
      manualProvider({ id: 'provider-2', name: 'Other', shortPrefix: 'OTH', models: 'model-c' }),
    ]);
    const user = adminUser({
      role: 'user',
      accessAllModels: false,
      allowedModels: ['LGW-model-b'],
    });

    await withTestServer(createApp(user), async ({ request }) => {
      const body = await (await request('/')).json();

      expect(body.canManage).toBe(false);
      expect(body.allModels).toBe(false);
      expect(body.grants).toEqual(['LGW-model-b']);
      expect(body.models.map((row: { scopedId: string }) => row.scopedId)).toEqual(['LGW-model-b']);
      // Providers with nothing visible drop out of the list entirely.
      expect(body.providers.map((p: { id: string }) => p.id)).toEqual(['provider-1']);
    });
  });

  it('honours provider wildcards and *-* when filtering', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([
      manualProvider({ models: 'model-a,model-b' }),
      manualProvider({ id: 'provider-2', name: 'Other', shortPrefix: 'OTH', models: 'model-c' }),
    ]);

    await withTestServer(
      createApp(adminUser({ role: 'user', accessAllModels: false, allowedModels: ['OTH-*'] })),
      async ({ request }) => {
        const body = await (await request('/')).json();
        expect(body.models.map((row: { scopedId: string }) => row.scopedId)).toEqual(['OTH-model-c']);
      }
    );

    await withTestServer(
      createApp(adminUser({ role: 'user', accessAllModels: false, allowedModels: ['*-*'] })),
      async ({ request }) => {
        const body = await (await request('/')).json();
        expect(body.models).toHaveLength(3);
        expect(body.allModels).toBe(false);
      }
    );
  });

  it('blocks writes from a non-manager', async () => {
    mocks.providersRepo.findById.mockResolvedValue(manualProvider());
    const user = adminUser({ role: 'user', accessAllModels: false, allowedModels: ['LGW-*'] });

    await withTestServer(createApp(user), async ({ request }) => {
      const add = await request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-1', modelId: 'model-b' }),
      });
      expect(add.status).toBe(403);

      const remove = await request('/provider-1/model-a', { method: 'DELETE' });
      expect(remove.status).toBe(403);

      expect(mocks.providersRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── IDE visibility preference ───────────────────────────────────────────

  it('marks hidden models and reports the stored preference', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([manualProvider({ models: 'model-a,model-b' })]);
    const user = adminUser({ hiddenModels: ['LGW-model-a'] });

    await withTestServer(createApp(user), async ({ request }) => {
      const body = await (await request('/')).json();

      expect(body.hiddenModels).toEqual(['LGW-model-a']);
      expect(body.models).toEqual([
        expect.objectContaining({ scopedId: 'LGW-model-a', hidden: true, canAccess: true }),
        expect.objectContaining({ scopedId: 'LGW-model-b', hidden: false, canAccess: true }),
      ]);
    });
  });

  it('lets any user save their own visibility preference, including wildcards', async () => {
    const user = adminUser({
      role: 'user',
      accessAllModels: false,
      allowedModels: ['LGW-*'],
      hiddenModels: [],
    });

    await withTestServer(createApp(user), async ({ request }) => {
      const response = await request('/visibility', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenModels: ['LGW-model-a', 'OCA-*', 'LGW-model-a'] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        hiddenModels: ['LGW-model-a', 'OCA-*'],
      });
    });

    // A user-level preference, so it writes to the caller's own row.
    expect(mocks.usersRepo.update).toHaveBeenCalledWith('admin-1', {
      hiddenModels: ['LGW-model-a', 'OCA-*'],
    });
  });

  it('rejects a malformed visibility payload', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/visibility', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenModels: 'not-an-array' }),
      });

      expect(response.status).toBe(400);
      expect(mocks.usersRepo.update).not.toHaveBeenCalled();
    });
  });
});
