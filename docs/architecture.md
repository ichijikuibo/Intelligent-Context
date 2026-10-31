# Intelligent AI Coding Context

## Problem
AI coding needs context to be effective but large content increases the cost very quickly. The usual solution is to use clean chats or compress the context, but these often end up with the model forgetting what it was doing. The solution to this is to build up a model's instruction/learning file over time, but this too is limited — as its size grows it would still cost a lot of input processing if it contained everything needed about a project.

A typical coding agent request has a period at the start where it gathers information needed to perform the task. This is often done by asking the user for information or by having the model ask questions. This is a good approach but it can be slow and frustrating for the user to answer questions they've already answered in previous requests.

## Solution
My solution is to proxy the AI requests and build up project-sensitive context over time via auto-learning.

The proxy's request will have a command added to have the model return what it learned from the request. This will be extracted from the returned message, stored, and removed from what is sent to the user. This allows a context to be created that contains all the learning the model has done about the project. These learning chunks will then be summarized and categorized by a separate background request. After enough context has built up, these summaries and categories will be passed to a high-speed model (such as DeepSeek V4 Flash) which will determine how relevant they are to the request. Relevant context entries will then be sent to the main request, providing compressed and much more relevant context about the current project.

Another step would be an idle-time or overnight job to analyze these contexts, which would clean up, establish links, and provide feature/refactor/security suggestions.

## The Structure
The system will be a **Node.js/TypeScript background service with a web interface**. After evaluating Rust vs Node.js, Node.js was chosen because:

- **The system is overwhelmingly I/O-bound**: proxying HTTP streams, calling AI APIs, querying databases. Node's event loop excels at this workload.
- **The only CPU-bound path** (embedding generation) runs via ONNX Runtime in WASM or is offloaded to `pgvector` (C) in server mode — not raw JavaScript.
- **SaaS-scale concerns are addressed by horizontal scaling** of the stateless proxy layer, not single-process throughput.
- **Development velocity**: TypeScript + Express provides a 2-3x faster path to MVP, with the option to replace hot paths with Rust native addons (`napi-rs`) if profiling later proves it necessary.

The service has 2 run modes: **local mode** listening on `127.0.0.1` with SQLite, installed as a background service (Windows Service / systemd); and **self-hosted mode** listening on `0.0.0.0` with PostgreSQL (with SQLite as an option), deployed via Docker. The architecture is designed so that self-hosted can later form the foundation of a SaaS application with a full web app.

The user brings their own keys and selects which models to use for each of the special purposes: context selection (likely a high-speed model), summarization (a model that can handle larger contexts), and the analysis model (a high-performance model for deep analysis). They then select from their installed models the main model they wish to use for the task, similar to how current tools work.

The application will need to make request in either anthropic or openai format and will need to expose open ai input from the user ide.

It will need either a SQLite database for local, Postgres for SaaS, or either for self-hosted. The database will store the learning chunks, summaries, categories, and any other relevant data needed for context building and analysis.

The interface will need the ability to select the special-purpose models and add access to models via OpenAI or Anthropic APIs. It should expose interfaces to connect with tools such as VS Code's Copilot Chat, and future developments could include its own extension/application.

The core idea is aimed at development, but the principles could be expanded to basically any area of AI agent use.

## Data Structure
The data I believe should be stored in a json chunk in the db with the summary(text) and catergories(json array) seperate, summary and categories will be passed to the clasification model and identified full chunks will be passed to the main mode. the chunk format should be something like this
{
  "Project":"<Project_Name>", //need to find a soild way to get this direct from ide if posible
  "Categories":"<List_of_catergories_for_the_request>"//any catergories the model sujest by default bu option to define list of catergories and model picks which one matches
  "FilesUsed":[
    "name":<Filename> //schedularcontroler.java
    "purposeOfFile":<Summary_of_what_file_is> // over all summary of the file to help the model know if the fiale is relevant to its request
  ],
  "Learnings":[
    // any learning at all such as scheduler has 3 main situations single site, master site on multisite and non master site on multi site this should be taken into consideration for all scheduler changes.
  ]
}
---

# Implementation Blueprint

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict mode) |
| HTTP Framework | Express.js 4.x |
| Proxy HTTP | Built-in `http`/`https` modules with `http-proxy-middleware` |
| Database (Local) | SQLite via `better-sqlite3` |
| Database (Server) | PostgreSQL 16+ via `pg` + `drizzle-orm` |
| Job Queue | BullMQ (Redis-backed) for server; in-process timer for local |
| Embeddings | `@xenova/transformers` (local, WASM) for SQLite; `pgvector` for Postgres |
| Config | YAML or JSON config file per project + env vars |
| Deployment (Local) | Background service via `node-windows` / `node-linux` (systemd) + `pm2` |
| Deployment (Server) | Docker Compose (proxy + pgvector + Redis) |

---

