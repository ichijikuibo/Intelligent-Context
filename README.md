# Intelligent Context

An AI proxy that builds up project context over time through auto-learning. Intercepts IDE requests to AI providers, injects relevant learned knowledge into each request, and extracts new learnings from each response — all transparently.

## How it Works

```
IDE (VS Code / Cursor / Cline)
    │  POST /v1/chat/completions
    ▼
Intelligent Context Proxy
    ├─ Detects project
    ├─ Injects learned context into system message
    ├─ Adds extraction instruction to request
    ├─ Forwards to AI provider (OpenAI / Anthropic)
    ├─ Strips learning block from response
    └─ Stores new learnings in DB
    ▼
IDE sees clean response + AI has project context
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and edit config
cp .env.example .env
# Add your OPENAI_API_KEY or ANTHROPIC_API_KEY

# 3. Run in development
npm run dev

# 4. Configure your IDE
# Set OpenAI base URL to: http://localhost:1234/v1
```

Open the management UI at **http://localhost:9090/ui**

## Single Executable Build (SEA)

Intelligent Context can be compiled into a **single standalone executable** using
[Node.js SEA](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html).
The resulting binary embeds the full Node.js runtime — no separate Node.js
installation is needed on the target machine.

```bash
# Build the single executable for your current platform
npm run build:sea
```

**Output** (in `dist/sea/`):
| File | Purpose |
|------|---------|
| `intelligent-context` (or `.exe`) | The standalone binary |
| `ui/` | Management UI (served at runtime) |
| `sql-wasm.wasm` | SQLite WASM runtime |

To distribute, ship these three items together. Place an optional
`intelligent-context.yaml` alongside the binary for configuration.

### Cross-platform builds from Windows

Use the PowerShell orchestrator to build **Windows + Linux binaries AND a
Docker image** in one command — using WSL2 for the Linux/Docker parts:

```powershell
# Build all three targets (requires WSL2 Debian with Node.js 24+)
.\scripts\build-all.ps1

# Skip individual targets as needed
.\scripts\build-all.ps1 -SkipWindows
.\scripts\build-all.ps1 -SkipDocker
.\scripts\build-all.ps1 -WslDistro Ubuntu
```

**Prerequisites for `build-all.ps1`:**
- WSL2 with a Debian (or other) distro running
- Node.js 24+ inside the WSL distro:
  ```bash
  wsl -d Debian
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- Docker Desktop with WSL2 integration enabled

**Platform support:** Windows, macOS, Linux (glibc — not Alpine/musl).

> **Limitations in SEA mode:** `@xenova/transformers` (semantic embeddings) is
> disabled — the ONNX WASM backend and HuggingFace model downloads are
> incompatible with single-executable packaging. The proxy falls back to
> keyword-based context selection automatically.

## Configuration

Edit `intelligent-context.yaml` in your project root:

```yaml
models:
  contextSelector: gpt-4o-mini  # Fast model for ranking context
  summarizer: gpt-4o-mini        # Condenses learning chunks
  analyzer: gpt-4o               # Deep analysis (runs idle/overnight)

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

context:
  tokenBudget: 4000              # Max tokens to inject per request
  autoSummarizeThreshold: 10     # Chunks before auto-summarization
```

## IDE Setup

**VS Code (recommended — Intelligent Context extension):**
Install the companion extension from [`vscode-extension/`](vscode-extension/README.md). It registers
Intelligent Context as a chat model provider, auto-discovers your configured models, and sends the
workspace/project headers for you — so no manual base-URL or model-ID entry is needed.

**VS Code / Copilot Chat (manual):**
Add to your VS Code settings:
```json
"github.copilot.advanced": {
  "openaiBaseUrl": "http://localhost:1234"
}
```
With the manual route you must hand-enter each model ID, since VS Code's custom-endpoint
configuration does not read `/v1/models`.

**Anthropic-compatible clients:**
Point the client at `http://localhost:1234` and use the Anthropic Messages API path `/v1/messages`.
Use this when the client expects Anthropic request and response shapes instead of OpenAI chat completions.

**Or set env var for other tools:**
```bash
export OPENAI_BASE_URL=http://localhost:1234/v1
```

**Other editors, IDEs, and coding agents (Cursor, Claude Code, Codex, Zed, JetBrains, opencode, Aider, Cline, Continue, Gemini CLI…):**
See [`docs/client-integrations.md`](docs/client-integrations.md) for per-client configuration, which
clients can forward `X-IC-*` headers, and which integration surface (extension, base URL, or MCP)
fits each one.

**Project detection** — the proxy auto-registers projects. For precise detection, add the `X-Project-Root` header with your workspace path. The Intelligent Context VS Code extension sends `X-Project-Root`, `X-IC-Project-Name`, `X-IC-File`, and `X-IC-Branch` automatically. When a client cannot inject those headers, you can configure a project `pathPattern` in the management UI so file paths mentioned in requests can be matched as a fallback.

