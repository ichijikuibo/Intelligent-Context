# Intelligent Context — Learning Process

## Overview

The Intelligent Context system continuously builds a structured knowledge base about each project by extracting facts from AI model responses, summarizing them by category, and injecting relevant context into future requests. A periodic deep analyzer reviews the entire knowledge base for gaps, contradictions, and improvement opportunities.

---

## 1. Learning Extraction (Per-Request)

Every request that passes through the proxy can produce **learning chunks** — small, structured facts about the project. There are two mutually exclusive modes, controlled by the `learningModel` system configuration setting.

### 1a. Inline Mode (`learningModel` not configured)

The `learningPromptEnforcerMiddleware` appends an extraction instruction to the end of the request messages. The main model is asked to append a JSON learning block at the end of its response using `[LEARN_START]…[LEARN_END]` markers.

On the streaming path, a `LearningExtractorStream` Transform intercepts the SSE stream character-by-character, stripping the learning block from visible output while accumulating the full text. When the stream ends (`_flush`), it calls `parseLearningBlock` → `deduplicateAndStore`. The client never sees the learning block.

On the non-streaming path, `processFullResponse` does the same parsing and stripping synchronously before sending the response.

**Trade-off:** Simple setup but consumes some of the main model's output tokens and attention budget for the learning task.

### 1b. Separate Learning Mode (`learningModel` configured to a model name)

The `learningPromptEnforcerMiddleware` **strips** the extraction instruction from messages entirely — the main model never sees it. After the main response completes, a separate asynchronous request is made to the configured learning model.

**Streaming path:** A `ResponseCaptureStream` sits in the SSE pipe, passing all data through unchanged while capturing:
- `rawText` — the complete raw SSE payload
- `visibleText` — only the user-visible text deltas (extracted from OpenAI `delta.content` and Anthropic `text_delta` events)
- `hasToolUse` — whether the response contained tool-use blocks (OpenAI `tool_calls` delta or Anthropic `content_block_start` of type `tool_use`)

When the upstream stream ends (`_flush`) or errors (`_destroy`), the captured data triggers `queueSeparateLearningExtraction`.

**Non-streaming path:** The response is sent to the client first, then the learning extraction is queued. For OpenAI responses, `finish_reason === 'tool_calls'` sets `hasToolUse`. For Anthropic, `stop_reason === 'tool_use'` sets `hasToolUse`.

**Turn-completion detection:** The system avoids starting the learning request while tools are still in flight:
- If `hasToolUse` is `true` (the model asked for tools), the exchange is batched with a 30-second debounce timer. Each subsequent tool-continuation exchange for the same session resets the timer.
- If `hasToolUse` is `false` (the model produced a final text response), all pending batched exchanges are combined and flushed **immediately** — no debounce wait.

**Prior knowledge injection:** Before the learning call, `buildPriorKnowledgeBlock` queries the project's latest 75 unsummarized chunks and all summary one-liners. These are formatted as a "Previously Learned Project Knowledge" section in the standalone prompt, telling the learning model what's already captured so it avoids duplicates without replaying already summarized chunk history.

**The standalone prompt** (`buildStandaloneLearningPrompt`) includes:
1. The prior knowledge block (if any)
2. Each exchange's response payload and visible response text
3. The same `buildSharedLearningInstructions()` format spec as inline mode

### 1c. Deduplication and Storage

`deduplicateAndStore` processes extracted learnings:
- Filters out `confidence < minConfidence` (configurable threshold)
- Filters out `isNew: false`
- Hashes each fact via `hashFact()` and checks for existing chunks with the same hash
- If a duplicate exists with lower confidence, updates the confidence value
- If no duplicate, inserts the new chunk with associated files and category assignment

---

## 2. Categorization

The `categorizer` worker runs before each summarization cycle. It re-examines unsummarized chunks whose `category` is still `"general"`, persists the inferred `category` on the chunk itself, and classifies them using keyword matching against these built-in categories:

| Category | Keyword Examples |
|---|---|
| `architecture` | pattern, structure, module, layer, component, service, repository |
| `conventions` | naming, convention, style, format, standard |
| `dependencies` | library, package, npm, framework, version |
| `gotchas` | bug, issue, warning, workaround, limitation, deprecated |
| `user-preference` | prefer, want, like, dislike, concise, verbose |
| `api-design` | endpoint, route, rest, graphql, schema, dto |

Chunks that already have a non-`general` category assigned by the learning model are left as-is. The categorizer also links chunks to the project's category tree via `categoriesRepo.assignToChunk`.

