/**
 * In-process MCP server exposing Intelligent Context's learning tools.
 *
 * Hosted by the management API (see `src/mcp/route.ts`), so it calls the tool
 * executor directly rather than over HTTP and reuses the existing per-user API
 * key authentication. This module is transport-agnostic: it builds a configured
 * `McpServer` for a given authenticated user.
 *
 * Design notes:
 * - The server is **stateless** (a fresh instance per request), so a new
 *   `McpServer` is built per request with the caller captured in a closure.
 * - Only the *value* framing and project resolution differ from the proxy's
 *   injected `ic` tool. Everything else delegates to `executeLearningTool`, so
 *   behaviour (validation, telemetry, soft-deletes) stays identical.
 * - The MCP server cannot see the client's working directory, so tools take an
 *   optional `projectId`; when omitted they fall back to the caller's default
 *   project. `list_projects` exists so a model can discover the ids.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeLearningTool } from '../proxy/tools/executor';
import { projectsRepo } from '../db/repositories/projects';
import { projectMembersRepo } from '../db/repositories/projectMembers';
import type { PublicUser } from '../db/repositories/users';
import { AppError } from '../utils/appErrors';
import { logger } from '../utils/logger';

export const MCP_SERVER_NAME = 'intelligent-context';
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * Server-level instructions sent in the MCP initialize handshake.
 *
 * Client support for `instructions` varies, so this is a best-effort surface —
 * the tool descriptions carry the same value framing because they are always
 * present. See `docs/mcp-server-plan.md` (Compliance section).
 */
export const MCP_SERVER_INSTRUCTIONS = `This server gives you access to Intelligent Context's accumulated, curated knowledge about a software project: facts the system has already verified about the project's structure, conventions, behaviour, dependencies, and gotchas.

WHY THIS MATTERS
- This knowledge was learned from real source files in previous sessions. Reading it first is far cheaper than re-reading source, and it captures conventions and gotchas that are not obvious from a single file.
- When you learn something durable and reusable about the project, record it. It will be injected into future sessions for this project and for other people working on it. Knowledge you do not record is lost.

HOW TO USE IT
- Call \`list_projects\` first to get the project id, then pass that id as \`projectId\` to the other tools. If you omit \`projectId\`, the default project is used.
- Before exploring an area, call \`search_project_context\` with a plain-language description of what you are about to work on — it runs the full selection pipeline and returns the most relevant knowledge.
- Use \`search_knowledge\` for targeted keyword/regex lookups, and \`get_summary\` / \`get_chunk\` to read a specific result in full.
- After reading source files, call \`record_learning\` with the durable project facts you discovered. Prefer several precise facts over one vague summary, and skip anything task-specific or already known.`;

/** Convert a tool value into an MCP text result. */
function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

