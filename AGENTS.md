# AGENTS.md — Multi-Agent Development Guide

## Overview

This document describes how AI coding agents should work with the Nexus codebase. It covers the architecture, conventions, and patterns that agents need to follow.

## Repository Layout

Nexus is a Turborepo monorepo with 9 packages. All packages live under `packages/` and depend on each other through `workspace:*` links.

### Package Roles

| Package | Role | Key Files |
|---------|------|-----------|
| `@nexus/types` | Shared type definitions + type guards | `src/protocol.ts`, `src/acp.ts` |
| `@nexus/policy` | Pure policy evaluation (no I/O) | `src/evaluate.ts`, `src/loader.ts` |
| `@nexus/state` | SQLite state store (runtime adapter: bun:sqlite / better-sqlite3) | `src/store.ts`, `src/database.ts`, `src/migrations.ts` |
| `@nexus/acp-bridge` | ACP subprocess + JSON-RPC client | `src/session.ts`, `src/rpc.ts`, `src/manager.ts` |
| `@nexus/gateway` | WS server, router, auth, boot | `src/router.ts`, `src/server.ts`, `src/start.ts` |
| `@nexus/memory` | Pluggable memory provider interface + SQLite provider | `src/types.ts`, `src/provider.ts` |
| `@nexus/client-core` | React hooks for WS + session | `src/useConnection.ts`, `src/useSession.ts` |
| `@nexus/tui` | Terminal UI (Ink) | `src/App.tsx`, `src/components/` |
| `@nexus/cli` | Headless WS CLI client for automation | `src/main.ts`, `src/client.ts` |

### Build Order

Turborepo handles this automatically via `dependsOn: ["^build"]`, but the logical order is:

```
types -> policy, state, acp-bridge, memory, cli (parallel) -> gateway -> client-core -> tui
```

## Conventions to Follow

### Code Style
- Arrow functions: `const fn = () => {}` (never `function`)
- Named exports only (no `export default`)
- Use `node:*` imports (not `bun:*`)
- Strict TypeScript throughout

### Adding a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, `vitest.config.ts`
2. tsconfig extends `../../tsconfig.base.json`
3. Add workspace dependency: `"@nexus/types": "workspace:*"`
4. Add to root workspaces (automatic with `"packages/*"` glob)
5. Write tests first, then implement

### Adding a New Type

Types go in `@nexus/types`. Always add:
1. The TypeScript interface/type
2. A runtime type guard (`isFoo(value): value is Foo`)
3. Tests for the type guard in `src/__tests__/`
4. Re-export from `src/index.ts`

### Adding a New Gateway Event

1. Add variant to `GatewayEvent` union in `packages/types/src/protocol.ts`
2. Add to `GATEWAY_EVENT_TYPES` set
3. Add validation case in `isGatewayEvent`
4. Handle in `packages/gateway/src/router.ts`
5. Handle in `packages/client-core/src/useSession.ts` (if client needs it)
6. Update TUI components if user-visible

### Adding a New Client Message

1. Add variant to `ClientMessage` union in `packages/types/src/protocol.ts`
2. Add to `CLIENT_MESSAGE_TYPES` set
3. Add validation case in `isClientMessage`
4. Add handler in `packages/gateway/src/router.ts`
5. Add sender in `packages/client-core/` hooks

## Data Flow

```
User types in TUI
  -> useSession.sendPrompt(text)
    -> useConnection.sendMessage({ type: "prompt", sessionId, text })
      -> WebSocket JSON to gateway
        -> parseClientMessage() validates
          -> router.handleMessage(msg, emit)
            -> acpSession.prompt(text)
              -> JSON-RPC to cc-acp subprocess
                -> Claude Code processes

Claude Code responds (streaming)
  <- ACP NDJSON notifications on stdout
    <- rpc.onNotification() receives
      <- translateNotification() maps to GatewayEvent
        <- session.onEvent(handler) fires
          <- emit(event) sends to WS
            <- useConnection.onEvent fires
              <- useSession.handleEvent updates state
                <- React re-renders TUI
```

