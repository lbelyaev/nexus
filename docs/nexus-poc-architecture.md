# Nexus PoC — Architecture Sketch

## Goal

Prove the full chain: **User → Client → Gateway → ACP → Claude Code**
with real-time streaming, tool status, and approval mediation.

Minimal. No channels (Telegram, WhatsApp) yet. No memory system. No multi-agent routing.
Just the core data path, working end-to-end.

---

## What the PoC Does

1. User types a message in a TUI (or web UI)
2. Message goes to the gateway over WebSocket
3. Gateway forwards it to Claude Code via ACP (`session/prompt`)
4. Claude Code streams back: text deltas, tool calls, approval requests
5. Gateway intercepts approvals, applies policy, auto-approves or forwards to user
6. Streamed output appears in the client in real-time
7. Session persists across messages (multi-turn conversation)

---

## Project Structure

```
nexus/
├── deno.json                     # workspace config, import map, tasks
├── deno.lock
│
├── packages/
│   ├── gateway/                  # the core — Deno process
│   │   ├── mod.ts                # entry point
│   │   ├── server.ts             # WebSocket + HTTP server
│   │   ├── router.ts             # session → runtime mapping
│   │   ├── policy.ts             # approval policy engine (simple)
│   │   ├── state.ts              # SQLite state store (Deno.openKv or better-sqlite3)
│   │   ├── events.ts             # typed event bus
│   │   └── types.ts              # shared types
│   │
│   ├── acp-bridge/               # ACP client that manages agent subprocesses
│   │   ├── mod.ts                # entry point
│   │   ├── manager.ts            # spawn/kill/health-check agent processes
│   │   ├── session.ts            # ACP session lifecycle (new/load/prompt/cancel)
│   │   ├── stream.ts             # parse ACP NDJSON → typed events
│   │   └── types.ts              # ACP event types (subset we care about)
│   │
│   ├── client-core/              # shared client logic (React hooks + ACP consumer)
│   │   ├── mod.ts                # entry point
│   │   ├── useSession.ts         # React hook: manage session state
│   │   ├── useStream.ts          # React hook: consume WS stream → typed events
│   │   ├── useApproval.ts        # React hook: handle approval prompts
│   │   └── types.ts              # client-side event types
│   │
│   ├── tui/                      # terminal client (Ink)
│   │   ├── mod.tsx               # entry point — render(<App />)
│   │   ├── App.tsx               # main layout
│   │   ├── Chat.tsx              # message list + streaming response
│   │   ├── Input.tsx             # user input with history
│   │   ├── ToolStatus.tsx        # tool call progress display
│   │   ├── ApprovalPrompt.tsx    # [y/n] for dangerous operations
│   │   └── StatusBar.tsx         # connection status, model, token count
│   │
│   └── web/                      # web client (optional, phase 2)
│       ├── app/
│       │   ├── page.tsx          # main chat page
│       │   └── layout.tsx
│       └── components/
│           ├── Chat.tsx          # uses AI Elements / Streamdown
│           ├── ToolStatus.tsx
│           └── ApprovalPrompt.tsx
│
├── config/
│   ├── nexus.default.json        # default gateway config
│   └── policy.default.json       # default approval policy
│
└── scripts/
    ├── dev.ts                    # start gateway + TUI in dev mode
    └── test-acp.ts               # standalone ACP bridge test (no gateway)
```

---