**Localization** — the management UI and management/proxy error responses support locale negotiation. The recommended path is the `X-IC-Locale` header, with `Accept-Language` and the UI language selector as fallbacks. Built-in locales are English (`en`), Spanish (`es`), and Irish (`ga`). Locale catalogs are split into individual files under `src/i18n/locales/` and registered in `src/i18n/messages.ts`.

## Docker (Self-Hosted)

```bash
# Required by docker-compose.yml for the bundled Postgres container
export POSTGRES_PASSWORD='choose-a-strong-password'
docker compose up -d
```

The Docker image uses a multi-stage build to produce a **single executable**
binary. The final image contains **only** the compiled binary, the UI shell,
and the SQLite WASM runtime — no TypeScript source, no `node_modules`,
no npm, no dev tools.

When the first-run setup wizard saves run-mode or database changes, the Docker
container can restart itself automatically and the UI will reload once the new
process is back.

### Shipping the Docker image without source code

```bash
# Build the image
docker compose build

# Tag and push to your registry
docker tag intelligent-context-proxy your-registry/intelligent-context:latest
docker push your-registry/intelligent-context:latest

# Replace "build: ." with "image: your-registry/intelligent-context:latest"
# in docker-compose.yml and ship only:
#   - docker-compose.yml
#   - intelligent-context.yaml
```

### Building the Linux binary only (no Docker)

```bash
# On a Linux machine (or in a Linux VM/container):
npm ci
npm run build:sea
# Output: dist/sea/intelligent-context
```

## Install as Background Service

The install scripts now use the single executable binary — **no Node.js
installation required** on the target machine.

**Windows:**
```powershell
# Run as Administrator — builds the SEA binary automatically
.\scripts\install-service.ps1 -Action install
```

**Linux:**
```bash
# Builds the SEA binary automatically if needed
bash scripts/install-service.sh install
```

**macOS:**
```bash
bash scripts/install-service.sh install
```

To distribute a pre-built binary, set the `BINARY_PATH` variable:
```bash
BINARY_PATH=/opt/intelligent-context/intelligent-context bash scripts/install-service.sh install
```

The provided Docker and service installers also enable guarded self-restart for
the first-run setup flow, so saved startup settings can be applied without a
manual page refresh when the process is under Docker, `systemd`, `launchd`, or
NSSM supervision.

## Documentation

- [`docs/Intelligent Context Overview.md`](docs/Intelligent%20Context%20Overview.md) — what it is and why it exists
- [`docs/architecture.md`](docs/architecture.md) — system design, database schema, deployment modes
- [`docs/learning-process.md`](docs/learning-process.md) — how learnings are extracted, summarized, and analyzed
- [`docs/client-integrations.md`](docs/client-integrations.md) — configuring other editors, IDEs, and coding agents

## Architecture

| Component | Purpose |
|-----------|---------|
| Proxy Server | Receives IDE requests, injects context, forwards to AI |
| Learning Extractor | Parses AI responses for new project facts |
| Context Selector | Retrieves relevant chunks for each request |
| Summarizer | Condenses chunks into structured summaries |
| Analyzer | Deep analysis for patterns, security, suggestions |
| Management API | REST API + web UI for configuration |

## Directory Structure

```
src/
├── index.ts              Entry point
├── config/               Configuration loading
├── proxy/                HTTP proxy + adapters (OpenAI / Anthropic)
│   ├── adapters/
│   └── middleware/
├── learning/             Learning extraction engine
├── context/              Context selection + assembly
├── workers/              Background jobs (summarizer, analyzer)
├── db/                   Database schema + repositories
└── api/                  Management REST API
ui/                       Web-based management dashboard
vscode-extension/         VS Code chat model provider (companion client)
├── src/
│   ├── extension.ts      Activation, commands, background model polling
│   ├── provider.ts       languageModelChatProvider implementation
│   ├── proxyClient.ts    /v1/models + SSE chat client (OpenAI + Anthropic)
│   ├── connection.ts     Base URL + SecretStorage API key
│   ├── modelRegistry.ts  Model catalog cache
│   └── workspaceContext.ts  Workspace/file/branch headers
└── README.md
scripts/
├── build-sea.mjs         Single executable (SEA) build pipeline
├── build-all.ps1         Cross-platform orchestrator (Windows + WSL2/Docker)
├── install-service.ps1   Windows service installer
└── install-service.sh    Linux/macOS service installer (systemd/launchd)
```

## Roadmap

- **Phase 1 (MVP):** Proxy, learning extraction, keyword context selection, management UI ✓
- **Phase 2:** Semantic embeddings, summarization pipeline, LLM reranking, PostgreSQL
- **Phase 3:** VS Code extension, knowledge graph, SaaS multi-tenancy

## License

[MIT](LICENSE)
