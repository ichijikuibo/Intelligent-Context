# Client Integrations — Where Else an Intelligent Context Client Can Be Built

_Last researched: 2026-09-26. Sources are linked inline. Vendor behaviour in this space changes
quickly — re-verify the "Confirm before building" items at the bottom before committing effort._

---

## Why this document exists

Issue #6 produced a **VS Code companion extension** ([`vscode-extension/`](../vscode-extension)) that
registers Intelligent Context as a chat model provider. The obvious next question is: *which other
editors, IDEs, and coding agents can host an equivalent client?*

Researching that surfaced an important structural finding, which is the main point of this document:

> **Only a small number of clients can host a model-provider extension. Most integrate by being
> pointed at a base URL. A third group can only be reached through MCP or a config file.**
>
> These are three genuinely different engineering problems, not one problem repeated N times.

The practical consequence for Intelligent Context is that the product should expose **three
integration surfaces** rather than chasing a client-by-client extension for every tool.

---

## The three integration surfaces

| Surface | Mechanism | What the client gets | Header support | Build cost |
| --- | --- | --- | --- | --- |
| **1. Model-provider extension** | `languageModelChatProvider` API (VS Code family only) | Auto-discovered models, per-model context sizes, custom headers | **Full** — arbitrary `X-IC-*` headers | High (a real extension per IDE) |
| **2. Base-URL configuration** | Point the client's OpenAI/Anthropic base URL at the proxy | All configured models, but the client must be told model IDs | **Partial** — depends on the client's `headers` support | None to low (documentation only) |
| **3. MCP server** | Expose learning tools over Model Context Protocol | The model can query/edit learnings; **no context injection** | N/A | Medium, but works everywhere |

Surface 2 is where almost all the value-per-effort is. The proxy already speaks both wire protocols,
so most of these clients need **zero code changes** — just a documented base URL.

---

## The `/v1/models` catalog contract

Any client that builds a model picker consumes this response, so its shape matters. Each entry
carries more than the bare OpenAI triple:

| Field | Purpose |
| --- | --- |
| `id` | **The value to send as `model` when requesting.** Provider-scoped, e.g. `CCO-deepseek-v4`. |
| `model_id` | The raw upstream model ID, e.g. `deepseek-v4`. Informational. |
| `display_name` | Human label, **prefixed with the provider name**, e.g. `CommandCode (OpenAI) · deepseek-v4`. |
| `provider_name` / `provider_id` | Which configured provider serves this entry. |
| `api_format` | `openai` (chat completions) or `anthropic` (messages) — tells the client which route to call. |
| `context_window` | Raw model context window, in tokens. |
| `max_input_tokens` | Prompt budget (window minus reserved response and overhead). |
| `max_output_tokens` | Tokens reserved for the reply. |

### Two rules integrators must follow

1. **Send `id` (or `model_id`), never `display_name`.** `display_name` is a human label that is not a
   valid wire model. The proxy resolves the provider from the prefix in `id` (or from the
   `X-Provider-Id` header).
2. **Never deduplicate by `model_id` alone.** Gateways routinely expose the same model — opencode Go
   and CommandCode can share dozens of identically-named entries with **different** context windows
   and **different** wire formats. The provider prefix is what disambiguates them, so collapsing on
   `model_id` would misroute requests to the wrong endpoint.

> **Tolerance:** `display_name` is nevertheless accepted if a client sends it. The proxy matches the
> label back to a provider + raw model ID and rewrites the outgoing request, so the upstream never
> receives a human label. Label matching is exact, and the provider name inside the label is
> authoritative when it matches a configured provider — so two gateways exposing the same label still
> cannot shadow each other. Prefer `id` regardless: label matching costs an extra provider lookup and
> cannot disambiguate a label that two providers render identically.

### Why provider-scoped metadata matters

Provider model metadata (context window, display name, wire format) is cached per **provider + model
ID**, not per model ID. Two providers reporting the same model keep their own values, so
`getReportedApiFormatForProvider(providerId, modelId)` returns the format that provider actually
serves rather than whichever one synced last. Clients that surface `api_format` can trust it to pick
the correct route.

---

## Summary matrix

