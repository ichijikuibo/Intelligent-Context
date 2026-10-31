import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

function normalizeScopedModelId(value: string) {
  const uuidScopedMatch = value.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(.+)$/i);
  if (uuidScopedMatch) {
    return { providerHint: uuidScopedMatch[1], model: uuidScopedMatch[2] };
  }

  const match = value.match(/^([A-Z][A-Z0-9]{1,15})-(.+)$/);
  if (match) {
    return { providerHint: match[1], model: match[2] };
  }
  return { providerHint: undefined, model: value };
}

const mocks = vi.hoisted(() => ({
  hasModelAccess: vi.fn(),
  authMiddleware: vi.fn(),
  analyzeProjectCommandMiddleware: vi.fn(),
  projectDetectMiddleware: vi.fn(),
  contextInjectMiddleware: vi.fn(),
  createLearningToolsMiddleware: vi.fn(),
  loggingMiddleware: vi.fn(),
  rateLimitMiddleware: vi.fn(),
  normalizeAnthropicRequestMiddleware: vi.fn(),
  proxyToUpstream: vi.fn(),
  providersRepo: {
    findAll: vi.fn(),
  },
  t: vi.fn((_: unknown, key: string) => key),
}));

vi.mock('../../src/auth/context', () => ({
  hasModelAccess: mocks.hasModelAccess,
}));

vi.mock('../../src/proxy/middleware/auth', () => ({
  authMiddleware: mocks.authMiddleware,
}));

vi.mock('../../src/proxy/middleware/analyzeProjectCommand', () => ({
  analyzeProjectCommandMiddleware: mocks.analyzeProjectCommandMiddleware,
}));

vi.mock('../../src/proxy/middleware/projectDetect', () => ({
  projectDetectMiddleware: mocks.projectDetectMiddleware,
}));

vi.mock('../../src/proxy/middleware/contextInject', () => ({
  contextInjectMiddleware: mocks.contextInjectMiddleware,
}));

vi.mock('../../src/proxy/middleware/learningTools', () => ({
  createLearningToolsMiddleware: mocks.createLearningToolsMiddleware,
}));

vi.mock('../../src/proxy/middleware/logging', () => ({
  loggingMiddleware: mocks.loggingMiddleware,
}));

vi.mock('../../src/proxy/middleware/rateLimit', () => ({
  rateLimitMiddleware: mocks.rateLimitMiddleware,
}));

vi.mock('../../src/proxy/upstream', () => ({
  proxyToUpstream: mocks.proxyToUpstream,
}));

