# Agent Orchestration & Headless Client

## The Vision

An agent developing Nexus can **run Nexus itself** as part of its workflow:

```
Session 1 (Main Agent) — writes code, reasons, talks to operator
    │
    ├── observes → Gateway process — reads stdout/stderr logs
    │
    └── drives  → Headless client — sends prompts, reads responses,
                                     handles approvals programmatically
```

The main agent writes a fix, starts the gateway, sends test prompts through a headless client, reads real responses and real logs, diagnoses issues, and iterates — checking decisions with the operator along the way.

Two pieces are missing: a **headless CLI client** and an **orchestration layer**.

---

## Option A: Agent-Driven Orchestration (No Gateway Changes)

The agent uses bash to start processes and pipe JSON to a headless CLI client. The gateway doesn't know or care that an agent is driving it — it sees normal WebSocket connections.

### What's needed

1. **`@nexus/cli`** — a pipe-friendly headless client (see detailed spec below)
2. The agent's existing bash tool

### How it works

```bash
# Agent starts the gateway in background
bun run gateway:dev:multi &> /tmp/gateway.log &

# Agent reads the token from startup output
TOKEN=$(awk '/Connect via:/ { sub(/^.*token=/, "", $0); print $0; exit }' /tmp/gateway.log)

# Agent sends a prompt via the headless client
echo '{"type":"prompt","text":"hello"}' | bun run cli:dev -- --token $TOKEN

# Agent reads structured JSON responses from stdout
# Agent tails gateway logs for diagnostics
tail -f /tmp/gateway.log
```

### Pros
- Zero protocol changes, zero gateway changes
- Works immediately once the CLI exists
- Simple mental model — the agent is just a user with a keyboard

### Cons
- No first-class session relationships (gateway sees independent connections)
- Agent must manually manage process lifecycle (start, stop, health check)
- No multiplexed output — agent must juggle multiple streams via bash

### When to use
- Immediate development and testing workflows
- Single-agent self-testing loops
- CI/CD integration testing

---

## Option B: Gateway-Native Orchestration

The gateway gains awareness of session relationships. One session can spawn, observe, and control peer sessions through new protocol messages.

### What's needed

1. **`@nexus/cli`** (same as Option A)
2. New `ClientMessage` types:
   - `session_spawn` — create a peer session, optionally on a different runtime
   - `session_observe` — subscribe to another session's events
   - `session_send` — send a prompt to a peer session
   - `session_kill` — terminate a peer session
3. New `GatewayEvent` types:
   - `peer_event` — forwarded event from an observed peer session, wrapped with `sourceSessionId`
4. Gateway router changes:
   - Session graph (parent → children) instead of flat map
   - Cascading cancel — killing a parent kills its children
   - Event multiplexing — forward peer events to observing sessions

### Protocol sketch

```typescript
// Client sends
{ type: "session_spawn", runtime: "claude", prompt: "run the tests" }

// Gateway responds
{ type: "session_created", sessionId: "peer-1", parentSessionId: "main" }

// Client subscribes to peer output
{ type: "session_observe", targetSessionId: "peer-1" }

// Gateway forwards peer events
{ type: "peer_event", sourceSessionId: "peer-1", event: { type: "text_delta", ... } }
```

### Pros
- First-class multiplexing — one WS connection sees all peer output
- Gateway manages lifecycle (cleanup, cascading cancel)
- Enables future multi-agent patterns (fan-out, pipelines, etc.)

### Cons
- Significant protocol and gateway work
- Complexity in event routing and session graph management
- Over-engineering risk if the patterns aren't validated yet

### When to use
- After patterns from Option A are well-understood
- When multiple clients need to observe orchestrated sessions
- When session lifecycle management becomes painful in bash

---

## Option C: Hybrid (CLI + Admin API)

The CLI exists as a standalone tool (Option A), and the gateway exposes an admin API for session introspection. The agent uses the CLI to drive sessions and the admin API to observe.

### What's needed

1. **`@nexus/cli`** (same as Option A)
2. **Admin API** on the gateway (REST or WS):
   - `GET /admin/sessions` — list active sessions with status
   - `GET /admin/sessions/:id/events` — recent events for a session (ring buffer)
   - `GET /admin/sessions/:id/logs` — gateway-level logs for a session
   - `WS /admin/observe/:id` — live event stream for a session
3. Admin auth (separate from client auth, or elevated token scope)