| Client | Extension host? | Can point at a custom base URL? | Custom headers? | Native MCP? | Recommended surface | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| **VS Code** (Copilot Chat) | ✅ Yes | ✅ Custom Endpoint provider | ⚠️ `requestHeaders` on custom endpoint | ✅ Yes | **1** — done | ✅ Shipped |
| **Cursor** | ✅ Open VSX | ❌ Own chat routes via Cursor's servers | ❌ | ✅ Yes | **2/3** via an installed extension (Cline/Continue) | Low |
| **Windsurf / Devin Desktop** | ⚠️ Restricted | ❌ | ❌ | ✅ Yes | **3** — MCP | Low |
| **Cline** (VS Code ext) | n/a (is an ext) | ✅ "OpenAI Compatible" base URL | ❌ (but can use VS Code LM API) | ✅ Yes | **2** — document, + inherit our provider | **Lowest** |
| **Continue** (VS Code/JetBrains ext) | n/a (is an ext) | ✅ `apiBase` in `config.yaml` | ✅ `requestOptions.headers` | ✅ Yes | **2** — document | **Lowest** |
| **Roo / Kilo Code** (VS Code ext) | n/a (is an ext) | ✅ OpenAI-compatible | ❌ | ✅ Yes | **2** — document | Lowest |
| **Zed** | ✅ Rust extensions | ✅ OpenAI- and Anthropic-compatible `api_url` | ✅ `custom_headers` | ✅ Yes | **2** — document | Low |
| **JetBrains AI Assistant** | ✅ Plugin SDK | ✅ "OpenAI-compatible" provider | ❌ not documented | ✅ Yes (MCP server) | **2** — document | Low |
| **Claude Code** (CLI) | n/a | ✅ `ANTHROPIC_BASE_URL` | ✅ **`ANTHROPIC_CUSTOM_HEADERS`** | ✅ Yes | **2** — document (best-in-class) | **Lowest** |
| **Codex** (CLI) | n/a | ✅ `model_providers.<id>.base_url` | ✅ `http_headers` | ✅ Yes | **2** — once a `/v1/responses` route exists | Medium |
| **Gemini CLI** | ✅ `gemini-extension.json` | ⚠️ Gemini/Vertex only | ⚠️ | ✅ Yes | **3** — MCP + extension | Medium |
| **opencode** (CLI/TUI) | n/a | ✅ `provider.*.options.baseURL` | ✅ `options.headers` | ✅ Yes | **2** — document | **Lowest** |
| **Aider** (CLI) | n/a | ✅ `OPENAI_API_BASE` | ❌ | ❌ | **2** — document | Lowest |

---

## Surface 1 — Model-provider extensions (VS Code family)

Only clients built on the VS Code extension host can host the kind of extension we already shipped.
The `languageModelChatProvider` API is now **stable** (no `enabledApiProposals` needed) and is what
lets VS Code's model picker be populated from our `/v1/models`.

### VS Code ✅ done

The reference implementation. Verified against the official docs:

- Contribution point: `contributes.languageModelChatProviders` with a `vendor` and optional
  `managementCommand`
  ([docs](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)).
- Runtime hook: `vscode.lm.registerLanguageModelChatProvider(vendor, provider)`.
- Provider interface: `provideLanguageModelChatInformation` / `provideLanguageModelChatResponse` /
  `provideTokenCount`.