## 1. System Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────────────┐
│   VS Code   │────▶│              Intelligent Context Proxy                 │
│  (Copilot)  │     │                                                       │
└─────────────┘     │  ┌──────────┐  ┌────────────┐  ┌──────────────────┐  │
                    │  │ Request  │─▶│  Context   │─▶│  Upstream Proxy  │──┼──▶ OpenAI
┌─────────────┐     │  │ Receiver │  │  Injector  │  │  (multi-provider)│  │    Anthropic
│  Continue   │────▶│  └──────────┘  └────────────┘  └────────┬─────────┘  │    OpenCode
│  .dev /     │     │                                         │             │
│  Cline /    │     │  ┌──────────┐  ┌────────────┐  ┌───────▼────────┐  │
│  Aider      │────▶│  │ Response │◀─│  Learning  │◀─│  Response      │  │
└─────────────┘     │  │ Sender   │  │  Extractor │  │  Receiver      │  │
                    │  └──────────┘  └─────┬──────┘  └────────────────┘  │
                    │                      │                               │
                    │              ┌───────▼──────┐                        │
                    │              │   Database   │                        │
                    │              │  SQLite/     │                        │
                    │              │  Postgres    │                        │
                    │              └───────┬──────┘                        │
                    │                      │                               │
                    │  ┌───────────────────┼───────────────────────────┐  │
                    │  │           Background Workers                   │  │
                    │  │                                                │  │
                    │  │  ┌─────────────┐  ┌──────────┐  ┌──────────┐  │  │
                    │  │  │ Summarizer  │  │ Context  │  │  Deep    │  │  │
                    │  │  │ + Categoriz.│  │ Selector │  │ Analyzer │  │  │
                    │  │  └─────────────┘  └──────────┘  └──────────┘  │  │
                    │  └────────────────────────────────────────────────┘  │
                    │                                                       │
                    │  ┌──────────────────┐                                │
                    │  │  Management API  │──▶ Config UI (localhost:XXXX)  │
                    │  └──────────────────┘                                │
                    └──────────────────────────────────────────────────────┘