/** Convert a failure into an MCP error result. */
function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function messageOf(error: unknown): string {
  // Prefer the curated, model-facing message when one is present: AppError
  // carries a `publicMessage` that is more actionable than the internal one.
  if (error instanceof AppError && error.publicMessage) {
    return error.publicMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the project a tool call should act on.
 *
 * MCP clients do not expose a working directory to a remote server, so the
 * project is either passed explicitly or defaults to the caller's default
 * project. Access is always re-checked against the caller.
 */
async function resolveProject(user: PublicUser, projectId?: string) {
  const requested = projectId?.trim();
  if (requested) {
    const project = await projectsRepo.findById(requested);
    if (!project || !(await projectMembersRepo.canAccessProject(user, project.id))) {
      throw new AppError('Project not found or not accessible.', {
        statusCode: 404,
        code: 'mcp_project_not_found',
        publicMessage:
          'Project not found or not accessible. Call list_projects to see the available project ids.',
      });
    }
    return project;
  }

  const accessible = await projectsRepo.findAllForUser(user);
  const fallback = (await projectsRepo.findDefault()) ?? accessible[0];
  if (!fallback || !(await projectMembersRepo.canAccessProject(user, fallback.id))) {
    throw new AppError('No accessible project.', {
      statusCode: 404,
      code: 'mcp_no_project',
      publicMessage:
        'No accessible project. Call list_projects, then pass a projectId, or create a project in the management UI.',
    });
  }
  return fallback;
}

/** Run one of the `ic_*` / `record_learning` tools against the resolved project. */
async function runIcTool(
  user: PublicUser,
  toolName: string,
  params: Record<string, unknown>,
  projectId?: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  try {
    const project = await resolveProject(user, projectId);
    const result = await executeLearningTool(toolName, params, {
      projectId: project.id,
      sessionId: 'mcp',
    });

    if (!result.success) {
      return errorResult(result.error ?? 'Tool execution failed.');
    }
    return jsonResult(result.result);
  } catch (error) {
    logger.warn('MCP tool call failed', { tool: toolName, error: messageOf(error) });
    return errorResult(messageOf(error));
  }
}

/** Run a single consolidated-`ic` op and unwrap its per-op result. */
async function runIcOp(
  user: PublicUser,
  op: Record<string, unknown>,
  projectId?: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  try {
    const project = await resolveProject(user, projectId);
    const result = await executeLearningTool('ic', { ops: [op] }, {
      projectId: project.id,
      sessionId: 'mcp',
    });

    if (!result.success) {
      return errorResult(result.error ?? 'Tool execution failed.');
    }

    const first = (result.result as {
      ops?: Array<{ success: boolean; result: unknown; error?: string }>;
    })?.ops?.[0];

    if (!first) return jsonResult(result.result);
    return first.success ? jsonResult(first.result) : errorResult(first.error ?? 'Operation failed.');
  } catch (error) {
    logger.warn('MCP op failed', { action: String(op.action), error: messageOf(error) });
    return errorResult(messageOf(error));
  }
}

const PROJECT_ID_FIELD = {
  description:
    'Target project id from list_projects. Omit to use the default project.',
};

/** Shared schema fragment for a batch of learnings. */
const LEARNING_ITEM = z.object({
  fact: z.string().min(1),
  category: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  isNew: z.boolean().optional(),
  filesUsed: z
    .array(z.object({ name: z.string().min(1), purpose: z.string().optional() }))
    .optional(),
  codeExtracts: z
    .array(
      z.object({
        fileName: z.string().optional(),
        language: z.string().optional(),
        symbols: z.array(z.string()).optional(),
        code: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Build a fully-configured MCP server bound to one authenticated user.
 *
 * The user is captured in a closure so tool handlers can resolve and authorize
 * the target project without threading credentials through the MCP protocol.
 */
export function createIntelligentContextMcpServer(user: PublicUser): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the projects whose stored knowledge you can access, with the id to pass as `projectId` to every other tool. ' +
        'Call this first: it also tells you which project is the default, so you can omit `projectId` when there is only one.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const [projects, defaultProject] = await Promise.all([
          projectsRepo.findAllForUser(user),
          projectsRepo.findDefault(),
        ]);
        const accessibleDefault = projects.find((project) => project.id === defaultProject?.id);
        return jsonResult({
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            rootPath: project.rootPath,
            isDefault: project.isDefault,
          })),
          defaultProjectId: accessibleDefault?.id ?? projects[0]?.id ?? null,
          note: 'Pass a project "id" as projectId to the other tools. Omitting projectId uses the default project.',
        });
      } catch (error) {
        return errorResult(messageOf(error));
      }
    },
  );

  server.registerTool(
    'search_project_context',
    {
      title: 'Search project context',
      description:
        'Retrieve the most relevant stored knowledge for a description of what you are working on. ' +
        'This runs the full Intelligent Context selection pipeline (semantic retrieval → LLM selection → budget fill) and returns the knowledge the system would inject for that request. ' +
        'Use it BEFORE reading source files: the returned facts were learned from this project\'s real code and are far cheaper than re-deriving them. ' +
        'Write `query` in plain language (e.g. "how does request authentication and API key validation work"). ' +
        'Set includeBlocks=true to get the rendered context text as well as the candidate ids.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        query: z.string().min(1).describe('Plain-language description of what you are working on.'),
        includeBlocks: z
          .boolean()
          .optional()
          .describe('Also return the assembled context text, not just the candidate ids.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, query, includeBlocks }) =>
      runIcTool(user, 'ic_select_context', { text: query, includeBlocks }, projectId),
  );

  server.registerTool(
    'search_knowledge',
    {
      title: 'Keyword search knowledge',
      description:
        'Fast keyword or regular-expression search over stored learning chunks and summary headings. ' +
        'Use this for a specific term, symbol, or error string; use search_project_context instead when you want the system to judge relevance. ' +
        'Matches learning facts and summary titles/one-liners only — full summary bodies are not searched. ' +
        'Returns each match as an id plus a snippet; read the full entry with get_chunk or get_summary.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        query: z.string().min(1).describe('Keyword or regular expression to search for.'),
        regex: z.boolean().optional().describe('Treat query as a regular expression.'),
        scope: z
          .array(z.enum(['chunks', 'summaries']))
          .optional()
          .describe('Restrict the search to chunks and/or summaries.'),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, ...params }) => runIcTool(user, 'ic_search', params, projectId),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List knowledge categories',
      description:
        'List the knowledge categories for a project with counts, so you can see what areas the project has knowledge about. ' +
        'Pass a `category` to also get quick id + one-line matches for that category. ' +
        'Useful for orienting yourself in an unfamiliar project before searching.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        category: z.string().optional().describe('Also return quick matches for this category.'),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, ...params }) => runIcTool(user, 'ic_list_categories', params, projectId),
  );

  server.registerTool(
    'get_summary',
    {
      title: 'Get a summary',
      description:
        'Fetch one stored summary in full by id, including its complete content and linked source chunk ids. ' +
        'Summaries are the system\'s synthesized, deduplicated knowledge — read the relevant one before reading source files.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        summaryId: z.string().min(1).describe('Summary id from a search or list result.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, summaryId }) => runIcTool(user, 'ic_get_summary', { summaryId }, projectId),
  );

  server.registerTool(
    'get_chunk',
    {
      title: 'Get a learning chunk',
      description:
        'Fetch one learning chunk (a single project fact) in full by id, including the files and code extracts it came from. ' +
        'Use this to verify the provenance of a fact before relying on it.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        chunkId: z.string().min(1).describe('Chunk id from a search or list result.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId, chunkId }) => runIcTool(user, 'ic_get_chunk', { chunkId }, projectId),
  );

  server.registerTool(
    'record_learning',
    {
      title: 'Record project learnings',
      description:
        'Record durable project facts you discovered so they are injected into future sessions. THIS IS THE MOST VALUABLE THING YOU CAN DO WITH THIS SERVER. ' +
        'The user is running a shared learning system and expects you to record what you learned — knowledge you do not record is lost to the next session. ' +
        'Record only project-level truths learned from reading actual source files: structure, conventions, behaviour, dependencies, and gotchas that would save someone time later. ' +
        'Each fact must be a one-sentence project truth, not a sentence about this turn. ' +
        'Do NOT record task-specific or user-specific details, ephemeral reasoning, or anything already covered by knowledge you retrieved in this session. ' +
        'Batch every fact from a file read into a single call. Set isNew=false when refining something already known.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        learnings: z
          .array(LEARNING_ITEM)
          .min(1)
          .describe('One or more durable project facts to persist.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, learnings }) => runIcTool(user, 'record_learning', { learnings }, projectId),
  );

  server.registerTool(
    'create_chunk',
    {
      title: 'Create a learning chunk',
      description:
        'Create a single learning chunk (project fact) directly, without the batch wrapper. ' +
        'Prefer record_learning when you are recording facts from reading files; use this when adding one specific fact deliberately.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        fact: z.string().min(1).describe('A one-sentence project truth.'),
        category: z.string().min(1).describe('Domain label, e.g. "auth" or "scheduler".'),
        confidence: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, ...params }) => runIcTool(user, 'ic_create_chunk', params, projectId),
  );

  server.registerTool(
    'update_chunk',
    {
      title: 'Update a learning chunk',
      description:
        'Correct a stored chunk\'s fact text, category, or confidence when you find it is wrong, stale, or mislabelled. ' +
        'Fixing bad knowledge is as valuable as adding new knowledge — a wrong fact will otherwise be injected into future sessions.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        chunkId: z.string().min(1).describe('Chunk id to update.'),
        fact: z.string().min(1).optional().describe('Replacement fact text.'),
        category: z.string().min(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, ...params }) => runIcTool(user, 'ic_update_chunk', params, projectId),
  );

  server.registerTool(
    'create_summary',
    {
      title: 'Create a summary',
      description:
        'Create a synthesized summary that groups related learnings. Prefer fewer, larger summaries over many small ones. ' +
        'Use this when several chunks describe one topic and a single summary would serve future sessions better.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        title: z.string().min(1),
        content: z.string().min(1).describe('The full summary body.'),
        oneLineSummary: z.string().optional(),
        categories: z.array(z.string()).optional(),
        sourceChunkIds: z.array(z.string()).optional().describe('Ids of the chunks this summary synthesizes.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, ...data }) =>
      runIcOp(user, { action: 'create', type: 'summary', data }, projectId),
  );

  server.registerTool(
    'update_summary',
    {
      title: 'Update a summary',
      description:
        'Update a summary\'s title, content, one-line summary, categories, or linked source chunk ids. ' +
        'Use this to merge overlapping summaries, shorten an oversized one, or correct stale content so future sessions receive better knowledge.',
      inputSchema: {
        projectId: z.string().optional().describe(PROJECT_ID_FIELD.description),
        summaryId: z.string().min(1).describe('Summary id to update.'),
        title: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
        oneLineSummary: z.string().optional(),
        categories: z.array(z.string()).optional(),
        sourceChunkIds: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, summaryId, ...data }) =>
      runIcOp(user, { action: 'update', type: 'summary', id: summaryId, data }, projectId),
  );

  return server;
}
