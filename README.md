# Nexus

A lightweight, modular AI agent gateway that connects terminal clients to AI agents via WebSocket, with real-time streaming, tool approval mediation, and policy enforcement.

```
User -> TUI -> WebSocket -> Gateway -> ACP -> Claude Code
                                 |
                          Policy Engine
                          State Store (SQLite)
```

## Why Nexus?

Traditional AI agent gateways tend toward monolithic designs — single-process god objects, inverted auth, tight coupling to specific runtimes. Nexus takes a different approach:

- **Modular**: 7 focused packages, each with a single responsibility
- **Secure**: Token auth mandatory, policy-based tool approval, constant-time comparisons
- **Pluggable**: Any ACP-compatible agent runtime works (Claude Code, Codex CLI, etc.)
- **Streamable**: Real-time text deltas, tool status, and approval prompts over WebSocket
- **Portable**: Standard `node:*` APIs only — runs on Bun, Node, or Deno

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.2
- [Claude Code ACP](https://www.npmjs.com/package/claude-code-acp) (`npx cc-acp`)

### Install & Build

```bash
git clone <repo> && cd nexus
bun install
bun run build
bun run test
```

### Start the Gateway

```bash
bun run --filter=@nexus/gateway dev
```

The gateway will:
1. Load config from `config/nexus.default.json`
2. Generate an auth token (printed to console)
3. Spawn the ACP agent subprocess
4. Listen for WebSocket connections on `ws://127.0.0.1:18800/ws`

### Start the TUI

```bash
NEXUS_TOKEN=<token from gateway output> bun run --filter=@nexus/tui dev
```

The TUI connects to the gateway, creates a session, and lets you chat with the AI agent.

## Architecture

### Packages

| Package | Description | Deps |
|---------|-------------|------|
| `@nexus/types` | Shared types + runtime type guards | none |
| `@nexus/policy` | First-match-wins policy evaluation | types |
| `@nexus/state` | SQLite session + audit store (runtime adapter) | types, bun:sqlite / better-sqlite3 |
| `@nexus/acp-bridge` | ACP client, NDJSON streams, process management | types |
| `@nexus/gateway` | WS server, message routing, auth, orchestration | all above + ws |
| `@nexus/client-core` | React hooks for WS connection + sessions | types, react |
| `@nexus/tui` | Terminal UI with Ink | client-core, ink, react |

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
  "runtime": { "command": ["npx", "cc-acp"] },
  "dataDir": "./data"
}
```

| Field | Description |
|-------|-------------|
| `port` | WebSocket listen port |
| `host` | Bind address |
| `auth.token` | Auth token (auto-generated if empty) |
| `runtime.command` | ACP agent subprocess command |
| `runtime.cwd` | Working directory for the agent (optional) |
| `dataDir` | SQLite database directory |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_CONFIG` | — | Path to gateway config file |
| `NEXUS_URL` | `ws://127.0.0.1:18800/ws` | Gateway URL (TUI) |
| `NEXUS_TOKEN` | — | Auth token (TUI) |

## Development

### Commands

```bash
bun run build         # Build all packages
bun run test          # Run all tests
bun run test:coverage # Run all tests with coverage
bun run typecheck     # Type-check without emitting
bun run dev           # Start all dev servers

# Single package
bun run --filter=@nexus/gateway test
bun run --filter=@nexus/gateway test:watch
bun run --filter=@nexus/gateway test -- --coverage
```

### Testing

190 tests across 7 packages using vitest:

- **Types**: 58 tests (type guard validation)
- **Policy**: 22 tests (evaluation logic)
- **State**: 22 tests (SQLite CRUD, in-memory)
- **ACP Bridge**: 34 tests (NDJSON, RPC, session translation, permission flow, process lifecycle)
- **Gateway**: 28 tests (auth, config, router, server, E2E)
- **Client Core**: 14 tests (React hooks)
- **TUI**: 12 tests (component rendering)

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