```

### Component Responsibilities

**Proxy Server** — The main Express application. Receives requests from the IDE, injects context, forwards to upstream AI APIs, extracts learnings from responses, and returns cleaned responses to the IDE.

**Request Receiver** — Parses incoming requests. Detects which project the request belongs to (by workspace path in a custom header or by matching against registered project roots). Validates auth.

**Context Injector** — Queries the context selection engine for the most relevant context for this request. Formats and injects context as a system message preamble or as appended user content, respecting token budgets.

**Upstream Proxy** — Routes requests to the correct AI provider (OpenAI, Anthropic, OpenCode, etc.) using an adapter pattern. Handles both streaming (SSE) and non-streaming requests. Supports retry with exponential backoff.

**Learning Extractor** — Parses the AI response to find the learning extraction block (see §4). Strips it from the response before sending to the user. Stores raw learnings in the database.

**Response Sender** — Returns the cleaned response to the IDE. For streaming, removes learning blocks from the SSE stream in real-time.

**Background Workers** — Run asynchronously, triggered by either a job queue (BullMQ + Redis for server deployments) or an in-process timer/setInterval (for local/SQLite deployments).

**Management API** — A separate Express router on a different port (e.g., `localhost:9090`) serving a configuration dashboard. Allows model selection, project setup, and review of stored context.

---

## 2. Database Schema

### 2.1 Entity Relationship

```
projects 1───many learning_chunks
projects 1───many summaries
projects 1───many context_selections
categories many───many learning_chunks (via chunk_categories)
categories many───many summaries (via summary_categories)
summaries 1───many learning_chunks (source chunks)
learning_chunks 1───1 embeddings (optional, for vector search)
```

### 2.2 Table Definitions

**projects**

SQLite: TEXT for UUIDs, INTEGER for booleans (0/1)
Postgres: UUID type, BOOLEAN type, JSONB for settings

Columns:
- id (UUID, PK)
- name (TEXT) — Human-readable name
- rootPath (TEXT) — Absolute path of project root
- createdAt (TIMESTAMP)
- updatedAt (TIMESTAMP)
- settings (JSON) — ProjectSettings object

ProjectSettings fields: mainModel, contextSelectorModel, summarizerModel, analyzerModel, contextTokenBudget (default 4000), autoSummarizeThreshold (default 10), embeddingModel

**learning_chunks**

Columns:
- id (UUID, PK)
- projectId (UUID, FK → projects.id)
- sessionId (TEXT) — Groups chunks from same conversation
- requestId (TEXT) — Unique per request
- content (TEXT) — The raw extracted learning text
- confidence (FLOAT) — 0.0–1.0 self-reported confidence
- source (TEXT) — 'extraction' | 'background_query' | 'manual'
- tokensUsed (INTEGER) — Approximate token count
- embeddingId (UUID, nullable, FK → embeddings.id)
- createdAt (TIMESTAMP)

**summaries**

Columns:
- id (UUID, PK)
- projectId (UUID, FK → projects.id)
- title (TEXT)
- content (TEXT) — Condensed summary text
- sourceChunkIds (JSON array) — Array of learning_chunks.id
- version (INTEGER) — Incremented on re-summarization
- createdAt (TIMESTAMP)
- updatedAt (TIMESTAMP)

**categories**

Columns:
- id (UUID, PK)
- projectId (UUID, nullable, FK → projects.id) — null = global/system category
- parentId (UUID, nullable, FK → categories.id) — For hierarchical tree
- name (TEXT), slug (TEXT), description (TEXT, nullable), color (TEXT, nullable)

**chunk_categories** (Many-to-many join)

Columns: chunkId (FK), categoryId (FK), assignedBy ('auto'|'manual'), confidence

**summary_categories** (Many-to-many join)

Columns: summaryId (FK), categoryId (FK)

**embeddings**

Postgres: pgvector column type; SQLite: BLOB or separate file

Columns:
- id (UUID, PK)
- chunkId (UUID, unique FK → learning_chunks.id)
- vector (VECTOR(384) or BLOB) — 384 floats for MiniLM
- model (TEXT), dimensions (INTEGER)

**context_selections** (Audit log)

Columns:
- id (UUID, PK)
- projectId (UUID, FK → projects.id)
- requestId (TEXT)
- selectedChunkIds (JSON array), selectedSummaryIds (JSON array)
- totalTokensInjected (INTEGER)
- selectionMethod (TEXT) — 'semantic' | 'keyword' | 'recency' | 'hybrid'
- selectionLatencyMs (INTEGER)
- createdAt (TIMESTAMP)

**analysis_findings**

Columns:
- id (UUID, PK), projectId (FK), type, severity, title, description
- relatedChunkIds (JSON array), status ('open'|'accepted'|'dismissed'|'implemented')
- createdAt, reviewedAt (nullable)

**project_files** (Optional)

Columns: id, projectId (FK), relativePath, fileType, lastScannedDigest (nullable), lastScannedAt (nullable)

### 2.3 SQLite vs Postgres Notes

| Concern | SQLite | Postgres |
|---------|--------|----------|
| Vector search | Brute-force cosine similarity in Node.js, or `sqlite-vss` extension | `pgvector` with IVFFlat/HNSW indexes |
| JSON fields | TEXT with `JSON.parse` in app layer | `JSONB` with native querying |
| Concurrency | Single writer — fine for local single-user, bottleneck for server | Full MVCC — required for multi-user SaaS |
| Full-text search | Built-in FTS5 extension | `tsvector`/`tsquery` with GIN indexes |
| Migrations | WAL mode + manual migration scripts | Drizzle ORM migrations |
| Embedding storage | BLOB or separate `.bin` files per chunk | `pgvector` column type |

---

## 3. Proxy Core Implementation

### 3.1 Directory Structure

```
src/
├── index.ts                  // Entry point: starts proxy + management API
├── config/
│   ├── config.ts             // Loads from YAML + env vars
│   └── defaults.ts           // Sensible defaults
├── proxy/
│   ├── server.ts             // Express app setup
│   ├── middleware/
│   │   ├── auth.ts           // API key validation
│   │   ├── projectDetect.ts  // Match request to project
│   │   ├── contextInject.ts  // Inject context before proxying
│   │   └── logging.ts        // Request/response logging
│   ├── router.ts             // Route definitions
│   ├── upstream.ts           // Upstream proxy logic
│   └── adapters/
│       ├── adapter.ts        // Interface: Adapter
│       ├── openai.ts         // OpenAI API adapter
│       ├── anthropic.ts      // Anthropic API adapter
│       └── opencode.ts       // OpenCode adapter (extends OpenAI)
├── learning/
│   ├── extractor.ts          // Extract learnings from responses
│   ├── prompt.ts             // Build the extraction prompt injection
│   ├── parser.ts             // Parse JSON/Markdown extraction blocks
│   └── deduplicator.ts       // Detect & merge duplicate learnings
├── context/
│   ├── selector.ts           // Main context selection engine
│   ├── embeddings.ts         // Embedding generation & storage
│   ├── reranker.ts           // LLM-based reranking
│   ├── assembler.ts          // Format context for injection
│   └── budget.ts             // Token counting & budget management
├── workers/
│   ├── summarizer.ts         // Summarization job
│   ├── categorizer.ts        // Auto-categorization job
│   ├── analyzer.ts           // Deep analysis job
│   └── scheduler.ts          // Job scheduling (BullMQ or timer)
├── db/
│   ├── connection.ts         // DB connection (SQLite or Postgres)
│   ├── schema.ts             // Drizzle ORM schema definitions
│   ├── migrations/           // Migration files
│   └── repositories/         // Data access layer
│       ├── chunks.ts
│       ├── summaries.ts
│       ├── categories.ts
│       ├── embeddings.ts
│       └── selections.ts
├── api/
│   ├── management.ts         // Management API (config dashboard)
│   └── routes/
│       ├── projects.ts       // CRUD for projects
│       ├── context.ts        // Browse/search stored context
│       ├── findings.ts       // Review analysis findings
│       └── settings.ts       // Project settings
└── utils/
    ├── tokens.ts             // Token counting
    ├── hashing.ts            // Content hashing for dedup
    ├── similarity.ts         // Cosine similarity
    └── logger.ts             // Structured logging
