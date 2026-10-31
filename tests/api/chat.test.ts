import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestServer } from '../helpers/http';

const mocks = vi.hoisted(() => ({
  runChatTurn: vi.fn(),
  runChatTurnStream: vi.fn(),
  projectsRepo: {
    findById: vi.fn(),
  },
  summariesRepo: {
    findByProject: vi.fn(),
  },
  findingsRepo: {
    findByProject: vi.fn(),
  },
  filesRepo: {
    findByProject: vi.fn(),
  },
  providersRepo: {
    findAll: vi.fn(),
  },
  getSystemModelConfig: vi.fn(),
  formatZodError: vi.fn(() => 'validation.error'),
}));

vi.mock('../../src/chat/chatService', () => ({
  runChatTurn: mocks.runChatTurn,
  runChatTurnStream: mocks.runChatTurnStream,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/db/repositories/summaries', () => ({
  summariesRepo: mocks.summariesRepo,
}));

vi.mock('../../src/db/repositories/findings', () => ({
  findingsRepo: mocks.findingsRepo,
}));

vi.mock('../../src/db/repositories/files', () => ({
  filesRepo: mocks.filesRepo,
}));

vi.mock('../../src/config/systemModels', () => ({
  getSystemModelConfig: mocks.getSystemModelConfig,
}));

vi.mock('../../src/db/repositories/providers', () => ({
  providersRepo: mocks.providersRepo,
}));

vi.mock('../../src/i18n', () => ({
  formatZodError: mocks.formatZodError,
}));

import { createChatRouter } from '../../src/api/routes/chat';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/projects/:id/chat', createChatRouter());
  return app;
}

describe('createChatRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectsRepo.findById.mockResolvedValue({ id: 'project-1', name: 'Project One' });
    mocks.getSystemModelConfig.mockReturnValue({ chat: 'gpt-4.1', icTools: '' });
    mocks.summariesRepo.findByProject.mockResolvedValue([]);
    mocks.findingsRepo.findByProject.mockResolvedValue([]);
    mocks.filesRepo.findByProject.mockResolvedValue([]);
    mocks.providersRepo.findAll.mockResolvedValue([
      {
        id: 'provider-1',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        models: 'gpt-4.1',
        isEnabled: true,
        isDefault: false,
        shortPrefix: 'OAI',
        externalProviderId: null,
        createdAt: new Date(0),
      },
    ]);
    mocks.runChatTurn.mockResolvedValue({
      content: 'Auth uses signed tokens.',
      model: 'gpt-4.1',
      providerName: 'Example',
      internalTurnCount: 1,
    });
    mocks.runChatTurnStream.mockImplementation(async (_options, emit) => {
      emit({ type: 'delta', content: 'Auth uses signed tokens.' });
      emit({ type: 'done', model: 'gpt-4.1', providerName: 'Example', internalTurnCount: 1 });
    });
  });

  it('reports whether a chat model is configured', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat/status');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ configured: true, model: 'gpt-4.1' });
    });
  });

  it('lists knowledge entities available for attachment', async () => {
    mocks.summariesRepo.findByProject.mockResolvedValue([
      { id: 'sum-1', title: 'Auth summary', oneLineSummary: 'Tokens', updatedAt: '2026-01-01' },
    ]);
    mocks.findingsRepo.findByProject.mockResolvedValue([
      { id: 'find-1', title: 'Dup summaries', type: 'refactor', severity: 'medium', status: 'open' },
    ]);
    mocks.filesRepo.findByProject.mockResolvedValue([
      { id: 'file-1', fileName: 'src/auth.ts', purpose: 'Auth', chunkCount: 2, summaryCount: 1 },
    ]);

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat/context-options');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        summaries: [{ id: 'sum-1', title: 'Auth summary', oneLineSummary: 'Tokens', updatedAt: '2026-01-01' }],
        findings: [{ id: 'find-1', title: 'Dup summaries', type: 'refactor', severity: 'medium', status: 'open' }],
        files: [{ id: 'file-1', fileName: 'src/auth.ts', purpose: 'Auth', chunkCount: 2, summaryCount: 1 }],
      });
    });
  });

  it('lists the models the caller may chat with, plus a usable default', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat/models');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        models: [{ value: 'OAI-gpt-4.1', label: 'OpenAI \u00b7 gpt-4.1', providerId: 'provider-1', providerName: 'OpenAI' }],
        defaultModel: 'OAI-gpt-4.1',
      });
    });
  });

  it('omits the default when the configured model is not in the list', async () => {
    mocks.getSystemModelConfig.mockReturnValue({ chat: 'SECRET-gpt-5', icTools: '' });

    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat/models');
      const body = await response.json();
      expect(body.defaultModel).toBe('');
    });
  });

  it('rejects an empty message list', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(response.status).toBe(400);
      expect(mocks.runChatTurn).not.toHaveBeenCalled();
    });
  });

  it('runs a chat turn scoped to the project', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'How does auth work?' }] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ content: 'Auth uses signed tokens.' });
      expect(mocks.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-1',
        messages: [{ role: 'user', content: 'How does auth work?', attachments: undefined, knowledge: undefined }],
      }));
    });
  });

  it('passes attachments, knowledge refs, and a model override to the service', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      await request('/projects/project-1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'OAI-gpt-4.1',
          messages: [{
            role: 'user',
            content: 'Review',
            attachments: [{ name: 'notes.txt', mimeType: 'text/plain', text: 'hi' }],
            knowledge: [{ type: 'summary', id: 'sum-1' }],
          }],
        }),
      });

      expect(mocks.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
        model: 'OAI-gpt-4.1',
        messages: [{
          role: 'user',
          content: 'Review',
          attachments: [{ name: 'notes.txt', mimeType: 'text/plain', text: 'hi' }],
          knowledge: [{ type: 'summary', id: 'sum-1' }],
        }],
      }));
    });
  });

  it('streams a chat turn as server-sent events', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const text = await response.text();
      expect(text).toContain('"type":"delta"');
      expect(text).toContain('"type":"done"');
      expect(text).toContain('data: [DONE]');
      expect(mocks.runChatTurnStream).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects a stream request with no messages', async () => {
    await withTestServer(createApp(), async ({ request }) => {
      const response = await request('/projects/project-1/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      expect(response.status).toBe(400);
      expect(mocks.runChatTurnStream).not.toHaveBeenCalled();
    });
  });
});
