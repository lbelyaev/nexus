# Nexus

A lightweight, modular AI agent gateway that connects terminal clients to AI agents via WebSocket, with real-time streaming, tool approval mediation, and policy enforcement.

```
User -> TUI -> WebSocket -> Gateway -> ACP -> Agent Runtime (Claude/Codex)
                                 |
                          Policy Engine
                          State Store (SQLite)
```

## Why Nexus?

Traditional AI agent gateways tend toward monolithic designs — single-process god objects, inverted auth, tight coupling to specific runtimes. Nexus takes a different approach:

- **Modular**: 9 focused packages, each with a single responsibility
- **Secure**: Token auth mandatory, policy-based tool approval, constant-time comparisons
- **Pluggable**: Any ACP-compatible agent runtime works (Claude Code, Codex CLI, etc.)
- **Streamable**: Real-time text deltas, tool status, and approval prompts over WebSocket
- **Portable**: Standard `node:*` APIs only — runs on Bun, Node, or Deno

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.2
- [Claude ACP adapter](https://www.npmjs.com/package/@zed-industries/claude-agent-acp)
- [Codex ACP adapter](https://github.com/zed-industries/codex-acp)

### Install & Build

```bash
git clone <repo> && cd nexus
bun install
bun run build
bun run test
```

### Start the Gateway (Claude runtime)

```bash
bun run gateway:dev:claude
```

The gateway will:
1. Load config from `config/nexus.default.json`
2. Generate an auth token (printed to console)
3. Spawn the ACP agent subprocess
4. Listen for WebSocket connections on `ws://127.0.0.1:18800/ws`

### Start the Gateway (Codex runtime)

```bash
bun run gateway:dev:codex
```

This loads `config/nexus.codex.json` and starts `@zed-industries/codex-acp`.

Codex auth options:

1. ChatGPT subscription login (Plus/Pro/etc): run `codex login` first.
2. API key: export `OPENAI_API_KEY` or `CODEX_API_KEY` before starting gateway.

### Start the Gateway (Multi-runtime: per-session Claude/Codex)

```bash
bun run gateway:dev:multi
```

This loads `config/nexus.multi.json` and starts one ACP process per runtime profile.
Use `/runtime <id>`, `/model <name>`, `/models`, `/alias <nick> <model-id>`, and `/status` in the TUI.

### Start the TUI

```bash
NEXUS_TOKEN=<token from gateway output> bun run --filter=@nexus/tui dev
```

The TUI connects to the gateway, creates a session, and lets you chat with the AI agent.

### Start the Headless CLI (`@nexus/cli`)

```bash
# one-shot
NEXUS_TOKEN=<token> bun run cli:dev -- --prompt "hello" --auto-approve

# interactive JSON lines
NEXUS_TOKEN=<token> bun run cli:dev
```

## Architecture

### Packages

| Package | Description | Deps |
|---------|-------------|------|
| `@nexus/types` | Shared types + runtime type guards | none |
| `@nexus/policy` | First-match-wins policy evaluation | types |
| `@nexus/state` | SQLite session + audit store (runtime adapter) | types, bun:sqlite / better-sqlite3 |
| `@nexus/acp-bridge` | ACP client, NDJSON streams, process management | types |
| `@nexus/gateway` | WS server, message routing, auth, orchestration | all above + ws |
| `@nexus/memory` | Pluggable memory provider interface + SQLite provider | state, types |
| `@nexus/client-core` | React hooks for WS connection + sessions | types, react |
| `@nexus/tui` | Terminal UI with Ink | client-core, ink, react |
| `@nexus/cli` | Headless WebSocket client for automation/pipelines | types, ws |

### Data Flow

```
TUI (Ink)                   Gateway                        Agent (cc-acp)
   |                           |                               |
   |-- session_new ----------->|                               |
   |<- session_created --------|-- initialize ----------------->|
   |                           |<- result ---------------------|
   |                           |-- session/new --------------->|
   |                           |<- result ---------------------|
   |                           |                               |
   |-- prompt ----------------->|-- session/prompt ------------>|
   |                           |                               |
   |<- text_delta -------------|<- session/update (chunk) -----|
   |<- text_delta -------------|<- session/update (chunk) -----|
   |<- tool_start -------------|<- session/update (tool_call) -|
   |<- tool_end ---------------|<- session/update (completed) -|
   |<- turn_end ---------------|<- response -------------------|
   |                           |                               |
   |-- cancel ----------------->|-- session/cancel ------------>|
```

### Policy Engine

The gateway evaluates tool usage against a policy config before allowing execution:

```json
{
  "rules": [
    { "tool": "Read", "action": "allow" },
    { "tool": "Exec", "pattern": "rm -rf", "action": "deny" },
    { "tool": "Exec", "action": "ask" },
    { "tool": "*", "action": "ask" }
  ]
}
```

- **allow**: Tool runs without user interaction
- **deny**: Tool is blocked, agent is notified
- **ask**: User sees an approval prompt in the TUI

Rules are evaluated first-match-wins. Pattern matching is substring-based.

## Configuration

### Gateway Config (`config/nexus.default.json`)

```json
{
  "port": 18800,
  "host": "127.0.0.1",
  "auth": { "token": "" },
  "runtime": { "command": ["npx", "@zed-industries/claude-agent-acp"] },
  "dataDir": "./data"
}
```

Multi-runtime profile (`config/nexus.multi.json`):

```json
{
  "defaultRuntimeId": "claude",
  "runtimes": {
    "claude": { "command": ["npx", "@zed-industries/claude-agent-acp"], "defaultModel": "claude-sonnet-4-5-20250929" },
    "codex": { "command": ["npx", "@zed-industries/codex-acp"], "defaultModel": "gpt-5.2-codex" }
  },
  "modelRouting": {
    "sonnet": "claude",
    "gpt-5": "codex"
  },
  "modelAliases": {
    "codex-fast": "gpt-5.2-codex-mini",
    "claude-latest": "claude-sonnet-4-5-20250929"
  },
  "modelCatalog": {
    "codex": ["gpt-5.2-codex", "gpt-5.3-codex"],
    "claude": ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929"]
  },
  "memory": {
    "enabled": true,
    "provider": "sqlite",
    "contextBudgetTokens": 1200,
    "hotMessageCount": 8,
    "warmSummaryCount": 4,
    "coldFactCount": 8
  }
}
```

Codex-only profile (`config/nexus.codex.json`):

```json
{
  "runtime": { "command": ["npx", "@zed-industries/codex-acp"], "defaultModel": "gpt-5.2-codex" }
}
```

| Field | Description |
|-------|-------------|
| `port` | WebSocket listen port |
| `host` | Bind address |
| `auth.token` | Auth token (auto-generated if empty) |
| `runtime.command` | ACP agent subprocess command |
| `runtimes.<id>.command` | ACP command for runtime registry mode |
| `defaultRuntimeId` | Default runtime when using `runtimes` |
| `modelRouting.<model>` | Map model aliases to runtime IDs |
| `modelAliases.<alias>` | Resolve model aliases to pinned provider model IDs |
| `modelCatalog.<runtimeId>[]` | Models shown by `/models` in TUI |
| `memory.enabled` | Enable/disable memory context system |
| `memory.provider` | Memory provider ID (currently `sqlite`) |
| `memory.*Count` / `memory.contextBudgetTokens` | Smart context retrieval/assembly tuning |
| `runtime.cwd` | Working directory for the agent (optional) |
| `dataDir` | SQLite database directory |

For reproducibility, prefer pinned model IDs in `modelAliases` (for example mapping `gpt-5` to a dated/provider-specific ID), then use the alias in `/model`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_CONFIG` | — | Path to gateway config file |
| `NEXUS_URL` | `ws://127.0.0.1:18800/ws` | Gateway URL (TUI) |
| `NEXUS_TOKEN` | — | Auth token (TUI) |
| `NEXUS_RUNTIME` | — | Preferred runtime for new TUI sessions |
| `NEXUS_MODEL` | — | Preferred model label for new TUI sessions |
| `NEXUS_MODEL_ROUTING` | — | Optional TUI model map, e.g. `sonnet=claude,gpt-5=codex` |

## Development

### Commands

```bash
bun run build         # Build all packages
bun run test          # Run all tests
bun run test:coverage # Run all tests with coverage
bun run typecheck     # Type-check without emitting
bun run dev           # Start all dev servers
bun run gateway:dev:claude # Gateway with Claude ACP runtime
bun run gateway:dev:multi   # Gateway with runtime registry (Claude+Codex)
bun run gateway:dev:codex  # Gateway with Codex ACP runtime
bun run cli:dev            # Headless CLI client
bun run tui:dev            # TUI client

# If you're already in packages/gateway:
bun run dev:claude
bun run dev:multi
bun run dev:codex

# Single package
bun run --filter=@nexus/gateway test
bun run --filter=@nexus/gateway test:watch
bun run --filter=@nexus/gateway test -- --coverage
```

### Testing

Tests run across all packages using vitest:

- **Types**: type guard validation
- **Policy**: evaluation logic
- **State**: SQLite CRUD, in-memory
- **ACP Bridge**: NDJSON, RPC, permission flow, process lifecycle
- **Gateway**: auth, config, router, server, E2E
- **Client Core**: React hooks
- **TUI**: Ink component rendering
- **CLI**: argument parsing and JSON message normalization

### Code Style

- Arrow functions only (`const fn = () => {}`)
- Named exports only (no `export default`)
- Standard `node:*` APIs (no `bun:*` imports)
- Strict TypeScript
- TDD — tests first

## Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| Bun | 1.2 | Runtime + package manager |
| Turborepo | 2 | Monorepo orchestration |
| TypeScript | 5.7 | Type safety |
| vitest | 3 | Test runner |
| bun:sqlite / better-sqlite3 | — | State persistence (runtime adapter) |
| ws | 8 | WebSocket server |
| Ink | 5 | Terminal React renderer |
| React | 18 | UI framework |

## License

Private — not yet licensed for distribution.
