# Nexus PoC — TDD Implementation Plan

## Context

OpenClaw is a monolithic, single-process AI agent gateway with known architectural issues (god process, inverted auth, plaintext creds, forked runtime). Nexus reimagines it as a lightweight, secure, modular gateway that proves the chain: **User → TUI → WebSocket → Gateway → ACP → Claude Code** with real-time streaming and approval mediation.

We build bottom-up, TDD with no exceptions. Every module gets tests first, implementation second.

---

## Tech Stack

- **Runtime**: Bun (no `bun:*` imports — standard `node:*` + npm only, portable to Deno/Node)
- **Monorepo**: Turborepo
- **Tests**: vitest
- **SQLite**: better-sqlite3
- **WebSocket**: ws
- **TUI**: Ink 5 + React 18
- **ACP agent**: `cc-acp` (npm: claude-code-acp) — subprocess, ACP over stdio NDJSON
- **Style**: Arrow functions, named exports, no default exports

---

## Phase 0: Scaffold (~15 files)

Create Turborepo monorepo with 7 packages, all wired but empty stubs.

```
nexus/
├── package.json                  # workspaces: ["packages/*"]
├── turbo.json                    # build, test, dev pipelines
├── tsconfig.base.json            # strict, ESNext, bundler resolution
├── vitest.workspace.ts
├── .gitignore
├── config/
│   ├── nexus.default.json        # { port: 18800, host: "127.0.0.1", auth: {token:""}, runtime: {command: ["npx","cc-acp"]}, dataDir: "./data" }
│   └── policy.default.json       # default rules from arch doc
└── packages/
    ├── types/                    # zero deps, pure TS
    ├── policy/                   # depends on types
    ├── state/                    # depends on types, better-sqlite3
    ├── acp-bridge/               # depends on types
    ├── gateway/                  # depends on policy, state, acp-bridge
    ├── client-core/              # depends on types
    └── tui/                      # depends on client-core, ink
```

**Acceptance**: `bun install` + `bun run build` + `bun run test` all pass (0 tests found).

---

## Phase 1: `@nexus/types` — Shared Type Definitions

Pure TypeScript types + runtime type guards + parsers. Zero deps.

### Files
- `src/protocol.ts` — ClientMessage, GatewayEvent, SessionInfo unions
- `src/acp.ts` — JsonRpcRequest/Response/Notification, ACP session update types, permission types
- `src/state.ts` — SessionRecord, AuditEvent
- `src/policy.ts` — PolicyRule, PolicyConfig, PolicyAction
- `src/config.ts` — NexusConfig
- `src/index.ts` — re-exports

### Tests (~18 cases)
- `isClientMessage` type guard: validates each variant, rejects malformed
- `isGatewayEvent` type guard: validates each variant, rejects malformed
- `parseClientMessage`: parses valid JSON, rejects unknown types
- `isJsonRpcRequest`/`isJsonRpcNotification`/`isJsonRpcResponse` validation
- `parseAcpLine`: parses NDJSON line → typed ACP message
- `isSessionRecord`, `isAuditEvent`, `isPolicyConfig` validation

---

## Phase 2: `@nexus/policy` — Policy Engine (pure logic, no I/O)

### Files
- `src/evaluate.ts` — `evaluatePolicy(config, tool, params?) → PolicyAction`
- `src/loader.ts` — `loadPolicyFromString(json) → PolicyConfig`, `validatePolicyConfig()`
- `src/index.ts`

### Tests (~16 cases)
- Exact match: allow, deny, ask
- Wildcard `"*"` matches any tool
- First-match-wins ordering (deny before ask, pattern-specific before general)
- Pattern is substring match (not regex): `"rm -rf"` matches `"rm -rf /"` but `"sudo"` doesn't match `"pseudocode"`
- Case-sensitive tool names
- No match → defaults to `"ask"`
- Full default policy config from arch doc exercised with: Read→allow, Edit→allow, Exec+"npm test"→ask, Exec+"rm -rf /"→deny, WebFetch→ask, UnknownTool→ask
- Loader: valid JSON, invalid JSON, missing rules array, invalid action values

---

## Phase 3: `@nexus/state` — SQLite State Store

All tests use `:memory:` SQLite — no filesystem.

### Files
- `src/migrations.ts` — `initDatabase(db)` creates tables + indexes
- `src/sessions.ts` — `createSessionStore(db) → SessionStore`
- `src/audit.ts` — `createAuditStore(db) → AuditStore`
- `src/store.ts` — `createStateStore(dbPath) → StateStore` (combines both + close)
- `src/index.ts`

### Tests (~20 cases)
- **Migrations**: creates tables, idempotent, creates indexes
- **Sessions**: create+get, get null for missing, list ordered by lastActivityAt desc, update patch fields, throws on duplicate/missing
- **Audit**: log+get, filter by sessionId, ordered by timestamp, empty for no events
- **Store**: unified interface works, file path creates SQLite file

---

## Phase 4: `@nexus/acp-bridge` — ACP Client + Process Manager

Tests use mock streams (no real subprocess). A shared `mock-agent.ts` helper creates fake readable/writable stream pairs that emit canned ACP responses.