vi.mock('../../src/proxy/middleware/normalizeAnthropicRequest', () => ({
  normalizeAnthropicRequestMiddleware: mocks.normalizeAnthropicRequestMiddleware,
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

vi.mock('../../src/i18n', () => ({
  t: mocks.t,
}));

import { createProxyRouter } from '../../src/proxy/router';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(createProxyRouter());
  return app;
}

describe('createProxyRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.hasModelAccess.mockImplementation((user: any, modelId: string) => {
      if (user.role === 'admin') return true;

      const requested = normalizeScopedModelId(modelId);
      return user.allowedModels.some((allowed: string) => {
        if (allowed === modelId) return true;
        const candidate = normalizeScopedModelId(allowed);
        if (candidate.providerHint) {
          return candidate.providerHint === requested.providerHint && candidate.model === requested.model;
        }
        return candidate.model === requested.model;
      });
    });
    mocks.authMiddleware.mockImplementation((req: any, _res: any, next: () => void) => {
      const role = req.headers['x-test-role'];
      if (typeof role === 'string' && role.length > 0) {
        const allowedModelsHeader = req.headers['x-test-allowed-models'];
        req.user = {
          id: 'user-1',
          email: 'user@example.com',
          role,
          isApproved: true,
          isDisabled: false,
          accessAllProjects: role === 'admin',
          accessAllModels: role === 'admin',
          allowedModels:
            typeof allowedModelsHeader === 'string'
              ? allowedModelsHeader.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
              : [],
          createdAt: new Date(0),
          lastLoginAt: null,
        };
        req.userId = 'user-1';
      }
      next();
    });
    mocks.loggingMiddleware.mockImplementation((_req: any, _res: any, next: () => void) => next());
    mocks.rateLimitMiddleware.mockImplementation((_req: any, _res: any, next: () => void) => next());
    mocks.projectDetectMiddleware.mockImplementation((req: any, _res: any, next: () => void) => {
      req.projectId = req.headers['x-project-id'];
      next();
    });
    mocks.analyzeProjectCommandMiddleware.mockImplementation((_req: any, _res: any, next: () => void) => next());
    mocks.contextInjectMiddleware.mockImplementation(async (req: any, _res: any, next: () => void) => {
      req.contextApplied = true;
      next();
    });
    mocks.createLearningToolsMiddleware.mockImplementation((clientProtocol: string) => {
      return (req: any, _res: any, next: () => void) => {
        if (clientProtocol === 'openai') {
          req.learningToolsInjected = true;
        }
        next();
      };
    });
    mocks.normalizeAnthropicRequestMiddleware.mockImplementation((req: any, _res: any, next: () => void) => {
      req.body = { ...req.body, normalized: true };
      next();
    });
    mocks.proxyToUpstream.mockImplementation(async (req: any, res: any, options?: { clientProtocol?: string }) => {
      res.json({
        clientProtocol: options?.clientProtocol ?? null,
        normalized: !!req.body.normalized,
        contextApplied: !!req.contextApplied,
        learningToolsInjected: !!req.learningToolsInjected,
      });
    });
    mocks.providersRepo.findAll.mockResolvedValue([]);
  });

  it('serves the health endpoint', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/health');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', service: 'intelligent-context', version: '0.1.0' });
    });
  });

  it('filters visible models for scoped users', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([
      {
        id: 'provider-1',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://openai.test',
        shortPrefix: 'OAI',
        models: 'gpt-4.1-mini, gpt-4.1',
        isEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'provider-2',
        name: 'Disabled',
        type: 'openai',
        baseUrl: 'https://disabled.test',
        models: 'ignored-model',
        isEnabled: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/models', {
        headers: { 'x-test-role': 'user', 'x-test-allowed-models': 'gpt-4.1-mini' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        object: 'list',
        data: [
          expect.objectContaining({
            id: 'OAI-gpt-4.1-mini',
            provider_id: 'provider-1',
            provider_name: 'OpenAI',
          }),
        ],
      });
    });
  });

  it('exposes generic provider entries with no configured models for admins', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([
      {
        id: 'provider-1',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://openai.test',
        shortPrefix: 'OAI',
        models: '',
        isEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/models', {
        headers: { 'x-test-role': 'admin' },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        object: 'list',
        data: [
          expect.objectContaining({
            id: 'OAI',
            provider_id: 'provider-1',
          }),
        ],
      });
    });
  });

  it('enriches model entries with api format and token limits for IDE auto-discovery', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([
      {
        id: 'provider-1',
        name: 'DeepSeek',
        type: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        shortPrefix: 'DSK',
        models: 'deepseek-chat',
        isEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'provider-2',
        name: 'Anthropic',
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        shortPrefix: 'ANTH',
        models: 'claude-3-5-sonnet',
        isEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/models', {
        headers: { 'x-test-role': 'admin' },
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as { data: Array<Record<string, unknown>> };

      const deepseek = payload.data.find((entry) => entry.id === 'DSK-deepseek-chat')!;
      expect(deepseek).toMatchObject({
        api_format: 'openai',
        model_id: 'deepseek-chat',
        display_name: 'DeepSeek \u00b7 deepseek-chat',
        provider_type: 'openai',
      });
      expect(deepseek.max_input_tokens).toBeGreaterThan(0);
      expect(deepseek.max_output_tokens).toBeGreaterThan(0);
      expect(deepseek.context_window).toBeGreaterThan(deepseek.max_input_tokens as number);

      const anthropic = payload.data.find((entry) => entry.id === 'ANTH-claude-3-5-sonnet')!;
      expect(anthropic).toMatchObject({
        api_format: 'anthropic',
        model_id: 'claude-3-5-sonnet',
        display_name: 'Anthropic \u00b7 claude-3-5-sonnet',
      });
    });
  });

  it('exposes the same model from two providers under distinct prefixed IDs and labels', async () => {
    // The real-world shape: opencode Go and CommandCode both expose dozens of
    // identically-named models. The user must be able to tell them apart in the
    // model picker, which only works if the display name leads with the provider.
    mocks.providersRepo.findAll.mockResolvedValue([
      {
        id: 'provider-1',
        name: 'opencode Go',
        type: 'openai',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        shortPrefix: 'OCO',
        models: 'deepseek-v4',
        isEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'provider-2',
        name: 'CommandCode (OpenAI)',
        type: 'openai',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        shortPrefix: 'CCO',
        models: 'deepseek-v4',
        isEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/models', {
        headers: { 'x-test-role': 'admin' },
      });

      const payload = (await response.json()) as { data: Array<Record<string, unknown>> };
      const ids = payload.data.map((entry) => entry.id);
      const labels = payload.data.map((entry) => entry.display_name);

      // Distinct, routable IDs.
      expect(ids).toContain('OCO-deepseek-v4');
      expect(ids).toContain('CCO-deepseek-v4');
      expect(new Set(ids).size).toBe(ids.length);

      // Distinct, human-readable labels that name the provider.
      expect(labels).toContain('opencode Go \u00b7 deepseek-v4');
      expect(labels).toContain('CommandCode (OpenAI) \u00b7 deepseek-v4');
      expect(new Set(labels).size).toBe(labels.length);

      // Every entry still exposes the raw model so clients can report it.
      for (const entry of payload.data) {
        expect(entry.model_id).toBe('deepseek-v4');
      }
    });
  });

  it('returns a configuration error for chat completions when no providers are enabled', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [] }),
      });

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: { message: 'api.error.noProvidersConfigured', type: 'configuration_error' },
      });
    });

    expect(mocks.proxyToUpstream).not.toHaveBeenCalled();
  });

  it('normalizes anthropic requests before proxying them upstream', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([
      { id: 'provider-1', isEnabled: true, models: 'claude-sonnet', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-project-id': 'project-1' },
        body: JSON.stringify({ model: 'claude', messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        clientProtocol: 'anthropic',
        normalized: true,
        contextApplied: true,
        learningToolsInjected: false,
      });
    });

    expect(mocks.normalizeAnthropicRequestMiddleware).toHaveBeenCalledTimes(1);
    expect(mocks.contextInjectMiddleware).toHaveBeenCalledTimes(1);
  });

  it('injects learning tools on OpenAI chat-completions requests', async () => {
    mocks.providersRepo.findAll.mockResolvedValue([
      { id: 'provider-1', isEnabled: true, models: 'gpt-4.1-mini', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-project-id': 'project-1' },
        body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        clientProtocol: 'openai',
        normalized: false,
        contextApplied: true,
        learningToolsInjected: true,
      });
    });

    expect(mocks.createLearningToolsMiddleware).toHaveBeenCalledWith('openai');
  });

  it('proxies legacy completions directly without a client-protocol override', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/v1/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        clientProtocol: null,
        normalized: false,
        contextApplied: false,
        learningToolsInjected: false,
      });
    });
  });
});