## Data Flow (detailed)

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   TUI (Ink)              Gateway (Deno)           Claude Code        │
│   ─────────              ───────────────           ───────────        │
│                                                                      │
│   User types      WS     ┌─────────────┐  ACP     ┌────────────┐   │
│   "fix the  ──────────►  │             │  stdio   │            │   │
│    bug in       message   │   server    ├────────► │  claude-   │   │
│    auth.ts"               │     ↓       │ prompt   │  code-acp  │   │
│                           │   router    │          │            │   │
│                           │     ↓       │          │  (spawned  │   │
│                           │   policy    │          │   as child │   │
│                           │     ↓       │          │   process) │   │
│                           │  acp-bridge │          │            │   │
│                           │             │          └─────┬──────┘   │
│                           └──────┬──────┘                │          │
│                                  │                       │          │
│                                  │  ◄────────────────────┘          │
│                                  │   ACP session/update events      │
│                                  │   (NDJSON on stdout)             │
│                                  │                                   │
│                                  │   Events:                        │
│                                  │   ┌──────────────────────────┐   │
│                                  │   │ {type: "text",           │   │
│   Stream to     WS               │   │  delta: "I'll fix"}     │   │
│   client   ◄──────────────────   │   │                          │   │
│   (token by                      │   │ {type: "toolCall",       │   │
│    token)                        │   │  name: "Edit",           │   │
│                                  │   │  status: "started",      │   │
│   Show tool     WS               │   │  file: "auth.ts"}       │   │
│   status   ◄──────────────────   │   │                          │   │
│   "✎ Editing                     │   │ {type: "toolCall",       │   │
│    auth.ts"                      │   │  status: "completed"}    │   │
│                                  │   │                          │   │
│   Maybe:        WS               │   │ {type: "permission",     │   │
│   approval ◄──────────────────   │   │  tool: "Exec",           │   │
│   prompt                         │   │  command: "npm test"}    │   │
│   [y/n]    ──────────────────►   │   │                          │   │
│             response             │   └──────────────────────────┘   │
│                                  │                                   │
│                                  │   Gateway decides:               │
│                                  │   - Edit file? auto-approve      │
│                                  │   - Read file? auto-approve      │
│                                  │   - Run npm test? ask user       │
│                                  │   - Run rm -rf? auto-deny        │
│                                  │                                   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Module Contracts

### Gateway ↔ Client (WebSocket)

Simple JSON messages. No framework dependency.

```typescript
// Client → Gateway
type ClientMessage =
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "approval_response"; requestId: string; allow: boolean }
  | { type: "cancel"; sessionId: string }
  | { type: "session_new"; runtimeId?: string }  // optional: pick runtime
  | { type: "session_list" }

// Gateway → Client
type GatewayEvent =
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "tool_start"; sessionId: string; tool: string; params: unknown }
  | { type: "tool_end"; sessionId: string; tool: string; result?: string }
  | { type: "approval_request"; sessionId: string; requestId: string;
      tool: string; description: string }
  | { type: "turn_end"; sessionId: string; stopReason: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "session_created"; sessionId: string; model: string }
  | { type: "session_list"; sessions: SessionInfo[] }
```

Clean, minimal, no ACP leak into the client protocol. The gateway translates.

### Gateway ↔ Agent Runtime (ACP over stdio)

Standard ACP. The gateway is the ACP client. Claude Code is the ACP agent.

```typescript
// Gateway sends (ACP client → agent):
//   initialize        → handshake, get capabilities
//   session/new       → create session
//   session/prompt    → send user message
//   session/cancel    → abort current turn
//   permission result → approve/deny tool execution

// Gateway receives (ACP agent → client):
//   initialize result → capabilities, auth methods
//   session/update    → text deltas, tool calls, status changes
//   permission request → "can I run `npm test`?"
```

The `acp-bridge` module handles all of this. It exposes a clean async interface
to the rest of the gateway:

```typescript
// acp-bridge/session.ts
interface AcpSession {
  id: string;
  prompt(text: string): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  setMode(mode: "read-only" | "edit" | "full"): Promise<void>;
  respondToPermission(requestId: string, allow: boolean): void;
}

interface AgentEvent {
  type: "text_delta" | "tool_start" | "tool_end"
      | "permission_request" | "turn_end" | "error";
  // ... fields per type
}
```

### Policy Engine (simple for PoC)

No OPA/Cedar for the PoC. Just a JSON config:

```json5
// config/policy.default.json
{
  "rules": [
    // Auto-approve safe tools
    { "tool": "Read",        "action": "allow" },
    { "tool": "Edit",        "action": "allow" },
    { "tool": "Write",       "action": "allow" },
    { "tool": "ListDir",     "action": "allow" },
    { "tool": "Search",      "action": "allow" },

    // Ask user for execution
    { "tool": "Exec",        "action": "ask" },
    { "tool": "WebFetch",    "action": "ask" },

    // Deny dangerous patterns
    { "tool": "Exec", "pattern": "rm -rf",     "action": "deny" },
    { "tool": "Exec", "pattern": "sudo",       "action": "deny" },
    { "tool": "Exec", "pattern": "curl.*|",    "action": "deny" },

    // Default
    { "tool": "*",           "action": "ask" }
  ]
}
```

The gateway evaluates rules top-to-bottom, first match wins.
On "ask" → forward to client as `approval_request`.
On "allow" → respond to ACP agent immediately.
On "deny" → respond to ACP agent with deny + log.

---

## State Store (SQLite via Deno.openKv)