### Files
- `src/stream.ts` — `parseNdjsonStream(input, onMessage, onError)`
- `src/rpc.ts` — `createRpcClient(input, output, opts) → RpcClient`
- `src/session.ts` — `createAcpSession(rpc, acpSessionId, gatewaySessionId) → AcpSession`
- `src/manager.ts` — `spawnAgent(command, opts) → AgentProcess`
- `src/__tests__/helpers/mock-agent.ts` — reusable mock
- `src/index.ts`

### Tests (~25 cases)
- **NDJSON stream**: one line per object, partial line buffering, empty line skip, malformed line error (no crash), multi-line in single chunk, works with `Readable.from()`
- **RPC client**: sends well-formed JSON-RPC, resolves matching response by id, rejects on error response, timeout, concurrent requests resolve independently, notifications routed separately
- **Session**: initialize sends correct method, createSession returns acpSessionId, prompt yields translated events (agent_message_chunk→text_delta, tool_call→tool_start, tool_call_update completed→tool_end), permission request emits approval_request, respondToPermission sends correct response, cancel sends session/cancel, prompt resolves with stopReason
- **Manager**: spawns command, calls initialize, rejects on premature exit, rejects on timeout, kill sends SIGTERM then SIGKILL, isAlive reflects process state, emits exit on unexpected death

---

## Phase 5: `@nexus/gateway` — Server + Router + Orchestration

### Files
- `src/auth.ts` — `generateToken()`, `validateToken(provided, expected)`
- `src/config.ts` — `loadConfig()` → NexusConfig
- `src/router.ts` — `createRouter(deps) → Router`
- `src/server.ts` — `createGatewayServer(deps) → GatewayServer`
- `src/index.ts` — `startGateway()`

### Tests (~22 cases)
- **Auth**: generateToken returns 32-char hex, validateToken correct/wrong/empty, constant-time comparison
- **Config**: reads JSON, merges defaults, generates token if missing, throws on missing runtime.command
- **Router**: session_new creates ACP session + stores in state, prompt forwards to ACP + yields events, error on unknown session, updates lastActivityAt, cancel calls ACP cancel, session_list queries state, policy auto-allow bypasses client, policy ask forwards approval_request, policy deny auto-denies + logs audit
- **Server**: /health returns ok without auth, WS rejects without/wrong token, WS accepts correct token, client receives events on prompt, malformed JSON returns error event, graceful shutdown
- **Integration** (6 cases): full prompt cycle, auto-allow, ask flow, auto-deny, session persistence in SQLite, cancel mid-stream

---

## Phase 6: `@nexus/client-core` — React Hooks

### Files
- `src/useConnection.ts` — WS connection + reconnection
- `src/useSession.ts` — session state, streaming text accumulation, tool tracking
- `src/useApproval.ts` — pending approvals, approve/deny actions
- `src/index.ts`

### Tests (~15 cases, using @testing-library/react renderHook + mock WS server)
- **useConnection**: connects with token, status transitions, sendMessage serializes, reconnection on disconnect
- **useSession**: sends session_new, sendPrompt, accumulates text_delta, tracks isStreaming, cancel, activeTools tracking
- **useApproval**: tracks pending approvals, approve/deny send correct messages, concurrent approvals

---

## Phase 7: `@nexus/tui` — Terminal Client (Ink)

### Files
- `src/components/StatusBar.tsx`, `Chat.tsx`, `Input.tsx`, `ToolStatus.tsx`, `ApprovalPrompt.tsx`
- `src/App.tsx` — main layout
- `src/index.tsx` — entry point `render(<App />)`

### Tests (~17 cases, using ink-testing-library)
- **StatusBar**: connecting/connected/disconnected states, model name, token count
- **ToolStatus**: nothing when empty, spinner + tool name, multiple tools, clears on tool_end
- **ApprovalPrompt**: renders tool+description, y→approve, n→deny, nothing when no pending
- **Chat**: message history, streaming text, "Thinking..." state
- **Input**: text prompt, onSubmit callback, disabled while streaming
- **App**: renders all components, full mount→connect→session→prompt→response flow

---

## Phase 8: E2E Smoke Test

`packages/gateway/src/__tests__/e2e.test.ts` — real gateway + mock ACP subprocess + WS client.

2 test cases:
1. Full prompt cycle: connect → session_new → prompt → text_delta stream → turn_end → audit in SQLite
2. Approval flow: prompt → tool triggers ask → approval_request → approval_response → tool proceeds → audit logged

---

## Build Order / Dependency Graph

```
Phase 0: Scaffold
    ↓
Phase 1: @nexus/types
    ↓
┌───┼───┐
↓   ↓   ↓
P2  P3  P4  (policy, state, acp-bridge — parallel, only depend on types)
└───┼───┘
    ↓
Phase 5: @nexus/gateway
    ↓
Phase 6: @nexus/client-core
    ↓
Phase 7: @nexus/tui
    ↓
Phase 8: E2E smoke test
```

## Estimated Test Count: ~133 tests across 7 packages

## Verification

After all phases:
1. `bun run test` — all ~133 tests pass
2. `bun run build` — all packages compile
3. Manual smoke test: start gateway (`bun run --filter=@nexus/gateway dev`), start TUI (`bun run --filter=@nexus/tui dev`), type a prompt, observe streaming response from Claude Code
