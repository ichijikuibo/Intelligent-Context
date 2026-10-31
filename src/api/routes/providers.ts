import { Router } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { providersRepo } from '../../db/repositories/providers';
import { formatZodError, t } from '../../i18n';
import { openaiAdapter } from '../../proxy/adapters/openai';
import { anthropicAdapter } from '../../proxy/adapters/anthropic';
import type { ProxyRequest } from '../../proxy/adapters/adapter';
import { formatUpstreamErrorMessage } from '../../proxy/errorMessage';
import { applyUpstreamRequestMiddleware } from '../../proxy/requestMiddleware';
import { withParamFallback } from '../../utils/paramFallback';

const ProviderShortPrefixSchema = z.union([
  z.literal(''),
  z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{1,15}-?$/, {
    message: 'Short prefix must be 2-16 letters or numbers and may optionally end with a hyphen',
  }),
]);

const CreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['openai', 'anthropic'], {
    message: 'type must be "openai" or "anthropic"',
  }),
  baseUrl: z.string().url('Must be a valid URL'),
  apiKey: z.string().min(1, 'API key is required'),
  shortPrefix: ProviderShortPrefixSchema.optional(),
  models: z.string().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  /** Pass empty string to keep the existing key unchanged */
  apiKey: z.string().optional(),
  shortPrefix: ProviderShortPrefixSchema.optional(),
  models: z.string().optional(),
  isEnabled: z.boolean().optional(),
});

function maskProvider(p: { apiKey: string; [key: string]: any } | null | undefined) {
  if (!p) return null;
  return { ...p, apiKey: providersRepo.maskKey(p.apiKey as string) };
}

export function createProvidersRouter(): Router {
  const router = Router();

  // List all providers (keys masked). Exclude providers managed by an
  // external provider — they appear under External Providers instead.
  router.get('/', async (_req, res) => {
    const all = await providersRepo.findAll();
    const manual = all.filter((p) => !p.externalProviderId);
    res.json(manual.map(maskProvider));
  });

  // Create a provider
  router.post('/', async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }
    const provider = await providersRepo.insert(parsed.data);
    res.status(201).json(maskProvider(provider));
  });

  // Get one provider (key masked)
  router.get('/:id', async (req, res) => {
    const provider = await providersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }
    res.json(maskProvider(provider));
  });

  // Update provider (apiKey stays unchanged if omitted or empty)
  router.put('/:id', async (req, res) => {
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }
    const existing = await providersRepo.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }
    const updated = await providersRepo.update(req.params.id, parsed.data);
    res.json(maskProvider(updated));
  });

  // Set as default for its type
  router.post('/:id/set-default', async (req, res) => {
    const provider = await providersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }
    await providersRepo.setDefault(req.params.id);
    res.json({ ok: true });
  });

  // Test connection with raw params (no saved provider needed — used by the add form)
  router.post('/test-connection', async (req, res) => {
    const { type, baseUrl, apiKey, models } = req.body ?? {};
    if (!type || !baseUrl) {
      res.status(400).json({ error: t(req, 'api.error.typeAndBaseUrlRequired') });
      return;
    }
    if (!['openai', 'anthropic'].includes(type)) {
      res.status(400).json({ error: t(req, 'api.error.invalidProviderType') });
      return;
    }

    const adapter = type === 'anthropic' ? anthropicAdapter : openaiAdapter;

    try {
      const url = adapter.endpoint(baseUrl);
      const headers = applyUpstreamRequestMiddleware(url, adapter.headers(apiKey || 'none'), {
        jobKey: 'provider-test',
      });
      // Use the first model from the user's list; fall back to a sensible default per type
      const modelList = (models as string || '').split(',').map((m: string) => m.trim()).filter((m: string) => m.length > 0);
      const testModel = modelList[0] || (type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini');
      const request: ProxyRequest = {
        model: testModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
      const requestId = `provider-test-adhoc-${Date.now()}`;

      const start = Date.now();
      await withParamFallback(
        request,
        adapter,
        {
          requestId,
          model: testModel,
          providerName: 'provider-test-connection',
          providerType: type,
          url,
          requestHeaders: headers,
        },
        async (payload) => axios.post(url, payload, {
          headers,
          timeout: 15_000,
        }),
      );
      const latencyMs = Date.now() - start;

      res.json({ ok: true, latencyMs });
    } catch (err) {
      const status = axios.isAxiosError(err) ? (err.response?.status ?? 0) : 0;
      const message = formatUpstreamErrorMessage(err);

      if (status >= 400 && status < 500) {
        res.json({ ok: false, error: t(req, 'api.error.credentialsRejected', { status }) });
      } else {
        res.json({ ok: false, error: message });
      }
    }
  });

  // Test saved provider by ID
  router.post('/:id/test', async (req, res) => {
    const provider = await providersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }

    const adapter = provider.type === 'anthropic' ? anthropicAdapter : openaiAdapter;

    try {
      // Send a minimal request to verify connectivity
      const url = adapter.endpoint(provider.baseUrl);
      const headers = applyUpstreamRequestMiddleware(url, adapter.headers(provider.apiKey), {
        jobKey: `provider-test:${provider.id}`,
      });
      // Use the provider's first model; fall back to a sensible default per type
      const modelList = (provider.models || '').split(',').map((m) => m.trim()).filter((m) => m.length > 0);
      const testModel = modelList[0] || (provider.type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini');
      const request: ProxyRequest = {
        model: testModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
      const requestId = `provider-test-${provider.id}-${Date.now()}`;

      const start = Date.now();
      await withParamFallback(
        request,
        adapter,
        {
          requestId,
          model: testModel,
          providerName: provider.name,
          providerType: provider.type,
          url,
          requestHeaders: headers,
        },
        async (payload) => axios.post(url, payload, {
          headers,
          timeout: 15_000,
        }),
      );
      const latencyMs = Date.now() - start;

      res.json({ ok: true, latencyMs });
    } catch (err) {
      const status = axios.isAxiosError(err) ? (err.response?.status ?? 0) : 0;
      const message = formatUpstreamErrorMessage(err);

      // If we got a 4xx back, the connection itself worked but credentials were rejected
      if (status >= 400 && status < 500) {
        res.json({ ok: false, error: t(req, 'api.error.credentialsRejected', { status }) });
      } else {
        res.json({ ok: false, error: message });
      }
    }
  });

  // Delete provider
  router.delete('/:id', async (req, res) => {
    const provider = await providersRepo.findById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: t(req, 'api.error.providerNotFound') });
      return;
    }
    await providersRepo.delete(req.params.id);
    res.status(204).end();
  });

  return router;
}