```

### 3.2 Proxy Request Lifecycle

```
Incoming Request
    │
    ▼
┌─────────────────┐
│ 1. Authenticate │  Check API key header
└────────┬────────┘
         ▼
┌─────────────────┐
│ 2. Detect       │  Match X-Project-Root header to registered project
│    Project      │
└────────┬────────┘
         ▼
┌─────────────────┐
│ 3. Select       │  Embed request text → find similar chunks →
│    Context      │  LLM rerank → assemble top-N within token budget
└────────┬────────┘
         ▼
┌─────────────────┐
│ 4. Inject       │  Prepend context as system message, append
│    Context      │  extraction instruction (see §4)
└────────┬────────┘
         ▼
┌─────────────────┐
│ 5. Proxy to     │  Route to correct upstream adapter
│    Upstream     │  Buffer for non-streaming, transform SSE for streaming
└────────┬────────┘
         ▼
┌─────────────────┐
│ 6. Extract      │  Parse response for learning block, strip it,
│    Learnings    │  store in DB asynchronously
└────────┬────────┘
         ▼
┌─────────────────┐
│ 7. Return       │  Send cleaned response to IDE
│    Response     │  Log context selection for audit
└─────────────────┘
```

### 3.3 Streaming Handling

The proxy handles Server-Sent Events (SSE) without buffering the entire response:

1. Set `Accept: text/event-stream` on upstream request and pipe the response
2. Transform SSE lines through a Node.js `Transform` stream
3. Use a state machine: `SCANNING` → `COLLECTING` → `DONE` based on `<!--LEARN_START-->` / `<!--LEARN_END-->` markers
4. Lines not part of the learning block pass through unchanged to the IDE
5. On stream end or learning block completion, fire async DB write

```typescript
class LearningExtractionTransform extends Transform {
  private state: 'SCANNING' | 'COLLECTING' | 'DONE' = 'SCANNING';
  private learningBuffer: string[] = [];

  _transform(chunk: Buffer, encoding: string, callback: Function) {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (this.state === 'SCANNING' && line.includes('<!--LEARN_START-->')) {
        this.state = 'COLLECTING';
        continue;
      }
      if (this.state === 'COLLECTING' && line.includes('<!--LEARN_END-->')) {
        this.state = 'DONE';
        this.emit('learningExtracted', this.learningBuffer.join('\n'));
        this.learningBuffer = [];
        continue;
      }
      if (this.state === 'COLLECTING') {
        this.learningBuffer.push(line);
        continue; // Don't forward to user
      }
      this.push(line + '\n');
    }
    callback();
  }
}
```

---

## 4. Learning Extraction Engine

### 4.1 Prompt Injection Technique

The proxy appends a structured extraction instruction to every outgoing request as an additional user message (not system, to ensure the model processes it):

```
---

[SYSTEM INSTRUCTION - DO NOT INCLUDE IN YOUR VISIBLE RESPONSE]
After completing the user's request above, append a LEARNING EXTRACTION block
wrapped in <!--LEARN_START--> and <!--LEARN_END--> markers.

In this block, output a JSON object with:
- "learnings": Array of things you learned about this project. Each entry:
  - "fact": A concise factual statement about the project
  - "category": Suggested category (e.g., "architecture", "conventions",
    "dependencies", "api-design", "gotchas", "user-preference")
  - "confidence": 0.0 to 1.0 — how certain you are
  - "isNew": true if just learned in THIS request

Do NOT repeat things from previous learning extractions in this conversation.

Example:
<!--LEARN_START-->
{
  "learnings": [
    {
      "fact": "The project uses Drizzle ORM with a repository pattern.",
      "category": "architecture",
      "confidence": 0.95,
      "isNew": true
    }
  ]
}
<!--LEARN_END-->
```

### 4.2 Response Parsing

```typescript
interface ExtractedLearning {
  fact: string;
  category: string;
  confidence: number;
  isNew: boolean;
}