## Testing Patterns

### Unit Tests
Each package tests in isolation. Dependencies are mocked.

```typescript
// Mock ACP session
const mockAcpSession = (): AcpSession => ({
  id: "gw-session-1",
  acpSessionId: "acp-session-1",
  prompt: vi.fn().mockResolvedValue(undefined),
  respondToPermission: vi.fn(),
  cancel: vi.fn(),
  onEvent: vi.fn(),
});
```

### State Tests
Always use `:memory:` SQLite — no filesystem:

```typescript
const stateStore = createStateStore(":memory:");
```

### Gateway E2E Tests
Real WS server on port 0 (random) with mock ACP sessions:

```typescript
const server = createGatewayServer({ port: 0, host: "127.0.0.1", token, router });
const { port } = await server.start();
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
```

### TUI Tests
Use `ink-testing-library` for component tests:

```typescript
import { render } from "ink-testing-library";
const { lastFrame } = render(<StatusBar status="connected" />);
expect(lastFrame()).toContain("Connected");
```

## Key Interfaces

### Router (gateway)
```typescript
interface Router {
  handleMessage: (msg: ClientMessage, emit: EventEmitter) => void;
}
type EventEmitter = (event: GatewayEvent) => void;

// RouterDeps — createAcpSession is async (awaits session/new from agent)
interface RouterDeps {
  createAcpSession: (onEvent: EventEmitter) => Promise<AcpSession>;
  stateStore: StateStore;
  policyConfig: PolicyConfig;
}
```

### RpcClient (acp-bridge)
```typescript
interface RpcClient {
  sendRequest: (method: string, params?: unknown) => Promise<unknown>;
  sendNotification: (method: string, params?: unknown) => void;
  sendResponse: (id: number | string, result: unknown) => void;
  sendErrorResponse: (id: number | string, code: number, message: string) => void;
  onNotification: (handler: (notification: JsonRpcNotification) => void) => void;
  onRequest: (handler: RequestHandler) => void;  // handles agent→client requests
  destroy: () => void;
}
```

### AcpSession (acp-bridge)
```typescript
interface AcpSession {
  id: string;
  acpSessionId: string;
  prompt: (text: string) => Promise<unknown>;
  respondToPermission: (requestId: string, optionId: string) => void;
  cancel: () => void;
  onEvent: (handler: AcpEventHandler) => void;
}
```

### DatabaseAdapter (state)
```typescript
// Runtime adapter — uses bun:sqlite on Bun, better-sqlite3 on Node/Deno
interface DatabaseAdapter {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
}
const db = openDatabase(":memory:"); // or openDatabase("/path/to/file.db")
```

### StateStore (state)
```typescript
interface StateStore extends SessionStore, AuditStore {
  close: () => void;
}
// SessionStore: createSession, getSession, listSessions, updateSession
// AuditStore: logEvent, getEvents
```

## Common Pitfalls

1. **Don't use `bun:*` imports** — they break portability. Use `node:*` + npm packages.
2. **Don't use `export default`** — named exports only.
3. **AuditEvent.type** is `"tool_call" | "approval" | "deny" | "error"` — not arbitrary strings.
4. **SessionRecord.status** is `"active" | "idle"` — not arbitrary strings.
5. **Router is async** — `handleMessage` takes an `emit` callback, doesn't return events.
6. **RPC client only supports one notification handler** — `onNotification` overwrites the previous handler. Same for `onRequest`.
7. **vitest.config.ts** must have `passWithNoTests: true` or empty packages fail CI.
8. **ACP permission flow** — `session/request_permission` is a JSON-RPC *request* (not notification). The RPC client handles it via `onRequest`, resolves via `respondToPermission`, which completes the pending promise.
9. **SQLite runtime adapter** — Don't import `better-sqlite3` directly. Use `openDatabase()` from `@nexus/state` which picks `bun:sqlite` or `better-sqlite3` at runtime.
10. **ACP session/update shape** — Updates are nested: `{ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "..." } } }`, not flat.
