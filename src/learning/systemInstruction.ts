/**
 * System-level instruction that informs the model about the \`ic\` tool's
 * surface.  The proxy injects this into the system message on every
 * project-scoped request so the model knows the tool exists, what
 * operations it supports, and when NOT to call it.
 *
 * Uses YAML-style descriptions which are more compact than prose and
 * equally well understood by modern models.
 *
 * The "when to call" imperative lives in a separate per-turn user message
 * (`LEARNING_CALL_TO_ACTION`) appended to the end of the messages array,
 * not in the system prompt.
 */
export const LEARNING_SYSTEM_INSTRUCTION = `You have access to the \`ic\` tool for all intelligent-context knowledge operations.  The tool accepts a single \`ops\` array parameter for batching multiple sub-operations in one call.

action:  get | list | create | update | delete | record
type:    chunk | summary | finding | file

USAGE:
  get     {type, ids:[id] or id}          -> entity/entities
  list    {type, data:{search,category,limit(20),offset(0)}} -> {total,items}
  create  {type, data:{fact,category,...}}  -> entity
  update  {type, id, data:{field:val,...}}  -> entity
  delete  {type, id}                       -> {deleted:true}
  record  {data:{learnings:[...]}}          -> results

record action ONLY — records project facts discovered from reading source files so they can be re-injected into future requests.
  learnings[N]:
    fact:       string  (one-sentence project truth)
    category:   string  (domain label e.g. "auth", "scheduler")
    confidence: number  0.0-1.0  (default 0.9)
    isNew:      boolean  true=new fact, false=refinement (default true)
    filesUsed?: [{name, purpose?}]
    codeExtracts?: [{fileName?, language?, symbols?[string], code?}]

WHEN TO CALL get:
- A summary in '## Project Context Shortlist' is linked to a file you are about to read — fetch it first; it likely contains pre-digested knowledge that reduces or eliminates the need to read source files.
- A summary's one-liner or preview bullets suggest it covers code, architecture, or patterns relevant to the request — fetch it; the full detail saves exploration time.
- The task is broad or complex (debugging, feature work, architecture changes) — fetch summaries tagged '[global]' and any matching the relevant categories; they cover project-wide conventions, dependency patterns, and known gotchas that inform your approach.
- You are about to call 'read_file' or 'grep_search' on an area that has summaries — fetching a summary first is ~10x cheaper than reading source files and may contain what you need directly.
WHEN TO CALL record:
- After reading a source file and learning something durable about its structure, purpose, behaviour, dependencies, or gotchas.
- When you discover how a file connects to the current request.

CONTEXT SOURCES YOU MAY SEE IN THIS TURN:
- \`## Project Context\` — past knowledge pre-selected by the proxy. Anything durable is usually already there.
- \`<gatherer_analysis>\` — a cheap pre-gather model's read-only pass over the codebase. Treat it as a SUMMARY of the files it read, not as ground truth; its file contents may be incomplete and its conclusions may be wrong. Re-read with \`read_file\` / \`grep_search\` when something looks off.
- Raw IDE tool output (\`read_file\`, \`grep_search\`, \`file_search\`) — these are the source of truth for what the codebase actually contains.

DERIVING LEARNINGS:
- A fact you can derive from the existing project context alone is NOT new — do not re-record it.
- A fact you can derive from a \`<gatherer_analysis>\` block alone is ALSO not new — the gatherer is just a reader, the underlying knowledge either already exists or doesn't.
- A new fact comes from THIS turn's reading: a file the gatherer did not already summarise, a previously-unrecorded gotcha, or a structural insight about how a file connects to the request. Record those.

Do NOT call for: task-specific/ephemeral facts, things already in the project context shortlist, or code you wrote this turn (unless it revealed a non-obvious project truth).

OTHER ACTIONS (get/list/create/update/delete):
  query existing knowledge or make small corrections.
  Prefer using the injected project context shortlist first before listing chunks or summaries.`;

/**
 * Tag used to mark the system instruction block so the middleware can
 * detect it has already been injected on a re-run (e.g. on a tool
 * continuation).  Idempotent re-injection is important because the
 * middleware runs once per request, including on continuations.
 */
export const LEARNING_INSTRUCTION_TAG = '[intelligent-context:learning-instruction]';

/**
 * Tag used to mark the per-turn user-message call-to-action that prompts
 * the model to call `record_learning` before finishing its response.
 * Carried in a `role: 'user'` message at the end of the messages array,
 * not in the system prompt, so it lands in the model's "current task"
 * window and is more reliably followed.
 */
export const LEARNING_CALL_TO_ACTION_TAG = '[intelligent-context:learning-call-to-action]';

/**
 * Per-turn reminder, delivered as a `role: 'user'` message at the end
 * of the messages array on the first request of a session (not on tool
 * continuations).  The proxy / gatherer sees this as a normal user
 * message, but the model recognises it as a directive: "do not answer
 * this, just call the `ic` tool with action: 'record' if appropriate
 * before responding to the previous messages."
 */
export const LEARNING_CALL_TO_ACTION = `${LEARNING_CALL_TO_ACTION_TAG}

Before you finish your response, call the \`ic\` tool with action "record" if THIS turn produced new, durable project knowledge that is NOT already in the injected \`## Project Context\` block and NOT already covered by a \`<gatherer_analysis>\` block in this conversation.

Source of truth for what is new:
- \`## Project Context\` = past knowledge. Anything you could derive from it alone was already known; do not re-record.
- \`<gatherer_analysis>\` = a cheap model's read-only pass over the codebase. Its contents are NOT new project knowledge — they are pre-gathered reads. Do not record facts that come only from the gatherer's summary; record only what YOU verified with a fresh \`read_file\` / \`grep_search\` / tool call in this turn, or what you discovered by connecting the gatherer's findings to the user's request in a way that the gatherer did not.
- Raw IDE tool output you fetched this turn = the source of truth for new facts.

When you call the tool, batch all file-derived facts into a single \`ic\` call via \`data.learnings\`. Skip the call entirely if you did not fetch any source files in this turn, or if everything you learned is already in the project context shortlist / a previous \`<gatherer_analysis>\` block. Do not respond to this message — it is just a reminder to call the tool before finishing your response to the previous user request.`;
