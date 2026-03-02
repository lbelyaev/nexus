# CLAUDE.md — Nexus Development Guide

## What is Nexus?

Nexus is a lightweight, modular AI agent gateway. It proves the full chain:
**User -> TUI -> WebSocket -> Gateway -> ACP -> Agent Runtime** with real-time streaming and approval mediation.

## Quick Start

```bash
bun install          # install all deps
bun run build        # build all packages
bun run test         # run all tests
bun run test:coverage # run all tests with coverage
bun run typecheck    # typecheck without emitting
```

### Run the gateway

```bash
bun run gateway:dev:claude
```

### Run the gateway with Codex

```bash
bun run gateway:dev:codex
```

### Run the gateway with runtime registry (Claude + Codex)

```bash
bun run gateway:dev:multi
```

If you're in `packages/gateway`, use:

```bash
bun run dev:multi
```

### Run the TUI

```bash
NEXUS_TOKEN=<token from gateway output> bun run tui:dev
```

### Run the headless CLI

```bash
NEXUS_TOKEN=<token from gateway output> bun run cli:dev -- --prompt "hello"
```

TUI control commands:
- `/runtime <id>` sets default runtime and creates a new session
- `/model <name>` sets model label, applies model→runtime routing, and creates a new session
- `/models` lists runtime defaults, model catalog, and known aliases
- `/alias <nickname> <model-id>` adds a local TUI nickname for model selection
- `/status` prints current connection/session/runtime/model and live counters

Model selection notes:
- `modelRouting` decides which runtime handles a model alias.
- `modelAliases` resolves aliases (for example `gpt-5`) to pinned provider IDs for reproducibility.
- `modelCatalog` feeds `/models` and is configured per runtime.

## Project Structure

```
nexus/
├── config/                     # Runtime configuration
│   ├── nexus.default.json      # Gateway config (port, auth, runtime command)
│   ├── nexus.multi.json        # Runtime registry config (claude + codex)
│   ├── nexus.codex.json        # Gateway config for Codex ACP runtime
│   └── policy.default.json     # Tool approval policy rules
├── docs/                       # Architecture docs & plans
└── packages/
    ├── types/                  # Shared types + type guards (zero deps)
    ├── policy/                 # Policy evaluation engine (pure logic)
    ├── state/                  # SQLite state store (sessions + audit)
    ├── acp-bridge/             # ACP client, NDJSON stream, subprocess manager
    ├── gateway/                # WS server, router, auth, orchestration
    ├── client-core/            # React hooks (useConnection, useSession, useApproval)
    ├── tui/                    # Terminal UI (Ink 5 + React 18)
    └── cli/                    # Headless WS client for automation
```

## Dependency Graph

```
types (zero deps)
  ├── policy
  ├── state (+bun:sqlite or better-sqlite3 via runtime adapter)
  ├── memory (pluggable memory provider interface + SQLite provider)
  ├── acp-bridge
  ├── client-core (+react)
  │     └── tui (+ink)
  ├── cli (+ws)
  └── gateway (+ws, policy, state, acp-bridge)
```

## Code Style

- **Arrow functions only**: `const fn = () => {}`, never `function fn() {}`
- **Named exports only**: no `export default`
- **No bun-scoped imports**: use `node:*` and npm packages only (portable to Node/Deno)
- **Strict TypeScript**: `strict: true`, ESNext target, bundler module resolution
- **Test framework**: vitest (not bun:test)
- **TDD**: tests first, implementation second

## Architecture Rules

- Gateway owns the Client <-> Gateway protocol (NOT ACP)
- Gateway translates between its protocol and ACP
- ACP sessions are 1:1 with gateway sessions
- Policy is evaluated at the gateway level, not in the agent
- Auth is mandatory — token required on every WS connection
- State store holds session metadata + audit log (NOT transcripts — Claude Code owns those)

## Key Protocols

### Client <-> Gateway (WebSocket JSON)

**ClientMessage** types: `session_new`, `prompt`, `cancel`, `approval_response`, `session_list`
**GatewayEvent** types: `session_created`, `text_delta`, `tool_start`, `tool_end`, `approval_request`, `turn_end`, `error`, `session_list`

### Gateway <-> Agent (ACP over NDJSON stdio)

JSON-RPC 2.0 per the [Agent Client Protocol](https://agentclientprotocol.com) spec:
- **Client → Agent requests**: `initialize`, `session/new`, `session/prompt`
- **Client → Agent notifications**: `session/cancel`
- **Agent → Client notifications**: `session/update` (text chunks, tool calls)
- **Agent → Client requests**: `session/request_permission` (expects permission response)

Key ACP shapes:
- `initialize`: `{ protocolVersion: 1, clientCapabilities: {} }`
- `session/new`: `{ cwd: string, mcpServers: [] }` → returns `{ sessionId }`
- `session/new`: gateway also sends `model` when selected/resolved
- `session/prompt`: `{ sessionId, prompt: ContentBlock[] }` where ContentBlock is `{ type: "text", text }`
- `session/update`: `{ sessionId, update: { sessionUpdate: "agent_message_chunk"|"tool_call"|"tool_call_update", ... } }`
- `session/request_permission`: `{ sessionId, toolCall, options }` → response: `{ outcome: { outcome: "selected", optionId } }`

## Testing

All tests use vitest. Each package has its own test suite.

```bash
bun run test                              # all packages
bun run test:coverage                     # all packages with coverage
bun run --filter=@nexus/gateway test      # single package
bun run --filter=@nexus/gateway test -- --coverage
bun run --filter=@nexus/gateway test:watch # watch mode
```

State tests use `:memory:` SQLite. ACP bridge tests use mock streams. Gateway E2E tests use real WS connections with mock ACP sessions.

## Config

Gateway loads config from (in order):
1. CLI argument path
2. `NEXUS_CONFIG` env var
3. `./config/nexus.json`
4. `./config/nexus.default.json`

If `auth.token` is empty, a random 32-char hex token is generated on startup.

## File Conventions

- Source in `src/`, compiled to `dist/`
- Tests in `src/__tests__/*.test.ts`
- Each package has `vitest.config.ts` with `passWithNoTests: true`
- Package entry points: `src/index.ts` re-exports public API
