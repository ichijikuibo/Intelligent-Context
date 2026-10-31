import type { ClientProtocol } from '../clientProtocols';

interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface OpenAiFunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
  };
}

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
}

export type LearningToolDefinition = OpenAiFunctionToolDefinition | AnthropicToolDefinition;

const FINDING_TYPES = ['security', 'refactor', 'contradiction', 'gap', 'positive'] as const;
const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const FINDING_STATUSES = ['open', 'accepted', 'dismissed', 'implemented', 'actioned', 'false'] as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): JsonSchemaObject {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

function openAiTool(
  name: string,
  description: string,
  parameters: JsonSchemaObject
): OpenAiFunctionToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters,
    },
  };
}

// ── Single consolidated `ic` tool description (YAML format) ──
// YAML is more token-efficient than prose for structured instructions,
// and models understand it as well as JSON for tool-guidance text.
const IC_TOOL_YAML_DESCRIPTION = `ic - Unified IC knowledge operations - this tool should not be called along with other types of tools in a single request.
action: get list create update delete record
type:   chunk summary finding file

get      {ids:[id] or id}             -> entity/entities
list     {data:{search,category,limit(20),offset(0)}} -> {total,items}
create   {data:{fact,category,confidence?,source?}}   -> entity
update   {id,data:{field:value,...}}  -> entity
delete   {id}                          -> {deleted:true}
record   {data:{learnings:[{fact,category,confidence,isNew}]}} -> results

Specialised retrieval tools (call separately, not inside ops):
- ic_list_categories: {category?,limit?,offset?} -> category list + counts, and (id+summary-only) matches for one category
- ic_search: {query,regex?,scope?,limit?,offset?} -> keyword/regex over chunk facts + summary headings (id + snippet only)
- ic_select_context: {text,model?,includeBlocks?} -> runs full context selection for a phrase and returns the selected context`;

const IC_TOOL_SCHEMA = objectSchema({
  ops: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string' },
        type: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' } },
        id: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['action'],
    },
    minItems: 1,
    maxItems: 10,
  },
}, ['ops']);