Minimal for PoC:

```typescript
// state.ts
interface StateStore {
  // Sessions
  createSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionInfo[]>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;

  // Audit log (every tool call, approval, deny)
  logEvent(event: AuditEvent): Promise<void>;
  getEvents(sessionId: string): Promise<AuditEvent[]>;
}

interface SessionRecord {
  id: string;
  runtimeId: string;          // "claude-code"
  acpSessionId: string;       // the runtime's internal session ID
  status: "active" | "idle";
  createdAt: string;
  lastActivityAt: string;
  tokenUsage: { input: number; output: number };
  model: string;
}

interface AuditEvent {
  sessionId: string;
  timestamp: string;
  type: "tool_call" | "approval" | "deny" | "error";
  tool?: string;
  detail: string;
}
```

Note: the gateway does NOT store transcripts. Claude Code owns its own transcripts.
The gateway stores session metadata and audit logs only.

---

## Startup Sequence

```
$ deno task dev

1. Gateway starts
   ├── Load config (nexus.json)
   ├── Open state store (SQLite)
   ├── Start HTTP + WS server on :18800
   ├── Spawn Claude Code ACP agent:
   │     Deno.Command("npx", ["claude-code-acp"])
   │     or: Deno.Command("claude-code-acp-rs")  // Rust binary
   │   ├── Read stdout for ACP NDJSON
   │   ├── Send ACP `initialize`
   │   └── Receive capabilities
   └── Ready. Listening for client connections.

2. TUI starts (separate process, or same terminal)
   ├── Connect to gateway WS at ws://localhost:18800
   ├── Send `session_new`
   ├── Receive `session_created { sessionId, model }`
   └── Show input prompt

3. User types "fix the auth bug"
   ├── TUI sends: { type: "prompt", sessionId: "...", text: "fix the auth bug" }
   ├── Gateway receives, looks up session → runtime mapping
   ├── Gateway calls acpSession.prompt("fix the auth bug")
   ├── Claude Code starts streaming:
   │     text_delta → gateway → WS → TUI (renders token by token)
   │     tool_start(Read, "auth.ts") → gateway → WS → TUI (shows status)
   │     tool_end(Read) → gateway → WS → TUI (clears status)
   │     text_delta → gateway → WS → TUI
   │     tool_start(Edit, "auth.ts") → gateway → policy → auto-allow
   │         → responds to ACP → Claude Code continues
   │     tool_end(Edit) → gateway → WS → TUI
   │     tool_start(Exec, "npm test") → gateway → policy → "ask"
   │         → gateway sends approval_request to TUI
   │         → TUI shows: "Run `npm test`? [y/n]"
   │         → User presses y
   │         → TUI sends approval_response(allow: true)
   │         → Gateway responds to ACP
   │         → Claude Code runs npm test, streams result
   │     turn_end → gateway → WS → TUI (show input prompt again)
   └── Session state updated in SQLite
```

---

## Key Design Decisions for PoC

### 1. Gateway is transport-agnostic internally

The gateway doesn't import Ink, React, or any UI library.
It doesn't import Claude Code SDK or ACP SDK directly into the server.
The `acp-bridge` is a clean module that reads/writes NDJSON on stdio pipes.
The `server` module reads/writes JSON on WebSocket.
Both are just streams of typed messages.

### 2. Claude Code is a black box

We don't fork it, patch it, or modify it.
We spawn `claude-code-acp` (or the Rust variant) as-is.
We speak standard ACP to it.
If Anthropic updates Claude Code, we get the update for free.

### 3. The client protocol is NOT ACP

ACP is between gateway and runtime. The client speaks a simpler, gateway-specific
protocol (the `ClientMessage` / `GatewayEvent` types above). This means:

- Clients don't need to understand ACP
- We can change the runtime (Claude Code → Codex → Ollama) without changing clients
- The gateway can enrich events (add cost data, policy decisions) before forwarding
- The protocol surface is small and stable

### 4. Auth is mandatory from day 1

Even for the PoC. The gateway requires a token on WS connect:

```typescript
// server.ts
Deno.serve({ port: 18800 }, (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    const token = url.searchParams.get("token");
    if (!validateToken(token)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleConnection(socket);
    return response;
  }

  // Health check
  if (url.pathname === "/health") {
    return Response.json({ status: "ok", uptime: process.uptime() });
  }

  return new Response("Not Found", { status: 404 });
});
```

