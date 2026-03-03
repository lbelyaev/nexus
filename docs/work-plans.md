# Nexus — Future Work Plans

This document captures planned improvements, features, and architectural evolution beyond the PoC. Items are grouped by theme and roughly prioritized within each section.

---

## Phase 1: Production Hardening

### 1.1 Reconnection & Resilience
- **WebSocket reconnection in client-core**: Exponential backoff with jitter in `useConnection`. Currently the hook does not attempt reconnect on disconnect.
- **ACP agent restart**: If the cc-acp subprocess crashes, the gateway should detect (via `agent.onExit`) and either restart it or mark all sessions as errored.
- **Heartbeat/ping-pong**: Add WS ping frames to detect dead connections. Both gateway and client should participate.

### 1.2 Error Handling
- **Structured error codes**: Replace string error messages with error codes + human messages. Define an error taxonomy (auth, session, acp, policy, internal).
- **Error boundaries in TUI**: Wrap components in React error boundaries so a rendering crash doesn't kill the whole TUI.
- **RPC timeout tuning**: The 30s default in `createRpcClient` may be too short for long tool calls. Make configurable per-session or per-tool.

### 1.3 Logging & Observability
- **Structured logging**: Replace `console.log` in `start.ts` with a proper logger (pino or similar). JSON output, log levels, correlation IDs.
- **Metrics**: Track per-session token usage, latency, tool call counts. Expose via `/metrics` endpoint or write to SQLite.
- **Audit log completeness**: Log all tool calls, policy decisions, and permission outcomes. Currently only approval responses are audited.

### 1.4 Configuration
- **Config validation**: Use zod or similar to validate `nexus.json` at startup with clear error messages.
- **Config hot-reload**: Watch policy file for changes, reload without restart.
- **Multiple config sources**: Support env vars for all config fields (e.g., `NEXUS_PORT`, `NEXUS_HOST`).

---

## Phase 2: Multi-Session & Multi-Client

### 2.1 Session Isolation
- **Per-session ACP sessions**: Currently the gateway creates ACP sessions on the same agent process. Each gateway session should map to its own ACP session with proper isolation.
- **Session lifecycle**: Add explicit session close/cleanup. Set idle timeouts that close inactive sessions.
- **Session resume**: Allow clients to reconnect to existing sessions after a WS disconnect.

### 2.2 Multi-Client Support
- **Multiple WS clients**: Allow multiple TUI/web clients to connect simultaneously. Each gets its own session namespace.
- **Session sharing**: Optional ability for multiple clients to observe the same session (read-only spectators).
- **Broadcast events**: System-wide events (agent restart, policy change) broadcast to all connected clients.

### 2.3 Approval Routing
- **Per-session approval tracking**: Currently `handleApprovalResponse` iterates all sessions. Track which session owns each pending approval request by requestId.
- **Approval timeout**: If user doesn't respond within N seconds, auto-deny with audit log entry.

---

## Phase 3: Pluggable Agent Runtimes

### 3.1 Runtime Abstraction
- **AgentRuntime interface**: Abstract `spawnAgent` + `createAcpSession` behind an `AgentRuntime` interface that different backends can implement.
- **Runtime registry**: Register multiple runtimes (Claude Code, Codex, custom). Route sessions to specific runtimes by config or user choice.
- **Runtime health checks**: Periodic health probes to each runtime. Mark unhealthy runtimes as unavailable.

### 3.2 Additional Runtimes
- **Codex CLI**: Add a Codex ACP bridge (if Codex supports ACP or build a shim).
- **In-process runtime**: For testing/development, an in-process mock agent that responds with canned answers.
- **Remote agent**: Connect to an ACP agent over TCP/SSH instead of local subprocess.

---

## Phase 4: Web Client

### 4.1 Web UI Package
- **`@nexus/web-client`**: React web app using the same `@nexus/client-core` hooks. This validates the hook abstraction.
- **Streaming chat UI**: Real-time text rendering, tool call visualizations, approval dialogs.
- **Auth flow**: Token entry or session-based auth for web clients.