const OPENAI_IC_LEGACY_TOOLS: OpenAiFunctionToolDefinition[] = [
  openAiTool(
    'ic_list_chunks',
    'List learning chunks for the current project with optional filtering and pagination.',
    objectSchema({
      category: { type: 'string' },
      minConfidence: { type: 'number', minimum: 0, maximum: 1 },
      summarized: { type: 'boolean' },
      search: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    })
  ),
  openAiTool(
    'ic_list_summaries',
    'List summaries for the current project with optional filtering and pagination.',
    objectSchema({
      category: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    })
  ),
  openAiTool(
    'ic_list_findings',
    'List analysis findings for the current project with optional filtering and pagination.',
    objectSchema({
      type: { type: 'string', enum: [...FINDING_TYPES] },
      severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
      status: { type: 'string', enum: [...FINDING_STATUSES] },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    })
  ),
  openAiTool(
    'ic_list_files',
    'List indexed files learned for the current project with optional search and pagination.',
    objectSchema({
      search: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    })
  ),
  openAiTool(
    'ic_list_categories',
    'List the knowledge categories for the current project (both unsummarized chunk categories and summary category tags) with counts. Pass a "category" to also get quick matches — unsummarized chunks and summaries in that category as id + one-line summary only. Use ic_get_chunk / ic_get_summary to fetch full content for a match.',
    objectSchema({
      category: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    })
  ),
  openAiTool(
    'ic_search',
    [
      'Search stored knowledge by keyword or regular expression.',
      'Matches against learning chunk facts and summary titles / one-line summaries only — full summary bodies are never searched so results stay focused.',
      'Returns each match as an id plus a short snippet; fetch full detail with ic_get_chunk / ic_get_summary.',
    ].join(' '),
    objectSchema({
      query: { type: 'string', minLength: 1 },
      regex: { type: 'boolean', default: false },
      scope: {
        type: 'array',
        items: { type: 'string', enum: ['chunks', 'summaries'] },
        maxItems: 2,
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    }, ['query'])
  ),
  openAiTool(
    'ic_select_context',
    [
      'Run the full Intelligent Context selection pipeline against a free-text phrase and return the knowledge it selects.',
      'This always runs LLM-based context selection regardless of the client\'s configured request-context mode, using the dedicated ic-tools model (falling back to the context selector model).',
      'By default it returns the selected ids and metadata; set includeBlocks=true to also return the assembled context text.',
    ].join(' '),
    objectSchema({
      text: { type: 'string', minLength: 1 },
      model: { type: 'string' },
      includeBlocks: { type: 'boolean', default: false },
    }, ['text'])
  ),
  openAiTool(
    'ic_get_chunks_by_category',
    'Get chunk details for a single category so the model can inspect the facts behind a summary type.',
    objectSchema({
      category: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    }, ['category'])
  ),
  openAiTool(
    'ic_get_chunk',
    'Get a single learning chunk with linked files and code extracts.',
    objectSchema({
      chunkId: { type: 'string' },
    }, ['chunkId'])
  ),
  openAiTool(
    'ic_get_summary',
    'Get a single summary with its full content.',
    objectSchema({
      summaryId: { type: 'string' },
    }, ['summaryId'])
  ),
  openAiTool(
    'ic_get_file_info',
    'Get metadata and linked knowledge for an indexed file by fileId or fileName. Returns file metadata, purpose, chunk/summary counts, and the IDs of linked summaries and chunks. Does NOT return raw file contents �� use IDE tools (read_file, grep_search) to read actual source files.',
    objectSchema({
      fileId: { type: 'string' },
      fileName: { type: 'string' },
    })
  ),
  openAiTool(
    'ic_get_finding',
    'Get a single finding with actions and related IDs.',
    objectSchema({
      findingId: { type: 'string' },
    }, ['findingId'])
  ),
  openAiTool(
    'ic_get_chunks',
    'Get multiple learning chunks by ID. Each chunk includes linked files and code extracts.',
    objectSchema({
      chunkIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50,
      },
    }, ['chunkIds'])
  ),
  openAiTool(
    'ic_get_summaries',
    'Get multiple summaries by ID with their full content.',
    objectSchema({
      summaryIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50,
      },
    }, ['summaryIds'])
  ),
  openAiTool(
    'ic_get_file_chunks',
    'Get learning chunks (knowledge facts) associated with a file by fileId or fileName. Returns synthesized project knowledge linked to the file, not the file\'s raw source content. Use this to see what the system already knows about a file\'s purpose and behavior.',
    objectSchema({
      fileId: { type: 'string' },
      fileName: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    })
  ),
  openAiTool(
    'ic_get_file_summaries',
    'Get summaries associated with a file by fileId or fileName so the model can inspect file-specific synthesized knowledge. Returns previously generated summaries about the file\'s role in the project, not the file contents themselves.',
    objectSchema({
      fileId: { type: 'string' },
      fileName: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    })
  ),
  openAiTool(
    'ic_get_findings',
    'Get multiple findings by ID with actions and related IDs.',
    objectSchema({
      findingIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50,
      },
    }, ['findingIds'])
  ),
  openAiTool(
    'ic_update_chunk',
    'Update a learning chunk fact, category, confidence, or any combination of those fields.',
    objectSchema({
      chunkId: { type: 'string' },
      fact: { type: 'string' },
      category: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    }, ['chunkId'])
  ),
  openAiTool(
    'ic_delete_chunk',
    'Soft-delete a learning chunk and cascade the delete to linked files and code extracts.',
    objectSchema({
      chunkId: { type: 'string' },
    }, ['chunkId'])
  ),
  openAiTool(
    'ic_update_summary',
    'Update a summary title, content, one-line summary, categories, and/or linked source chunk IDs.',
    objectSchema({
      summaryId: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
      oneLineSummary: { type: 'string' },
      categories: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 100,
      },
      sourceChunkIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 500,
      },
    }, ['summaryId'])
  ),
  openAiTool(
    'ic_delete_summary',
    'Soft-delete a summary.',
    objectSchema({
      summaryId: { type: 'string' },
    }, ['summaryId'])
  ),
  openAiTool(
    'ic_update_finding',
    'Update a finding status. Setting status to implemented also applies its queued actions.',
    objectSchema({
      findingId: { type: 'string' },
      status: { type: 'string', enum: [...FINDING_STATUSES] },
    }, ['findingId', 'status'])
  ),
  openAiTool(
    'ic_create_finding',
    'Create a new finding for an issue that should remain visible for later review.',
    objectSchema({
      type: { type: 'string', enum: [...FINDING_TYPES] },
      severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
      title: { type: 'string' },
      description: { type: 'string' },
      relatedIds: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chunkIds: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 500,
          },
          summaryIds: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 500,
          },
          findingIds: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 500,
          },
        },
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['delete', 'update', 'done'] },
            targetType: { type: 'string', enum: ['chunk', 'summary', 'file', 'finding'] },
            targetId: { type: 'string' },
            updateText: { type: 'string' },
          },
          required: ['action', 'targetType', 'targetId'],
        },
      },
    }, ['type', 'severity', 'title', 'description'])
  ),
  openAiTool(
    'ic_create_chunk',
    'Create a new learning chunk for the current project.',
    objectSchema({
      fact: { type: 'string' },
      category: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.75 },
      source: { type: 'string' },
    }, ['fact', 'category'])
  ),
  openAiTool(
    'record_learning',
    [
      'Record one or more new project facts that were discovered during this request.',
      'Use this when you genuinely learned something durable about the project — its structure,',
      'conventions, behaviour, dependencies, or gotchas — that is worth re-injecting into future',
      'requests. Do NOT record task-specific or user-specific facts, ephemeral reasoning, or facts',
      'that are already obvious from the user\'s request. Each fact must be a project-level truth,',
      'not a sentence about the current turn.',
      '',
      'The "isNew" flag tells the system whether the fact is genuinely discovered in this turn or',
      'is a refinement of something already known. Set isNew=false for refinements of existing',
      'facts; the system will look up the existing chunk by (category, fact) and update it.',
      'Optional filesUsed entries record which files informed the fact; optional codeExtracts',
      'attach specific code snippets or symbol lists as provenance.',
    ].join(' '),
    objectSchema({
      learnings: {
        type: 'array',
        minItems: 1,
        // No maxItems: the per-call batch cap is configurable via
        // `context.maxRecordLearnings` and enforced (gracefully, with a
        // truncation notice) by the executor. Keep this schema unconstrained
        // so a raised limit is not silently capped by the tool definition.
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fact: { type: 'string', minLength: 1 },
            category: { type: 'string', minLength: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.9 },
            isNew: { type: 'boolean', default: true },
            filesUsed: {
              type: 'array',
              maxItems: 25,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 1 },
                  purpose: { type: 'string' },
                },
                required: ['name'],
              },
            },
            codeExtracts: {
              type: 'array',
              maxItems: 25,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  fileName: { type: 'string' },
                  language: { type: 'string' },
                  symbols: { type: 'array', items: { type: 'string' }, maxItems: 50 },
                  code: { type: 'string' },
                },
              },
            },
          },
          required: ['fact', 'category'],
        },
      },
    }, ['learnings'])
  ),
];