function parseLearningBlock(rawText: string): ExtractedLearning[] | null {
  const startIdx = rawText.indexOf('<!--LEARN_START-->');
  const endIdx = rawText.indexOf('<!--LEARN_END-->');
  if (startIdx === -1 || endIdx === -1) return null;

  const jsonStr = rawText.substring(
    startIdx + '<!--LEARN_START-->'.length, endIdx
  ).trim();

  let parsed: { learnings: ExtractedLearning[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Fallback: model may have wrapped JSON in ```json fences
    const cleaned = jsonStr.replace(/```json\s*|\s*```/g, '');
    parsed = JSON.parse(cleaned);
  }

  if (!parsed.learnings || !Array.isArray(parsed.learnings)) return null;
  return parsed.learnings.filter(l => l.isNew && l.confidence > 0.3);
}
```

### 4.3 Fallback: Secondary Extraction Request

If the model doesn't include the learning block, make a secondary lightweight request using the fast/cheap model to extract learnings from the original request/response pair.

### 4.4 Deduplication & Validation

1. **Near-duplicate detection**: Hash normalized fact text; skip if hash already exists
2. **Semantic duplicate detection**: Compute cosine similarity against recent chunks; flag if >0.92
3. **Contradiction detection**: Compare new facts against existing same-category facts during idle analysis
4. **Confidence threshold**: Only store chunks with confidence ≥ 0.3

```typescript
async function deduplicateAndStore(
  learning: ExtractedLearning, projectId: string
): Promise<boolean> {
  const hash = sha256(learning.fact.toLowerCase().replace(/[^\w\s]/g, ''));
  const existing = await chunksRepo.findByHash(projectId, hash);
  if (existing) {
    if (learning.confidence > existing.confidence)
      await chunksRepo.updateConfidence(existing.id, learning.confidence);
    return false;
  }
  await chunksRepo.insert({ ...learning, hash, projectId });
  return true;
}
```

---

## 5. Summarization & Categorization Pipeline

### 5.1 Trigger Strategy

| Deployment | Trigger |
|------------|---------|
| Local (SQLite) | `setInterval` every 5 min: check unsummarized chunks |
| Server (Postgres) | BullMQ job on threshold, or scheduled cron |

Configurable thresholds: `minChunksForSummary` (5), `maxUnsummarizedChunks` (20), `summaryCooldownMinutes` (30).

### 5.2 Summarization Prompt Design

```typescript
function buildSummarizationPrompt(chunks: LearningChunk[]): ChatMessage[] {
  const chunkText = chunks.map((c, i) =>
    `[${i + 1}] (category: ${c.category}, confidence: ${c.confidence})\n${c.fact}`
  ).join('\n\n');

  return [
    {
      role: 'system',
      content: `You are a technical knowledge manager. Condense multiple related
                learnings into concise, structured summaries. Group related facts.
                Remove redundancy. Preserve technical precision.`
    },
    {
      role: 'user',
      content: `Create a structured summary with sections:
                1. Architecture & Patterns  2. Conventions & Style
                3. Dependencies & Stack  4. Gotchas & Constraints
                5. User Preferences

                For each section, write bullet points. Only include information
                from the facts below. Do not invent anything.

                ## Facts to Summarize
                ${chunkText}

                Output in <summary>...</summary> tags with ## headers per section.
                Also suggest categories: <categories>cat1, cat2</categories>`
    }
  ];
}
```

### 5.3 Category Tree Management

Auto-categorization uses: (1) embedding similarity against category centroids, (2) periodic LLM batch consolidation, (3) manual curation via management UI.

Seed categories for new projects:

```
Software Project
├── Architecture & Patterns
│   ├── Module Structure
│   ├── Data Flow
│   └── Design Patterns
├── Conventions & Style
│   ├── Naming Conventions
│   ├── Code Organization
│   └── Testing Patterns
├── Dependencies & Stack
│   ├── Core Libraries
│   ├── Build Tools
│   └── Infrastructure
├── Gotchas & Constraints
│   ├── Known Bugs
│   ├── Performance Limits
│   └── Compatibility Issues
└── User Preferences
    ├── Tool Preferences
    ├── Communication Style
    └── Process Preferences
```

---

## 6. Context Selection Engine

### 6.1 Two-Stage Selection

**Stage 1: Guaranteed context + descriptor assembly**

1. Extract explicit file paths and attachment-like path hints from recent user messages
2. Match those file hints against `learning_files` and load any linked learning chunks as **guaranteed context**
3. Load all unsummarized chunks and group them by `category`
4. Load all summaries as lightweight selector records: `id`, `categoriesList`, `oneLineSummary`
5. Split out `global` summaries so they can be attached automatically on every relevant request
6. Keep open gap findings available when the query overlaps their title/description

At this stage the selector no longer sends a large mixed pool of historical chunks to the ranking model. Historical knowledge is represented primarily through summaries, while fresh knowledge is represented through unsummarized **category buckets**.

**Stage 2: LLM descriptor selection** (target: <500ms)

Send the descriptor pool to a fast model (for example DeepSeek V4 Flash) with the original query. The model returns the summary IDs and unsummarized category IDs that should be expanded into the final injected context.

```typescript
async function chooseContextDescriptors(
  query: string,
  categories: Array<{ id: string; chunkCount: number }>,
  summaries: Array<{ id: string; categories: string[]; oneLineSummary: string }>
): Promise<{ categoryIds: string[]; summaryIds: string[] }> {
  const response = await callModel({
    model: projectSettings.contextSelectorModel,
    messages: [{
      role: 'user',
      content: `Given query: "${query.slice(0, 500)}"
                Choose relevant unsummarized category IDs and summary IDs.
                File-linked learnings and global summaries are already handled.
                Return JSON with {"categoryIds":[],"summaryIds":[]}.`
    }],
    max_tokens: 300
  });

  return JSON.parse(response.content);
}
```

### 6.2 Token Budgeting

```typescript
function computeTokenBudget(
  modelMaxTokens: number,          // e.g., 128000
  requestMessages: ChatMessage[],
  reservedForResponse = 4000,
  overhead = 500
): number {
  const usedTokens = requestMessages.reduce(
    (sum, msg) => sum + estimateTokens(msg.content), 0
  );
  return modelMaxTokens - usedTokens - reservedForResponse - overhead;
}

function fillBudget(
  ranked: ContextCandidate[], budget: number
): ContextCandidate[] {
  const selected: ContextCandidate[] = [];
  let used = 0;

  const guaranteed = ranked.filter((c) => c.guaranteed === true);
  const globals = ranked.filter((c) => c.categories?.includes('global'));
  const remainder = ranked.filter((c) => !guaranteed.includes(c) && !globals.includes(c));

  for (const candidate of [...guaranteed, ...globals, ...remainder]) {
    const tokens = estimateTokens(candidate.content);
    if (used + tokens <= budget) {
      selected.push(candidate);
      used += tokens;
    }
    if (used > budget * 0.8) break;
  }
  return selected;
}
```

### 6.3 Context Assembly

The final injected context is assembled from four sources:

1. guaranteed file-linked chunks
2. global summaries
3. full text for selected summaries
4. all unsummarized chunks in the selected categories

Format selected context as a system message preamble:

```
## Project Context (auto-injected by Intelligent Context)

The following is learned knowledge about this project. Use it to inform your
response, but prioritize the user's explicit instructions if there's a conflict.

### Architecture
- Uses repository pattern with Drizzle ORM
- API routes in src/api/routes/ following Express Router convention

### Conventions
- camelCase variables, PascalCase components
- Prefer arrow functions over function declarations

### Known Gotchas
- Test DB uses SQLite in-memory — avoid Postgres-specific queries in tests

### User Preferences
- Concise answers with code examples
- TypeScript strict mode — no `any` types
---
```

Inserted as the first system message (or merged into existing one).

---

## 7. Deep Analysis Jobs

### 7.1 Scheduler

| Trigger | Schedule |
|---------|----------|
| Idle detection | If no requests for 30+ min |
| Scheduled | Daily at 2 AM (configurable) |
| Manual | "Run analysis now" button in management UI |

Local: simple timer checking last request time. Server: BullMQ scheduled jobs.

### 7.2 Analysis Types

**Type 1: Cross-Chunk Pattern Detection**

Feed recent chunks + existing summaries to the analyzer model. Detects:
- Contradictions between facts (e.g., "uses ESLint" vs "uses Prettier standalone")
- Emerging conventions not yet formalized
- Orphan chunks indicating new topic areas
- Knowledge gaps (topics mentioned but not well-understood)

**Type 2: Feature & Refactor Suggestions**

The analyzer reviews accumulated knowledge and suggests:
- "Based on repository pattern usage, consider adding a caching layer"
- "Several learnings mention TypeScript strictness — consider enabling strict: true"
- "Uses both lodash and native methods — could standardize on native"

**Type 3: Security Scanning**

Scans stored learnings for security keywords (hardcoded keys, deprecated packages, missing auth, SQL injection patterns). Flags findings for review.

### 7.3 Knowledge Graph (Future)

Optional deeper analysis constructing a graph of entities (files, functions, classes, concepts) and relationships. Enables queries like "show me everything about authentication" or "what depends on the User model?". Implementation: entity extraction via NER-like prompting, stored in graph DB.

---

## 8. Management API & Configuration

### 8.1 REST API Endpoints (port 9090)

```
GET    /api/projects                    # List registered projects
POST   /api/projects                    # Register new project
PUT    /api/projects/:id                # Update project settings
DELETE /api/projects/:id                # Remove project

GET    /api/projects/:id/chunks         # List learning chunks (paginated)
DELETE /api/projects/:id/chunks/:cid    # Delete chunk (manual curation)
POST   /api/projects/:id/chunks         # Manually add learning

GET    /api/projects/:id/summaries      # List summaries
POST   /api/projects/:id/summaries/regenerate

GET    /api/projects/:id/categories     # Get category tree
PUT    /api/projects/:id/categories     # Update category tree

GET    /api/projects/:id/findings       # List analysis findings
PUT    /api/projects/:id/findings/:fid  # Update finding status

GET    /api/projects/:id/context-log    # View selection history
POST   /api/projects/:id/analyze        # Trigger deep analysis
GET    /api/health                      # System health
```

### 8.2 Project Auto-Registration

```typescript
async function autoRegisterProject(rootPath: string): Promise<Project> {
  const id = uuid();
  const project: Project = {
    id, name: path.basename(rootPath), rootPath,
    createdAt: new Date(), updatedAt: new Date(),
    settings: {
      mainModel: 'deepseek-v4-pro',
      contextSelectorModel: 'deepseek-v4-flash',
      summarizerModel: 'deepseek-v4-pro',
      analyzerModel: 'deepseek-v4-pro',
      contextTokenBudget: 4000,
      autoSummarizeThreshold: 10,
      embeddingModel: 'all-MiniLM-L6-v2'
    }
  };
  await projectsRepo.insert(project);
  await seedCategories(id);
  return project;
}
```

### 8.3 IDE Integration

**Option A (Simple):** Set `OPENAI_BASE_URL=http://localhost:1234/v1` in IDE settings. The IDE talks to the proxy transparently.

**Option B (Full):** VS Code extension that starts/connects to proxy, adds `X-Project-Root` header, shows status bar with context count, provides sidebar for browsing context & findings.

### 8.4 Model Configuration (YAML)

```yaml
# intelligent-context.yaml (project root)
models:
  main: deepseek-v4-pro
  contextSelector: deepseek-v4-flash
  summarizer: deepseek-v4-pro
  analyzer: deepseek-v4-pro

providers:
  opencode:
    baseUrl: https://opencode.ai/zen/go
    apiKey: ${OPENCODE_API_KEY}
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

context:
  tokenBudget: 4000
  autoSummarizeThreshold: 10
  fallbackExtraction: true
  embeddingModel: all-MiniLM-L6-v2
```

---

## 9. Embedding Strategies

### 9.1 Local / SQLite: Local Transformers

Use `@xenova/transformers` (JavaScript port of HuggingFace Transformers, runs in Node.js via ONNX Runtime):

```typescript
import { pipeline } from '@xenova/transformers';

class LocalEmbeddingService {
  private extractor: any;

  async init(modelName = 'Xenova/all-MiniLM-L6-v2') {
    this.extractor = await pipeline('feature-extraction', modelName);
  }

  async embed(text: string): Promise<Float32Array> {
    const result = await this.extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(result.data);
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

Storage: SQLite vectors as BLOBs (raw float32 bytes). Cosine similarity computed in Node.js.

### 9.2 Server / Postgres: pgvector

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE embeddings (
  id UUID PRIMARY KEY,
  chunk_id UUID REFERENCES learning_chunks(id) ON DELETE CASCADE,
  vector vector(384),
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON embeddings USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Similarity search:
SELECT chunk_id, 1 - (vector <=> $1::vector) AS similarity
FROM embeddings WHERE project_id = $2
ORDER BY vector <=> $1::vector LIMIT 50;
```

---

## 10. Deployment Modes

### 10.1 Local (Background Service)

The local deployment runs as a **cross-platform background service** — Windows Service on Windows, systemd unit on Linux, launchd on macOS. The service starts automatically on boot and runs silently in the background with a web-based management UI accessible at `http://localhost:9090`.

**Service installation** uses platform-specific libraries:

| Platform | Library | Mechanism |
|----------|---------|-----------|
| Windows | `node-windows` | Windows Service (svchost) |
| Linux | `node-linux` | systemd unit file |
| macOS | `node-mac` | launchd plist |

**Process management** uses `pm2` for daemonization, automatic restarts, and log rotation:

```bash
# Install as background service
npm install -g pm2
pm2 start dist/index.js --name intelligent-context
pm2 save
pm2 startup          # Auto-start on boot (generates platform-specific init script)
```

```
intelligent-context-local/
├── src/                    # Core proxy (see §3.1)
├── ui/                     # Management UI (React SPA)
├── scripts/
│   ├── install-service.sh  # Linux/macOS service installer
│   ├── install-service.ps1 # Windows service installer
│   └── uninstall.sh / .ps1 # Service removal
└── package.json
```

The local mode stores SQLite in `~/.intelligent-context/data/` with WAL mode enabled for concurrent reads. Configuration is read from `~/.intelligent-context/config.yaml`. The management UI is served directly by the Express app — no separate web server needed.

### 10.2 Self-Hosted (Docker Compose)

```yaml
services:
  proxy:
    build: .
    ports:
      - "1234:1234"   # Proxy
      - "9090:9090"   # Management API
    environment:
      - DB_TYPE=postgres
      - DATABASE_URL=postgresql://user:pass@db:5432/intelligent_context
      - REDIS_URL=redis://redis:6379
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - ./config:/app/config
      - context_data:/app/data

  db:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=intelligent_context
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  pgdata:
  redis_data:
  context_data:
```

### 10.3 SaaS Considerations

For SaaS, add: multi-tenancy with `tenant_id` on all tables, row-level security, API key encryption at rest via KMS, per-tenant rate limiting, metered billing by requests proxied, and GDPR-compliant data export/deletion.

---

## 11. Testing Strategy

### Unit Tests
- `learning/parser.test.ts` — Parse extraction blocks (JSON, markdown-wrapped, malformed, missing markers)
- `learning/deduplicator.test.ts` — Hash-based and semantic deduplication
- `context/budget.test.ts` — Token budget calculation with known inputs
- `utils/similarity.test.ts` — Cosine similarity against known vectors
- `proxy/adapters/*.test.ts` — Request/response translation per adapter

### Integration Tests
- Full proxy lifecycle: request → context injected → extraction → response cleaned
- Streaming: SSE stream with embedded learning block, verify passthrough and extraction
- Database: CRUD operations across all repositories

### Evaluation Metrics
- **Context Relevance**: Periodically have analyzer judge relevance on 5% sample of requests
- **Learning Quality**: Manual review of 10 random chunks per week
- **Deduplication Rate**: Track % of extractions that are duplicates (should drop over time)
- **Token Efficiency**: Ratio of tokens saved vs tokens spent on extraction

---

## 12. Performance & Scaling Analysis

### 12.1 Why Node.js Works for This System

The Intelligent Context Proxy is overwhelmingly **I/O-bound**. Every component's bottleneck is network or disk, not CPU:

| Component | Bound By | Node.js Suitability |
|-----------|----------|---------------------|
| HTTP proxying (thousands of concurrent SSE streams) | Network I/O | ✅ Event loop designed for this |
| Upstream AI API calls | Network latency | ✅ Non-blocking async/await |
| Database queries (Postgres with pgvector HNSW) | Disk I/O + C index | ✅ Connection pooling, query offloaded to C |
| Background summarization/analysis | AI API latency | ✅ Just orchestrating API calls |
| Learning extraction (SSE stream parsing) | Stream I/O | ✅ Node `Transform` streams are ideal |

The only CPU-bound path is **local embedding generation**, and even that runs via ONNX Runtime in WASM (compiled C/C++), not raw JavaScript.

### 12.2 Scaling Path: Self-Hosted → SaaS

| Scale | Bottleneck | Solution |
|-------|------------|----------|
| **1-10 devs** (local SQLite) | None — single user | Brute-force cosine similarity in Node.js (~5ms for MiniLM 384d) |
| **10-100 devs** (self-hosted Docker) | Vector search at scale | pgvector HNSW indexes (C implementation, <1ms queries) |
| **100-1000+ tenants** (SaaS) | Proxy connection count | Horizontal scaling of stateless Node.js containers behind load balancer |
| **SaaS embedding volume** | Cost of local GPU inference | Switch to OpenAI `text-embedding-3-small` ($0.02/1M tokens) or dedicated `tei`/`infinity` sidecar |

**Key insight**: The proxy layer is stateless — it holds no session data, all state is in Postgres + Redis. This makes horizontal scaling trivial. Node.js processes behind an nginx/HAProxy load balancer can handle hundreds of thousands of concurrent SSE connections, as demonstrated by companies like Netflix and others at scale.

### 12.3 Escape Hatches

If profiling later reveals a genuine Node.js bottleneck, these can be hot-swapped without rewriting the system:

| Hot Path | Node.js | Escape Hatch |
|----------|---------|--------------|
| Embedding generation | `@xenova/transformers` (WASM ONNX) | Rust native addon via `napi-rs` + `ort` |
| Cosine similarity (local SQLite) | JS `Float32Array` loop | Move to `sqlite-vss` extension (C) |
| SSE stream transformation | Node `Transform` stream | Unlikely to bottleneck — already optimal |
| JSON parsing | Native `JSON.parse` | `simdjson` via native addon if needed |

---

## Glossary

| Term | Definition |
|------|------------|
| **Learning Chunk** | A single atomic fact learned about a project, extracted from an AI response |
| **Summary** | A condensed, structured aggregation of multiple related learning chunks |
| **Category** | A hierarchical label applied to chunks and summaries for organization |
| **Context Injection** | The process of prepending relevant learned knowledge to an AI request |
| **Extraction Prompt** | The hidden instruction appended to requests asking the model to report what it learned |
| **Reranking** | Using an LLM to reorder candidates from a similarity search for better precision |
| **Token Budget** | The maximum number of tokens available for injected context in a request |
| **Deep Analysis** | An expensive, infrequent job that analyzes accumulated knowledge for insights |
| **Embedding** | A numeric vector representation of text used for semantic similarity search |
| **SSE** | Server-Sent Events — the streaming protocol used by most AI APIs for real-time delivery |