---

## 3. Summarization (Scheduled)

The summarizer is a cron job that runs every N minutes (configured via `workers.summarizeIntervalMinutes`). For each project, it checks preconditions:

- **Minimum new chunks:** At least `MIN_NEW_CHUNKS_FOR_SCHEDULED_SUMMARIZER` (5) unsummarized chunks must have been created since the last successful summarization run
- **Global threshold:** The total unsummarized count must exceed `config.context.autoSummarizeThreshold`

### 3a. Category Batching

Unsummarized chunks are grouped by their `category` field. Each category is processed independently:

- **Per-category threshold:** At least 3 chunks, OR the `global` category (always eligible), OR total unsummarized exceeds `2 × autoSummarizeThreshold`
- **Token-limited batching:** Each category bucket is split into batches of at most 25 chunks, respecting a per-batch token limit (max 12,000 input tokens)
- **Merge vs. create:** If a summary already exists for the category, the new facts are **merged** into the existing summary. Otherwise, a new summary is created

### 3b. Summary Generation

The summarizer model receives a prompt with:
- The existing summary content (for merges)
- The batch of new facts to incorporate
- Strict output format: `<one-line>`, `<categories>`, `<content>` XML tags

The summarizer produces a structured summary with:
- `oneLineSummary` — used by the context selector for fast relevance decisions
- `categoriesList` — merged list of category tags (preserving existing + adding new)
- `content` — full bullet-point summary text

**Global category is special:** Its summary is treated as a living document — it grows cumulatively, preserving all accumulated conventions. It's given priority access to the context budget on every request.

### 3c. State Tracking

The summarizer tracks `lastSuccessfulRunAt` per project. A run is only marked successful when **zero** categories had failures AND the remaining unsummarized count is zero. This prevents skipping chunks on partial failures.

---

## 4. Context Selection (Per-Request)

Before the main model sees a request, relevant project knowledge is selected and injected.

### 4a. Query Extraction

The selector extracts the user's actual request from the message array:

1. **Wrapper extraction** — Searches the last user message for known request wrappers
   (`<userRequest>`, `<query>`, `<prompt>`, etc.). If a wrapper is found the inner text
   becomes the query.
2. **Tail fallback** — If no wrapper matches and the last message is long, only the
   final 3 000 characters are used. IDE messages typically have workspace/environment/
   attachment XML at the top and the real request at the bottom.
3. **Short message** — If the last message is ≤ 3 000 chars it is used whole.
4. **Absolute fallback** — Concatenates the last 3 user messages, capped at 2 000 chars
   (the original pre-refactor behaviour).

### 4b. Stage 1 — Candidate Retrieval

The last 3 user messages are concatenated as a query (max 2,000 chars). The selector now builds a **descriptor pool** instead of sending a large mixed chunk pool into reranking:

**Guaranteed context extracted before selection:**
- File paths and attachment-like path hints are extracted from user messages
- Stored learning chunks linked to those files are loaded immediately
- These file-linked chunks are treated as guaranteed context and are **not** sent to the context selector model

**Descriptor pool assembled for selection:**
- All **unsummarized chunks** are loaded and grouped by their `category`
- The selector sees only the **category IDs** for those unsummarized buckets, not every raw chunk
- All **summaries** are loaded as lightweight records containing `id`, `categoriesList`, and `oneLineSummary`
- **Global summaries** are split out and treated as automatic high-priority context
- Open `gap` findings still join the pool when the query overlaps their title/description

### 4c. Stage 2 — LLM Reranking

If a `contextSelector` model is configured, it receives the lightweight descriptor pool and returns:

- `categoryIds`: unsummarized categories whose chunks should be expanded into the injected context
- `summaryIds`: summaries whose full text should be injected

The selector model no longer chooses individual historical chunks from a large mixed pool. Instead, it chooses **summary IDs** and **unsummarized category IDs**.

If no selector model is configured, no provider is available, or the response is invalid, the system falls back to simple keyword heuristics over summary text and unsummarized-category buckets.

**Bypass:** If the descriptor pool is small enough, or if injecting every reachable candidate still fits within the configured bypass token threshold, the LLM call is skipped entirely and all descriptor-backed context is expanded directly.

### 4d. Budget Filling

`fillBudget` consumes the ranked candidates in priority order:
1. **Guaranteed file-linked chunks** first — because the request explicitly referenced those files
2. **Global summaries** second — system-wide conventions that apply to every request
3. **Selected gaps, summaries, and unsummarized category chunks** fill the remaining budget

