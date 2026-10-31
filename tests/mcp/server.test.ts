import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PublicUser } from '../../src/db/repositories/users';

const mocks = vi.hoisted(() => ({
  executeLearningTool: vi.fn(),
  projectsRepo: {
    findAllForUser: vi.fn(),
    findById: vi.fn(),
    findDefault: vi.fn(),
  },
  projectMembersRepo: {
    canAccessProject: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/proxy/tools/executor', () => ({
  executeLearningTool: mocks.executeLearningTool,
}));

vi.mock('../../src/db/repositories/projects', () => ({
  projectsRepo: mocks.projectsRepo,
}));

vi.mock('../../src/db/repositories/projectMembers', () => ({
  projectMembersRepo: mocks.projectMembersRepo,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import { createIntelligentContextMcpServer } from '../../src/mcp/server';

const USER: PublicUser = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'user',
  isApproved: true,
  isDisabled: false,
  accessAllProjects: false,
  accessAllModels: false,
  allowedModels: [],
  createdAt: new Date(0),
  lastLoginAt: null,
};

function makeProject(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Project ${id}`,
    rootPath: `/repos/${id}`,
    pathPattern: null,
    isDefault: false,
    settings: '{}',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    summarizationLastRun: null,
    analyzerLastRun: null,
    ...overrides,
  };
}

/** Connect a client to a freshly built server over the in-memory transport. */
async function connectClient() {
  const server = createIntelligentContextMcpServer(USER);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parseToolText(result: { content?: Array<{ type: string; text?: string }> }) {
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

function rawToolText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((part) => part.type === 'text')?.text ?? '';
}

describe('createIntelligentContextMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectsRepo.findAllForUser.mockResolvedValue([makeProject('project-1')]);
    mocks.projectsRepo.findById.mockResolvedValue(makeProject('project-1'));
    mocks.projectsRepo.findDefault.mockResolvedValue(makeProject('project-1'));
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(true);
    mocks.executeLearningTool.mockResolvedValue({ success: true, result: { ok: true } });
  });

  it('advertises the expected tools and value-framed descriptions', async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();

    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        'create_chunk',
        'create_summary',
        'get_chunk',
        'get_summary',
        'list_categories',
        'list_projects',
        'record_learning',
        'search_knowledge',
        'search_project_context',
        'update_chunk',
        'update_summary',
      ].sort(),
    );

    const record = tools.find((tool) => tool.name === 'record_learning');
    expect(record?.description).toMatch(/future sessions/i);
    expect(record?.description).toMatch(/expects you to record/i);

    const search = tools.find((tool) => tool.name === 'search_project_context');
    expect(search?.description).toMatch(/BEFORE reading source files/i);
  });

  it('lists accessible projects with the default project id', async () => {
    mocks.projectsRepo.findAllForUser.mockResolvedValue([
      makeProject('project-1', { isDefault: true }),
      makeProject('project-2'),
    ]);
    mocks.projectsRepo.findDefault.mockResolvedValue(makeProject('project-1', { isDefault: true }));

    const { client } = await connectClient();
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    const body = parseToolText(result);

    expect(body.projects.map((project: { id: string }) => project.id)).toEqual(['project-1', 'project-2']);
    expect(body.defaultProjectId).toBe('project-1');
  });

  it('runs context selection for search_project_context', async () => {
    mocks.executeLearningTool.mockResolvedValue({
      success: true,
      result: { candidateCount: 2, candidates: [] },
    });

    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'search_project_context',
      arguments: { projectId: 'project-1', query: 'how does auth work', includeBlocks: true },
    });

    expect(parseToolText(result).candidateCount).toBe(2);
    expect(mocks.executeLearningTool).toHaveBeenCalledWith(
      'ic_select_context',
      { text: 'how does auth work', includeBlocks: true },
      { projectId: 'project-1', sessionId: 'mcp' },
    );
  });

  it('maps search_knowledge arguments onto ic_search', async () => {
    const { client } = await connectClient();
    await client.callTool({
      name: 'search_knowledge',
      arguments: { projectId: 'project-1', query: 'claim', regex: true, scope: ['chunks'] },
    });

    expect(mocks.executeLearningTool).toHaveBeenCalledWith(
      'ic_search',
      { query: 'claim', regex: true, scope: ['chunks'] },
      { projectId: 'project-1', sessionId: 'mcp' },
    );
  });

  it('records learnings through the record_learning tool', async () => {
    const { client } = await connectClient();
    await client.callTool({
      name: 'record_learning',
      arguments: {
        projectId: 'project-1',
        learnings: [{ fact: 'Auth uses bearer tokens.', category: 'auth' }],
      },
    });

    expect(mocks.executeLearningTool).toHaveBeenCalledWith(
      'record_learning',
      { learnings: [{ fact: 'Auth uses bearer tokens.', category: 'auth' }] },
      { projectId: 'project-1', sessionId: 'mcp' },
    );
  });

  it('routes create_summary through a single ic op and unwraps the result', async () => {
    mocks.executeLearningTool.mockResolvedValue({
      success: true,
      result: { ops: [{ action: 'create', type: 'summary', success: true, result: { id: 's1' } }] },
    });

    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'create_summary',
      arguments: { projectId: 'project-1', title: 'Auth', content: 'Auth summary body.' },
    });

    expect(parseToolText(result)).toEqual({ id: 's1' });
    const [toolName, params] = mocks.executeLearningTool.mock.calls[0];
    expect(toolName).toBe('ic');
    expect(params.ops[0]).toMatchObject({ action: 'create', type: 'summary' });
    expect(params.ops[0].data).toMatchObject({ title: 'Auth', content: 'Auth summary body.' });
  });

  it('falls back to the default project when projectId is omitted', async () => {
    const { client } = await connectClient();
    await client.callTool({ name: 'list_categories', arguments: {} });

    expect(mocks.executeLearningTool).toHaveBeenCalledWith(
      'ic_list_categories',
      {},
      { projectId: 'project-1', sessionId: 'mcp' },
    );
  });

  it('rejects a project the caller cannot access', async () => {
    mocks.projectMembersRepo.canAccessProject.mockResolvedValue(false);

    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'get_summary',
      arguments: { projectId: 'project-9', summaryId: 's1' },
    });

    expect(result.isError).toBe(true);
    expect(rawToolText(result)).toMatch(/list_projects/);
    expect(mocks.executeLearningTool).not.toHaveBeenCalled();
  });

  it('surfaces executor failures as tool errors', async () => {
    mocks.executeLearningTool.mockResolvedValue({
      success: false,
      result: null,
      error: 'chunk not found',
    });

    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'get_chunk',
      arguments: { projectId: 'project-1', chunkId: 'missing' },
    });

    expect(result.isError).toBe(true);
    expect(rawToolText(result)).toBe('chunk not found');
  });
});