### Pros
- Clean separation: CLI for driving, admin API for observing
- Admin API is useful independently (debugging, monitoring, dashboards)
- Doesn't pollute the client protocol with orchestration concerns
- Incremental — build the REST endpoints first, add WS observe later

### Cons
- Two separate interfaces (CLI + admin API) instead of one unified protocol
- Admin API needs its own auth model
- Still no first-class session relationships in the gateway

### When to use
- When observability is the main pain point (not lifecycle management)
- As a stepping stone between A and B
- When you want admin tooling anyway

---

## Recommended Path

**A now → C soon → B if needed.**

1. Build `@nexus/cli` — this unblocks all three options
2. Use Option A to validate the agent-driven workflow
3. When "I wish I could see the other session's output without tailing logs" becomes painful, add the admin API (Option C)
4. If session lifecycle management becomes the bottleneck, add gateway-native orchestration (Option B)

---

## Immediate: `@nexus/cli` Spec

### Package: `@nexus/cli`

A pipe-friendly, headless WebSocket client for Nexus. Zero UI dependencies — just `ws` and `@nexus/types`.

### Interface

```
nexus-cli [options]

Options:
  --url <ws-url>         Gateway URL (default: ws://127.0.0.1:18800/ws)
  --token <token>        Auth token (or NEXUS_TOKEN env var)
  --session <id>         Attach to existing session (skip session_new)
  --runtime <id>         Runtime to use for new sessions
  --model <id>           Model to use for new sessions
  --prompt <text>        One-shot mode: send prompt, print response, exit
  --auto-approve         Auto-approve all approval requests
  --json                 Raw JSON mode (default, for piping)
  --pretty               Human-readable output mode
```

### Modes

**Interactive (default)**
- stdin: newline-delimited JSON (`ClientMessage`)
- stdout: newline-delimited JSON (`GatewayEvent`)
- stderr: connection status, errors
- if no `--session` is provided, the CLI sends `session_new` on connect and auto-injects `sessionId` into stdin `prompt`/`cancel` messages when missing

```bash
# Pipe-friendly — agent writes JSON to stdin, reads JSON from stdout
bun run cli:dev -- --token $TOKEN <<< '{"type":"prompt","text":"hello"}'
```

**One-shot**
- Send a single prompt, stream `GatewayEvent` JSON lines, exit on matching session `turn_end`

```bash
bun run cli:dev -- --token $TOKEN --prompt "what files are in src/"
```

**Auto-approve**
- Automatically respond to `approval_request` events with approval
- Useful for unattended test runs

```bash
bun run cli:dev -- --token $TOKEN --auto-approve --prompt "run the tests"
```

### Architecture

```
stdin (JSON lines)
  → parse as ClientMessage
  → send over WebSocket

WebSocket incoming
  → parse as GatewayEvent
  → if approval_request && auto-approve: send approval_response
  → write to stdout (JSON line)

Connection lifecycle
  → connect with token
  → on open: send session_new (unless --session)
  → on close: exit with code 0
  → on error: write to stderr, exit with code 1
```

### Implementation Plan

1. **Scaffold** — `packages/cli/` with `package.json`, `tsconfig.json`, `vitest.config.ts`
2. **Core client** — `src/client.ts`: WebSocket connect, message send/receive, auto-session
3. **CLI entry** — `src/main.ts`: arg parsing (use `minimist` or bare `process.argv`), mode selection
4. **Approval handler** — `src/approval.ts`: auto-approve logic, configurable policy
5. **Tests** — `src/__tests__/client.test.ts`: mock WS server, verify message flow
6. **Binary** — `bin/nexus-cli` shebang entry point, register in `package.json` `bin` field

### Dependencies

- `ws` (already in monorepo)
- `@nexus/types` (message types, type guards)
- No React, no Ink, no client-core

### Example: Agent Self-Test Loop

```bash
# 1. Agent starts gateway
bun run gateway:dev:multi &> /tmp/gw.log &
GW_PID=$!
sleep 2

# 2. Extract token
TOKEN=$(awk '/Connect via:/ { sub(/^.*token=/, "", $0); print $0; exit }' /tmp/gw.log)

# 3. Send a test prompt
RESPONSE=$(bun run cli:dev -- --token $TOKEN --prompt "what is 2+2" --auto-approve)

# 4. Check the response
echo "$RESPONSE" | jq '.type'  # text_delta, turn_end, etc.

# 5. Check gateway logs for errors
grep -i error /tmp/gw.log

# 6. Clean up
kill $GW_PID
```
