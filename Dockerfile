# ── Stage 1: Build the single executable ──────────────────────────────────
# Node.js SEA requires glibc — Alpine (musl) is NOT supported for SEA builds.
FROM node:24-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
COPY scripts/build-sea.mjs ./scripts/build-sea.mjs

# Build the SEA binary (Linux, CommonJS bundle, postject injection)
RUN npm run build:sea

# ── Stage 2: Minimal production image ─────────────────────────────────────
# The SEA binary embeds Node.js — no separate runtime needed.
FROM debian:bookworm-slim AS runner

# Minimal runtime deps for networking (the binary needs libstdc++ and ca-certs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Suppress the informational require() warning from Node.js SEA
ENV NODE_NO_WARNINGS=1

WORKDIR /app

# Copy ONLY the single executable and its runtime companions
COPY --from=builder /app/dist/sea/intelligent-context ./intelligent-context
COPY --from=builder /app/dist/sea/ui ./ui
COPY --from=builder /app/dist/sea/sql-wasm.wasm ./sql-wasm.wasm

# Data directory for SQLite (overridden by volume in compose)
RUN mkdir -p /app/data

EXPOSE 1234 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:9090/api/health || exit 1

# Diagnostic flags: write a report on V8 fatal errors (OOM, native crashes) and
# uncaught exceptions, and allow an on-demand report via `kill -USR2 <pid>`.
# Reports land in ~/.intelligent-context/crash-reports (set in processErrors.ts).
CMD ["./intelligent-context", "--report-on-fatal", "--report-on-uncaught-exception", "--report-on-signal", "--report-signal=SIGUSR2", "--trace-warnings", "--trace-uncaught"]