The budget is computed as: `modelMaxTokens − usedPromptTokens − reservedResponseTokens − contextOverheadTokens`.

### 4e. Context Assembly and Injection

`assembleContextMessage` formats selected candidates into a `## Project Context` block organized by category headings. The injected context now consists of:

- guaranteed file-linked chunks
- any matched gap findings
- full text for selected summaries
- all unsummarized chunks belonging to selected categories

Summary candidates are selected using their one-line summaries, but when a summary is chosen its full summary content is injected into the main request. This block is injected into the first system message (or prepended if no system message exists).

For tool-continuation requests, the context block is cached by session key and replayed from cache (avoiding repeated expensive retrieval on every tool hop).

---

## 5. Deep Analysis (Scheduled)

The analyzer runs every N hours (configured via `workers.analyzeIntervalHours`) and performs a comprehensive review of the entire knowledge base.

### 5a. Preconditions

The analyzer skips if:
- The system has been actively handling requests within the idle threshold
- Fewer than 10 new chunks AND fewer than 3 new summaries have appeared since the last analysis run
- Fewer than 5 total chunks exist

### 5b. Analysis Scope

The analyzer receives:
- All unsummarized chunks
- All summaries
- All existing open findings (for deduplication)

It identifies:
- **Contradictions:** Conflicting facts between chunks or summaries
- **Gaps:** Missing best practices, untested areas, undocumented conventions
- **Security concerns:** Hardcoded secrets, injection risks, missing auth
- **Refactoring opportunities:** Patterns that could be improved
- **Positive patterns:** Worth reinforcing

### 5c. Auto-Actions

Each finding can include automatic remediation actions:
- `delete` — remove a problematic chunk, summary, or file reference
- `update` — modify a chunk or summary's content
- `done` — mark another finding as implemented (e.g., when a new finding supersedes an old one)
- Gap findings (type `gap`) intentionally omit actions — future requests will naturally gather information in that area, and the finding is deleted when the gap is filled

Actions are applied automatically when the finding is created, with `implementFinding` orchestrating the mutations.

---

## 6. End-to-End Flow Summary

```
Request arrives
  │
  ├─ contextInjectMiddleware
  │   ├─ Stage 1: semantic/keyword retrieval
  │   ├─ Stage 2: LLM reranking (optional)
  │   ├─ Budget filling (global → domain)
  │   └─ Inject context into messages
  │
  ├─ learningPromptEnforcerMiddleware
  │   ├─ Inline mode: append extraction instruction to messages
  │   └─ Separate mode: strip instruction, defer to post-response
  │
  ├─ Main model responds (streaming or non-streaming)
  │   │
  │   ├─ Inline mode:
  │   │   └─ LearningExtractorStream strips learning block, stores learnings
  │   │
  │   └─ Separate mode:
  │       ├─ ResponseCaptureStream captures response + detects tool use
  │       ├─ queueSeparateLearningExtraction batches/debounces
  │       └─ flushSeparateLearningExtraction:
  │           ├─ Queries prior knowledge (unsummarized chunks + summary one-liners)
  │           ├─ Sends standalone prompt to learning model
  │           └─ Stores extracted learnings
  │
  └─ Client receives cleaned response (learning block removed)
```

```
Scheduled jobs (cron):
  │
  ├─ Categorizer (every N minutes, before summarization)
  │   └─ Re-classify unsummarized "general" chunks using keyword matching
  │
  ├─ Summarizer (every N minutes)
  │   ├─ Group unsummarized chunks by category
  │   ├─ Per-category: merge with existing or create new summary
  │   └─ Track lastSuccessfulRunAt per project
  │
  └─ Analyzer (every N hours, if idle)
      ├─ Review all chunks + summaries + findings
      ├─ Generate findings with auto-actions
      └─ Apply actions (delete/update) automatically
```

---

## 7. Known Limitations and Future Work

- **Unsummarized prior-knowledge cap:** `buildPriorKnowledgeBlock` still limits unsummarized chunks to the latest 75 entries. Very large unsummarized backlogs may benefit from a semantic relevance filter instead of pure recency.
- **Analyzer incremental scope:** The analyzer now ignores summarized chunk history, but it still sends the full unsummarized backlog and all summaries each run. Future work could reduce this further to only items that changed since `analyzerLastRun`.
- **Keyword-only categorization:** The categorizer uses simple keyword matching. An LLM-based categorizer would handle edge cases better but adds cost and latency.