Token is generated on first run and stored in the config. The TUI reads it from
the same config file (since it's on the same machine for local-first use).

---

## What's NOT in the PoC

- **Multi-runtime routing** — PoC has one runtime (Claude Code). Multi-runtime comes later.
- **Channel adapters** — No Telegram, WhatsApp, etc. Just the direct client connection.
- **Memory system** — No persistent memory, no knowledge graph. Session history lives in Claude Code.
- **MCP tool server** — No custom tools exposed to the runtime. Claude Code uses its built-in tools.
- **Skill system** — No skill injection. Claude Code brings its own capabilities.
- **Cron / automation** — No scheduled tasks.
- **Multi-user** — Single user, single token.
- **Web UI** — TUI only for PoC. Web client is phase 2.

Each of these is a module that plugs in at a well-defined boundary.
The PoC proves the core data path. Everything else layers on top.

---

## Dependencies (PoC)

### Gateway (Deno)
```json5
// deno.json imports
{
  "imports": {
    // that's it for the gateway core — stdlib only
    // ACP parsing is just NDJSON readline, no SDK needed for client side
  }
}
```

The gateway itself has **zero npm dependencies** for the PoC.
ACP client-side is trivial: read lines from stdout, JSON.parse each line.
WebSocket server is built into Deno (`Deno.upgradeWebSocket`).
SQLite is built into Deno (`Deno.openKv`).

### TUI (Node/Deno via npm compat)
```json5
{
  "imports": {
    "ink": "npm:ink@5",
    "@inkjs/ui": "npm:@inkjs/ui",
    "react": "npm:react@18"
  }
}
```

### External binary
```
claude-code-acp    (npm: @zed-industries/claude-code-acp)
  or
claude-code-acp-rs (cargo: claude-code-acp-rs)
```

---

## Implementation Order

```
Phase 0: Validate assumptions                              [1 day]
  └── Spawn claude-code-acp from Deno
  └── Send ACP initialize + session/new + prompt
  └── Read streaming events from stdout
  └── Confirm it works (scripts/test-acp.ts)

Phase 1: Gateway core                                      [2-3 days]
  └── WebSocket server with token auth
  └── ACP bridge (spawn, session lifecycle, stream parsing)
  └── Router (session → runtime, trivial with one runtime)
  └── Policy engine (JSON rules, approval mediation)
  └── SQLite state store (sessions + audit log)
  └── Wire it all together: client msg → ACP prompt → stream → client

Phase 2: TUI client                                        [2-3 days]
  └── Ink app with Chat, Input, ToolStatus, ApprovalPrompt
  └── WebSocket connection to gateway
  └── Streaming text rendering
  └── Tool call status display
  └── Interactive approval prompts
  └── Session management (new, resume, list)

Phase 3: Polish + test                                     [1-2 days]
  └── Error handling (runtime crash, WS disconnect, ACP errors)
  └── Reconnection logic
  └── Graceful shutdown
  └── Basic logging (structured JSON to stderr)
  └── README + config docs

Total: ~1-2 weeks to a working PoC
```

---

## Future Modules (post-PoC, each plugs in at a boundary)

```
┌─────────────────────────────────────────────────────┐
│                  Post-PoC Roadmap                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Gateway extensions:                                │
│  ├── Multi-runtime (Codex, Ollama, pi-mono)         │
│  ├── MCP tool server (memory, cron, custom tools)   │
│  ├── Channel adapters (Telegram, Discord, Slack)    │
│  ├── Policy upgrade (OPA/Cedar)                     │
│  ├── OpenTelemetry tracing                          │
│  └── Cost tracking + budgets                        │
│                                                     │
│  Client extensions:                                 │
│  ├── Web UI (Next.js + AI Elements)                 │
│  ├── Mobile (ACP client, connects to gateway)       │
│  └── IDE integration (Zed, VS Code via ACP)         │
│                                                     │
│  Intelligence:                                      │
│  ├── Memory system (structured store + embeddings)  │
│  ├── Skill injection (AGENTS.md / CLAUDE.md gen)    │
│  ├── Smart routing (classify → pick runtime)        │
│  └── Cross-session knowledge graph                  │
│                                                     │
│  Specialized runtimes:                              │
│  ├── dbmeta-acp (your text-to-SQL as an ACP agent) │
│  ├── research-acp (web search + synthesis)          │
│  └── automation-acp (cron, webhooks, workflows)     │
│                                                     │
└─────────────────────────────────────────────────────┘
```
