# Intelligent Context — VS Code extension

> **This extension has no functionality on its own.**
>
> It is a companion client for the [Intelligent Context](https://github.com/ichijikuibo/Intelligent-Context)
> proxy, which must be installed and running separately. Without a reachable
> Intelligent Context proxy, this extension does not provide any AI models and
> offers no other features.

## What it does

Intelligent Context is a local proxy that sits between your IDE and the AI
providers you already pay for. It injects relevant project knowledge into every
request and learns new facts from every response, so each conversation starts
with your project's context instead of a blank slate.

This extension connects VS Code's chat model picker to that proxy so you can:

- **Pick a model without typing model IDs.** VS Code reads the model list from
  your proxy's `/v1/models` endpoint, so every provider and model you have
  configured in the Intelligent Context UI appears automatically — including the
  correct context-window size for each one.
- **Use the same model from two providers.** If opencode Go and CommandCode both
  offer `deepseek-v4`, you will see both entries, each labelled with its provider
  (for example `opencode Go · deepseek-v4` and `CommandCode (OpenAI) · deepseek-v4`)
  and can choose either. The picker's secondary line shows the raw upstream model
  ID and the wire format the proxy will use.
- **Get project context injected automatically.** The extension sends your
  workspace root, workspace name, current file, and active git branch as headers
  on every request, so the proxy attributes each conversation to the right
  project without any manual header configuration.

## Requirements

1. **A running Intelligent Context proxy.** See the
   [main repository](https://github.com/ichijikuibo/Intelligent-Context)
   for install instructions. By default it listens on `http://localhost:1234`.
2. **At least one AI provider configured** in the Intelligent Context management
   UI (`http://localhost:9090/ui` → Providers).
3. **An API key** from the management UI (My API Keys), unless your proxy is
   configured without authentication.

## Getting started

1. Install and start the Intelligent Context proxy.
2. Install this extension.
3. Run **Intelligent Context: Configure Connection** from the Command Palette.
   Enter your proxy URL (default `http://localhost:1234`) and your API key.
4. Open the VS Code chat model picker. Your Intelligent Context models appear
   under the **Intelligent Context** vendor.

The API key is stored in VS Code's encrypted secret storage — never in
`settings.json` — and is never written to logs.

## Commands

| Command | Description |
| --- | --- |
| **Intelligent Context: Configure Connection** | Set the proxy URL and API key, then verify the connection. |
| **Intelligent Context: Refresh Model List** | Re-fetch the model list from the proxy. |
| **Intelligent Context: Show Status** | Open a read-only view of the connection state and available models. |
| **Intelligent Context: Clear Stored API Key** | Remove the API key from secret storage. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `intelligentContext.baseUrl` | `http://localhost:1234` | Base URL of the proxy. |
| `intelligentContext.apiKeyHint` | `true` | Prompt for the API key once if none is stored. |
| `intelligentContext.sendWorkspaceContext` | `true` | Send `X-Project-Root`, `X-IC-Project-Name`, `X-IC-File`, and `X-IC-Branch` headers. |
| `intelligentContext.modelRefreshIntervalMinutes` | `0` | Poll the model list on this interval. `0` disables polling. |
| `intelligentContext.requestTimeoutMs` | `600000` | Timeout for a single chat request. |
| `intelligentContext.maxOutputTokensOverride` | `0` | Override the output-token ceiling reported by the proxy. |

## Headers sent to the proxy

| Header | Purpose |
| --- | --- |
| `X-Project-Root` | Absolute workspace root, used to find or create the project. |
| `X-IC-Project-Name` | Workspace name, used as a softer match when the path differs between machines. |
| `X-IC-File` | The file currently open in the editor. |
| `X-IC-Branch` | The active git branch, read from `.git/HEAD`. |
| `X-Session-Id` | A stable per-workspace identifier so the proxy keeps conversation continuity. |

Your API key is sent as `Authorization: Bearer <key>` and is never logged.

## Troubleshooting

### My answer is collapsed into "Completed N steps"

VS Code collapses the intermediate work of a completed agent turn while keeping
the final response visible. This is controlled by a **VS Code setting**, not by
this extension:

| Setting | Default | Description |
| --- | --- | --- |
| `chat.agent.collapseCompletedResponses` | `true` | Controls whether completed chat responses collapse intermediate work while keeping the final response visible. |

To always show the full turn, set it to `false` in your `settings.json`:

```json
{
   "chat.agent.collapseCompletedResponses": false
}
```

### The final answer starts mid-sentence

VS Code only merges consecutive text parts while nothing sits between them. Any
non-text part — a thinking part, a tool call, or a marker like the one an agent
emits when it signals that it is finished — splits the reply into two separate
markdown parts. The collapse then treats only the **last** text run as the final
response and folds the earlier text into the disclosure, so the visible answer
begins part-way through a sentence.

The extension reduces one common source of this by deferring reasoning that
arrives after the answer has started (see `createReasoningGate` in
`src/proxyClient.ts`), so a late thinking part cannot split the answer. It cannot
guard against tool calls that arrive after the answer, because those are emitted
by the model itself.

Only `warning` parts that opt into `keepVisibleWhenCollapsed` escape the
collapse; text, thinking and tool parts do not.

**Workarounds:**

- Disable the collapse entirely with `chat.agent.collapseCompletedResponses`.
- If you are writing an agent prompt, emit the final answer as the **last**
   content, with no tool call after it, so the answer remains one contiguous run.

### Distinguishing intended collapse from a split answer

- Expand the disclosure. If the hidden text is genuinely interim commentary and
   the visible text is a complete answer, this is the intended behaviour.
- If the visible text continues a sentence that started in the hidden text, the
   answer was split and the collapse kept only the tail.

## Building from source

```bash
cd vscode-extension
npm install
npm run compile
```

To produce a `.vsix` for local installation or marketplace upload:

```bash
npm run package
```

If you intend to publish, set `publisher` in `package.json` to your own
Marketplace publisher ID first.

## Privacy

This extension sends your chat messages to the Intelligent Context proxy you
configure. Where those messages go next depends entirely on the providers you
have configured in that proxy — the extension makes no outbound requests of its
own and collects no telemetry.

## See also

- [`docs/client-integrations.md`](../docs/client-integrations.md) — connecting other clients
  (Cursor, Claude Code, Codex, Zed, JetBrains, opencode, Aider, Cline, Continue) to the same proxy.