### 4.2 HTTP API
- **REST endpoints**: In addition to WebSocket, expose REST API for session management (`POST /sessions`, `GET /sessions/:id`).
- **SSE alternative**: Server-Sent Events as a fallback for environments where WebSocket is unavailable.

---

## Phase 5: Memory & Context

### 5.1 Conversation History
- **Gateway-side transcript storage**: Store conversation messages in SQLite for persistence across client reconnects.
- **Context windowing**: Track token usage and implement context summarization triggers.
- **Search/retrieval**: Allow querying past conversations for relevant context.
- **Workspace boundaries**: Add first-class `workspaceId` scoping so shared memory can be retrieved across sessions inside a workspace while preventing cross-workspace bleed.

### 5.2 MCP Integration
- **MCP server hosting**: Gateway hosts MCP servers that agents can use for memory, tools, and resources.
- **Shared MCP servers**: Multiple sessions can share MCP servers (e.g., a database MCP server).
- **MCP discovery**: Agents can discover available MCP servers through the gateway.

---

## Phase 6: Security Hardening

### 6.1 Auth Evolution
- **JWT tokens**: Replace simple hex tokens with JWTs that carry claims (user, session scope, expiry).
- **Token rotation**: Support token refresh without reconnecting.
- **Per-user auth**: Multiple users with different permissions, not just a single shared token.

### 6.2 Sandbox
- **Agent sandboxing**: Run the ACP agent in a sandboxed environment (container, nsjail, etc.).
- **File system restrictions**: Limit which directories the agent can access via policy.
- **Network restrictions**: Control which URLs the agent can fetch.

### 6.3 Policy Evolution
- **Regex patterns**: Upgrade from substring matching to full regex in policy rules.
- **Conditional rules**: Rules that consider session context (e.g., "allow Exec only if previous Exec was approved").
- **Policy per-user**: Different users get different policy configs.
- **Policy audit trail**: Version policy changes with timestamps and who changed them.

---

## Phase 7: Developer Experience

### 7.1 CLI Improvements
- **`nexus init`**: Interactive setup wizard that creates config files.
- **`nexus status`**: Show running gateway info, connected clients, active sessions.
- **`nexus logs`**: Tail audit logs from the SQLite store.

### 7.2 Plugin System
- **Skill plugins**: Define reusable tool compositions as skills that can be loaded at runtime.
- **Hook system**: Pre/post hooks on tool calls for custom logic (logging, rate limiting, etc.).

### 7.3 Testing Infrastructure
- **Mock ACP server**: A standalone mock cc-acp binary for integration testing without Claude Code.
- **Snapshot testing**: Record and replay ACP sessions for deterministic integration tests.
- **Load testing**: Simulate multiple concurrent clients to find bottlenecks.

---

## Technical Debt

These items should be addressed as the codebase grows:

1. **RPC handlers are single-handler**: `onNotification` and `onRequest` each overwrite the previous handler. Should support multiple listeners.
2. ~~**No input validation on gateway entry**: `start.ts` doesn't validate that the data directory exists or is writable.~~ RESOLVED — `start.ts` now creates `dataDir` with `mkdirSync({ recursive: true })`.
3. **Approval routing is naive**: Iterates all sessions to find the one with a pending approval. The permission flow now tracks pending requests per-session via `pendingPermissions` map inside `createAcpSession`, but the router still iterates sessions.
4. **No graceful handling of ACP init failure**: If `initialize` fails, the gateway logs an error but continues running in a broken state.
5. **TUI doesn't handle reconnection**: If the WS drops, the TUI shows "Disconnected" but doesn't attempt reconnection.
6. **No rate limiting**: No protection against clients flooding the gateway with messages.
7. **Session cleanup**: Old sessions are never cleaned up from the in-memory map or SQLite.
8. **Config path resolution**: `findRepoRoot()` walks up looking for `package.json` with `workspaces`. This works for the monorepo layout but would need adjustment for standalone deployments.