- VS Code's own **Custom Endpoint** provider can also reach the proxy without our extension, using
  `requestHeaders` to carry `X-IC-*` headers and `contextWindow` to size the model
  ([docs](https://code.visualstudio.com/docs/copilot/customization/language-models)).

Caveat worth knowing: **`LanguageModelChatMessageRole` has only `User` and `Assistant`** — there is no
`System` role. System prompt text must ride inside a user message. We already handle this.

### Cursor ⚠️ partial

Cursor uses the **Open VSX registry** for extensions and applies its own malware/supply-chain review
before listing ([docs](https://cursor.com/docs/configuration/extensions)). So VS Code extensions
*can* run in Cursor.

However, Cursor's **own chat cannot be pointed at a local proxy.** Its Bring-Your-Own-Key feature
supports OpenAI / Anthropic / Google / Azure / Bedrock **API keys only**, and the docs are explicit
that "all requests are routed through Cursor's servers for final prompt building"
([docs](https://cursor.com/docs/settings/api-keys)). There is no custom base-URL field, so a
`http://localhost:1234` proxy is unreachable from Cursor's native chat.

Practical routes into Cursor:

1. **A third-party extension installed in Cursor** (Cline, Continue, Roo) — these *do* accept a custom
   base URL, so the proxy works there.
2. **A CLI agent in Cursor's terminal** (Claude Code, Codex, opencode, Aider) — covered by Surface 2.
3. **MCP** for learning-tool access (Surface 3).

Whether Cursor honours the `languageModelChatProviders` contribution point in its extension host is
**unconfirmed** and should be tested before relying on it.

### Windsurf / Devin Desktop ⚠️ restricted

Windsurf has been rebranded to **Devin Desktop**. The current docs state that "You cannot install
extensions through any marketplace on Devin Desktop", and that other AI completion extensions are
explicitly incompatible
([docs](https://docs.devin.ai/desktop/getting-started)). Treat extension-based integration as **not
available** and plan on MCP instead.

---

## Surface 2 — Base-URL configuration (the high-leverage option)

These clients need **no code** from us — only documentation. The proxy already serves
`/v1/chat/completions`, `/v1/messages`, and `/v1/models`, so any OpenAI- or Anthropic-compatible
client can be aimed at it.

The catch is **project detection**. Our detection chain currently runs: explicit root header →
body hint → `X-IC-Project-Name` name hint → path-pattern matching → default project. A client that
sends no headers can only ever reach the last three. That makes the header support column above
load-bearing — and is why item 6 on the roadmap (path extraction, conversation continuity,
`X-Session-Id` continuity) matters more than it looks.

### Clients that *can* send custom headers 🎯

These get full project attribution, same as the VS Code extension. **Prioritise these.**

| Client | How | Notes |
| --- | --- | --- |
| **Claude Code** | `ANTHROPIC_CUSTOM_HEADERS` (`Name: Value`, newline-separated) | Plus `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. Best-supported CLI path. ([docs](https://code.claude.com/docs/en/env-vars)) |
| **opencode** | `provider.<id>.options.headers` | Plus `options.baseURL`. Use `npm: "@ai-sdk/openai-compatible"`. ([docs](https://opencode.ai/docs/providers/)) |
| **Continue** | `models[].requestOptions.headers` | Plus `apiBase`. ([docs](https://docs.continue.dev/reference)) |
| **Zed** | `language_models.<provider>.custom_headers` | Supported by OpenAI-compatible, Anthropic-compatible, and first-class providers. Zed **also** lets you declare per-model `max_tokens`, `capabilities.tools`, and `capabilities.chat_completions`, which maps onto our enriched `/v1/models` fields. ([docs](https://zed.dev/docs/ai/use-api-access)) |
| **Codex** | `model_providers.<id>.http_headers` (static) | Plus `base_url` and `env_key`. Codex speaks the Responses API — see the dedicated section below. ([docs](https://learn.chatgpt.com/docs/config-file/config-reference)) |
| **VS Code (Custom Endpoint)** | `requestHeaders` with `${apiKey}` token | Already works today via settings JSON, without our extension. |

### Clients that cannot send headers

| Client | How to configure | Consequence |
| --- | --- | --- |
| **Cline** | API Provider → "OpenAI Compatible"; set Base URL, API Key, Model ID | Project detection falls back to path patterns. **Bonus:** Cline also lists "VS Code Language Model API" as a provider, so once our VS Code extension is installed Cline can consume our models directly. |
| **Roo / Kilo Code** | OpenAI-compatible config (Base URL, API Key, Model ID, model config) | Same as Cline. Requires native tool calling. ([docs](https://roocodeinc.github.io/Roo-Code/providers/openai-compatible)) |
| **JetBrains AI Assistant** | Settings → Tools → AI Assistant → Providers & API keys → OpenAI-compatible (Base URL, API key, model, context size, max output tokens) | Note: local/custom models **cannot invoke MCP tools** per the docs, and code completion needs a FIM-capable model. ([docs](https://www.jetbrains.com/help/ai-assistant/use-custom-models.html)) |
| **Aider** | `OPENAI_API_BASE` + `OPENAI_API_KEY`, then `aider --model openai/<model-id>` | Also supports `--alias` and `.aider.model.metadata.json` for context/cost of unknown models. ([docs](https://aider.chat/docs/llms/openai-compat.html)) |

### Codex needs a Responses API route — and the architecture is already shaped for it

Codex's custom provider config exposes `wire_api`, but as of this research **`responses` is the only
supported value**. Codex speaks the OpenAI **Responses** API, not chat completions, so it cannot talk
to the proxy today.

This is worth doing beyond Codex. The Responses API is becoming the default surface for
OpenAI-compatible providers generally — Zed's OpenAI-compatible provider switches to it via
`capabilities.chat_completions: false`, and Zed's OpenCode model config exposes
`"openai_responses"` as a peer of `"openai_chat"` and `"anthropic"`. Adding a third route is more
forward-looking than a Codex-only patch.

The good news is that the proxy is **already parameterised by client protocol**, so a third one drops
into the existing seams rather than requiring a parallel implementation.

#### Why it is a slot-in

`ClientProtocol` is currently a two-member union, and every protocol-specific decision already flows
through it:

```ts
// src/proxy/clientProtocols.ts
export type ClientProtocol = 'openai' | 'anthropic';
```

That single type is the extension point. The pieces that already branch on it:

| Seam | Where | What a third member needs |
| --- | --- | --- |
| Route factory | `router.ts` → `createContextProxyHandler(clientProtocol)` | One new `router.post('/v1/responses', …, createContextProxyHandler('responses'))` — the middleware chain, provider-count check, and injection wiring are all reused unchanged. |
| Request normalisation | `normalizeRequestForClientProtocol(body, clientProtocol)` in `clientProtocols.ts` | A `responses` branch that maps `input` items + `instructions` → the internal `ProxyRequest` shape. |
| Learning tool shapes | `getSingleIcToolForClientProtocol` / `getLearningToolsForClientProtocol` in `tools/definitions.ts` | A `responses` variant. Note the Responses tool schema is **flat** (`{type:'function', name, parameters}`), not nested under `function` like chat completions. |
| Tool-continuation detection | `isToolContinuation` in `toolContinuation.ts` | Recognise `function_call` / `function_call_output` items. Today it only checks `role:'tool'` and pure `tool_use` / `tool_result` blocks. |
| Upstream protocol mapping | `providerTypeToToolProtocol` in `upstream.ts` | Maps upstream *provider* type → tool protocol; needs a third case if a Responses-speaking upstream is ever added. |
| Streaming bridge | `anthropicSseBridge.ts` | **The real work** — see below. |

Because the two-way split already exists, the middleware chain, context injection, learning
extraction, and IC interception are protocol-agnostic. That is the user-visible behaviour and it
needs no changes.

#### What is genuinely new work

The three Responses-API differences that matter:

1. **Flat tool definitions.** Chat completions nests the schema under `function`; Responses does not.
   A `responses` tool is `{ type: 'function', name, description, parameters, strict }`.
2. **Item-based rather than role-based turns.** There are no `tool_calls` on an assistant message.
   Tool calls and results are first-class *items* — `function_call`
   (`{ call_id, name, arguments }`, where `arguments` is a JSON string) and `function_call_output`
   (`{ call_id, output }`) — carried in the same `input` array as messages. The internal
   `ChatMessage` model is role-based, so this needs a bidirectional mapping.
3. **Different SSE event names.** Streaming uses `response.output_text.delta`,
   `response.output_item.added`, `function_call_arguments.delta`, and so on, instead of
   `choices[].delta`. `UnifiedProxyStream`'s IC interception is driven by parsing SSE payloads, so it
   needs to understand these event shapes.

The streaming path is therefore the bulk of the effort, not the routing. This is the same class of
work as the existing `AnthropicToOpenAiStream` Transform and `convertOpenAiSseToAnthropic` helper —
a `ResponsesToOpenAiStream` and a `convertOpenAiSseToResponses` would be their structural analogues.
The SSE parser must also keep buffering partial events, since transport chunks do not align with
`data:` boundaries.

#### Suggested sequencing

1. Add `'responses'` to the `ClientProtocol` union and give it a `normalizeRequestForClientProtocol`
   branch — the compiler then lists every seam needing a third case.
2. Add the `responses` learning-tool shape and extend `isToolContinuation`.
3. Add the non-streaming path first: `POST /v1/responses` → internal request → upstream → Responses
   JSON. Easier to test than streaming, and validates the item mapping.
4. Add the streaming bridge and extend `UnifiedProxyStream`'s IC interception to the new events.
5. Only then point Codex at `http://localhost:1234/v1` and confirm context injection works.

Steps 1–3 are where the "slots in easily" instinct holds. Step 4 is a real chunk of work, and step 5
still depends on the open `wire_api` question below.

---

## Surface 3 — MCP server (the universal fallback)

Every client in the matrix above has native MCP support. The management API hosts an **MCP server**
at `http://<management-host>:<management-port>/mcp` (see [`src/mcp/`](../src/mcp)), exposing the
`ic_*` learning tools — list/get/create/update/delete for chunks, summaries, and findings. It
authenticates the caller with the same API keys used by the proxy.

That gives every client on this list — including Cursor, Windsurf/Devin, JetBrains, Gemini CLI, and
the CLIs — a way to read and write project learnings with no per-client extension work.

What MCP does **not** do is inject context before the request or extract learnings afterwards. That
remains the proxy's job. So MCP is complementary to the proxy, not a replacement for it.

---

## Recommended strategy

**Phase A — document, don't build (near-zero cost, broadest reach).**
Add a short "Connect your client" section covering Claude Code, opencode, Continue, Cline, Zed,
JetBrains, Aider, and VS Code's Custom Endpoint. Ship the exact config snippets. This reaches more
users than any single extension and directly serves the existing Shared-package audience.

**Phase B — harden headerless project detection.**
Since most Surface-2 clients cannot send headers, invest in roadmap item 6: better path extraction,
`X-Session-Id` conversation continuity, and the `?ic-debug=1` diagnostic. This is what makes
Surface 2 *actually good* rather than merely functional.

**Phase C — MCP server.**
Highest reach-per-effort for learning-tool access, and the only viable path for Cursor's native chat
and Windsurf/Devin.

**Phase D — Responses API as a third client protocol.**
Not a Codex-only patch. The `ClientProtocol` union is already the extension point, and the Responses
API is becoming a common OpenAI-compatible surface — Codex requires it, and Zed exposes it as
`capabilities.chat_completions: false` and as a selectable `protocol`. Adding `'responses'` extends
the existing two-way split rather than creating a third parallel implementation. See the sequencing
notes above — the streaming bridge is the real work.

**Phase E — consider a Continue/Zed-style config generator.**
A management-UI "copy config for your client" panel that emits the right snippet per tool is a cheap
UX win once Phase A's snippets exist.

---

## Priority ranking by value ÷ effort

| Rank | Item | Effort | Reach |
| --- | --- | --- | --- |
| 1 | Documentation for Claude Code / opencode / Continue / Cline / Aider | Very low | Very high |
| 2 | Project-detection hardening (roadmap item 6) | Low | Enables all of Surface 2 |
| 3 | MCP server exposing `ic_*` tools | Medium | Universal |
| 4 | Zed + JetBrains config docs | Low | Medium |
| 5 | "Copy config" panel in the management UI | Low | Medium |
| 6 | `/v1/responses` route (third client protocol) | Medium | Codex + forward-looking |
| 7 | Cursor-native extension (only if the contribution point is honoured) | Medium | Uncertain |

---

## Confirm before building

These are the items where the research left genuine uncertainty or where vendor behaviour is likely
to have moved. Verify each before committing engineering effort.

1. **Does Cursor's extension host honour `contributing.languageModelChatProviders`?** Not documented.
   Test by installing our VSIX in Cursor and checking the model picker.
2. **Does JetBrains AI Assistant accept custom headers** on the OpenAI-compatible provider? Not in
   the settings reference.
3. **Is `wire_api` in Codex still `responses`-only?** This determines whether the proxy needs a
   `/v1/responses` route at all — the rest of the routing work is reusable either way.
4. **Windsurf/Devin Desktop extension policy** — the current docs say no marketplace installs, but
   earlier versions used Open VSX. Confirm the shipping behaviour for the version users actually run.
5. **Gemini CLI custom endpoints** — model access appears Gemini/Vertex-only. Confirm whether any
   OpenAI-compatible base URL override exists before scoping a provider integration.

---

## See also

- [`vscode-extension/README.md`](../vscode-extension/README.md) — the shipped client and its header reference
- [`architecture.md`](architecture.md) — system design, data model, and deployment modes
- [`learning-process.md`](learning-process.md) — how requests are learned from and summarized
- [`../src/mcp/`](../src/mcp) — the MCP server and the `ic_*` learning tools it exposes