// ── Single consolidated `ic` tool ──
const IC_TOOL_DEFINITION: OpenAiFunctionToolDefinition = openAiTool('ic', IC_TOOL_YAML_DESCRIPTION, IC_TOOL_SCHEMA);
const OPENAI_IC_SINGLE_TOOL: OpenAiFunctionToolDefinition[] = [IC_TOOL_DEFINITION];

// Combined set for the agent loop / analyzer (both legacy + single tool).
const OPENAI_IC_TOOLS: OpenAiFunctionToolDefinition[] = [
  ...OPENAI_IC_LEGACY_TOOLS,
  ...OPENAI_IC_SINGLE_TOOL,
];

const ANTHROPIC_IC_TOOLS: AnthropicToolDefinition[] = OPENAI_IC_TOOLS.map((tool) => ({
  name: tool.function.name,
  description: tool.function.description,
  input_schema: tool.function.parameters,
}));

const LEARNING_TOOL_NAMES = new Set(
  OPENAI_IC_TOOLS.map((tool) => tool.function.name)
);

export function isLearningToolName(name: string): boolean {
  return LEARNING_TOOL_NAMES.has(name);
}

export function getLearningToolsForClientProtocol(
  clientProtocol: ClientProtocol
): LearningToolDefinition[] {
  return clientProtocol === 'anthropic'
    ? ANTHROPIC_IC_TOOLS
    : OPENAI_IC_TOOLS;
}

/**
 * Returns ONLY the single consolidated `ic` tool for the given protocol.
 * Used by the middleware to inject a compact tool definition into the
 * main model / gatherer request.  The analyzer and agent loop use the
 * full set from `getLearningToolsForClientProtocol`.
 */
export function getSingleIcToolForClientProtocol(
  clientProtocol: ClientProtocol
): LearningToolDefinition[] {
  const name = IC_TOOL_DEFINITION.function.name;
  const description = IC_TOOL_DEFINITION.function.description;
  const params = IC_TOOL_DEFINITION.function.parameters;

  if (clientProtocol === 'anthropic') {
    return [{ name, description, input_schema: params }];
  }

  return [{ type: 'function', function: { name, description, parameters: params } }];
}