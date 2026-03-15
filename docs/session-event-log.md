# Session Event Log

_2026-03-10_

## Problem

The gateway streams `GatewayEvent`s to connected clients but does not persist them. This creates four concrete gaps:

1. **Cross-device continuity** — when a session is transferred to another device, the new client gets no scrollback. It's like joining a phone call mid-sentence.
2. **Runtime migration** — switching a session from one runtime to another (e.g. codex → claude) requires replaying conversation history into the new ACP session. There's nothing to replay from.
3. **Reconnect recovery** — if a client disconnects briefly and reconnects, missed events are lost.
4. **Session fork** — forking from a specific turn requires the full event history up to that point.

## What Exists Today

The gateway has two data layers, neither of which solves this:

**`transcript_messages` (in `@nexus/state`)** — per-turn `{role, content}` records. Used by the memory system for fact extraction and summarization. Stores user text + assistant text, but not tool calls, approvals, deltas, or structured event data. Not suitable for client replay.

**`@nexus/memory`** — derived facts + summaries with hot/warm/cold tiers and token budgets. Designed for LLM context injection, not client-facing history.

Neither captures the full `GatewayEvent` stream that clients need.

## Proposal: Session Event Log

Add a per-session append-only log of `GatewayEvent`s in SQLite. The gateway appends every event it emits to connected clients into this log. Clients can request the log on connect to get scrollback.

### What Gets Logged

All conversation-relevant `GatewayEvent` types:

| Event type | Logged? | Notes |
|---|---|---|
| `text_delta` | Yes | Core conversation content |
| `thinking_delta` | Yes | Agent reasoning |
| `tool_start` | Yes | Tool invocations |
| `tool_end` | Yes | Tool results |
| `approval_request` | Yes | Permission flow |
| `turn_end` | Yes | Turn boundaries |
| `error` | Yes | Session errors |
| `session_created` | Yes | Session metadata |
| `session_updated` | Yes | Lifecycle changes |
| `session_closed` | Yes | Terminal event |
| `session_list` | No | Query response, not session-scoped |
| `runtime_health` | No | Operational, not conversation |
| `auth_*` | No | Connection-scoped, not session-scoped |
| `session_transfer_*` | Yes | Ownership changes are part of history |
| `session_lifecycle` | Yes | State transitions |
| `transcript` | No | Already a replay mechanism |
| `memory_result` | No | Query response |
| `usage_result` | No | Query response |

### Schema

New table in `@nexus/state`:

```sql
CREATE TABLE session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,          -- JSON-serialized GatewayEvent
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  executionId TEXT,                   -- from EventCorrelation, indexed for turn-based queries
  turnId      TEXT,                   -- from EventCorrelation
  FOREIGN KEY (sessionId) REFERENCES sessions(id)
);

CREATE INDEX idx_session_events_session ON session_events(sessionId, id);
CREATE INDEX idx_session_events_execution ON session_events(executionId) WHERE executionId IS NOT NULL;
```

Key design choices:
- **`payload` is the full JSON event** — no lossy decomposition. The schema can evolve without migration.
- **`type` is denormalized** — enables fast filtering without parsing JSON.
- **`id` is monotonic** — clients can request "events after id N" for efficient catch-up.
- **Correlation fields pulled to columns** — enables turn-based and execution-based queries.

### Store Interface

```typescript
interface EventLogStore {
  append: (event: GatewayEvent) => number;               // returns event id
  getEvents: (sessionId: string, opts?: {
    afterId?: number;          // for catch-up after reconnect
    types?: string[];          // filter by event type
    executionId?: string;      // filter by execution
    limit?: number;            // cap results
  }) => StoredEvent[];
  getLatestId: (sessionId: string) => number | undefined; // for cursor tracking
  deleteEvents: (sessionId: string) => void;              // on session close/cleanup
  getEventCount: (sessionId: string) => number;
}

interface StoredEvent {
  id: number;
  sessionId: string;
  type: string;
  payload: GatewayEvent;
  timestamp: string;
  executionId?: string;
  turnId?: string;
}
```

### Protocol Changes

**New `ClientMessage`:**

```typescript
{ type: "session_history"; sessionId: string; afterId?: number; limit?: number }
```

Client sends this on connect (or reconnect) to request missed events.

**New `GatewayEvent`:**

```typescript
{ type: "session_history"; sessionId: string; events: StoredEvent[]; hasMore: boolean; nextAfterId?: number }
```

Gateway responds with the event log. Paginated if the log is large.

**Existing `session_replay`:**

Currently `session_replay` is defined but its behavior is minimal. With the event log, it becomes: read events from the log, re-emit them to the client. This replaces whatever ad-hoc replay exists.

### Gateway Integration

The append happens in one place — the router's `emit` function. Every `GatewayEvent` that flows to a client also gets appended to the log:

```typescript
// In router, where events are dispatched to WS clients
const emit = (event: GatewayEvent) => {
  // Existing: send to connected client(s)
  sendToClient(connectionId, event);

  // New: persist to event log (if session-scoped)
  if ('sessionId' in event && shouldLog(event.type)) {
    eventLogStore.append(event);
  }
};
```

Failure handling: event log writes are best-effort. A failed append logs a warning but does not block event delivery to clients. The log is a convenience layer, not a correctness layer.

---

## Consumers

### 1. Cross-Device Session Transfer

When a transfer completes and the new client connects:

```
Client → { type: "session_history", sessionId: "abc" }
Gateway → { type: "session_history", sessionId: "abc", events: [...], hasMore: false }
```

The client renders the full conversation. No more blank screen.

### 2. Reconnect Recovery

Client tracks `lastSeenEventId`. On reconnect:

```
Client → { type: "session_history", sessionId: "abc", afterId: 847 }
Gateway → { type: "session_history", events: [events 848..current], hasMore: false }
```

Client appends missed events to its local state. Seamless.

### 3. Runtime Migration (Future)

When switching a session from runtime A to runtime B:

1. Park the current ACP session
2. Read the event log for the session
3. Reconstruct conversation context from `text_delta` + `tool_start`/`tool_end` events
4. Create a new ACP session on runtime B
5. Seed it with the reconstructed context (as a system message or replayed prompts)
6. Update `acpSessionId` on the session record
7. Resume

The event log provides the raw material. A `contextFromEvents(events)` helper can reconstruct a conversation summary suitable for a new runtime.

### 4. Session Fork (Future)

Fork from turn N:

1. Query `eventLogStore.getEvents(sessionId, { executionId: targetExecutionId })`
2. Get all events up to and including that turn
3. Create new session, seed with the event history
4. Continue from there

### 5. Memory System (Refactor)

Currently the router manually calls `recordTurn(userText, assistantText)` on the memory provider. With the event log as the source of truth, memory ingestion can become a downstream consumer:

```
Event Log → derive user/assistant text per turn → feed to memory provider
```

This is a future refactor, not a blocker. The existing `transcript_messages` and `recordTurn` flow continues working alongside the event log.

---

## Sizing & Retention

**Per-event cost:** ~200-500 bytes for text deltas, ~1-2KB for tool events. A typical coding session with 50 turns might produce 2,000-5,000 events → 1-5 MB of JSON in SQLite.

**Retention options:**
- **Default:** Keep all events for active/idle sessions. Delete on `session_close`.
- **TTL:** Auto-delete events older than N days for closed sessions.
- **Compaction:** For very long sessions, older events could be summarized (keep turn boundaries + a text summary, drop individual deltas). This is future work.

Configuration:

```json
{
  "eventLog": {
    "enabled": true,
    "retentionDays": 30,
    "maxEventsPerSession": 50000
  }
}
```

---

## Implementation Plan

### Step 1: Schema + Store

- Add `session_events` table to `@nexus/state` migrations
- Implement `EventLogStore` with `append`, `getEvents`, `getLatestId`, `deleteEvents`
- Tests: append, query with filters, pagination, delete

### Step 2: Gateway Append

- Wire `eventLogStore.append()` into the router's emit path
- Filter: only log session-scoped conversation events (see table above)
- Add `eventLog` config section to gateway config

### Step 3: Protocol — `session_history`

- Add `session_history` to `ClientMessage` in `@nexus/types`
- Add `session_history` to `GatewayEvent` in `@nexus/types`
- Handle in router: read from event log, emit to client
- Wire into `session_replay`: read log, re-emit events
- Tests: E2E — send events, request history, verify

### Step 4: Client Integration

- `@nexus/client-core`: on connect/reconnect, send `session_history` with `afterId`
- Merge received history into local state
- TUI: render historical events on session attach/transfer

### Step 5: Reconnect Recovery

- Client tracks `lastSeenEventId` from incoming events
- On reconnect + session resume, request `session_history` with `afterId`
- Deduplicate if needed (idempotent merge by event id)

---

## Dependencies

- `@nexus/state` — new table + store
- `@nexus/types` — new protocol messages
- `@nexus/gateway` — append on emit, handle `session_history`
- `@nexus/client-core` — history request on connect/reconnect
- `@nexus/tui` — render historical events

No new packages. No external dependencies.

---

## Relationship to Existing Systems

```
Layer 0: GatewayEvent stream (live, ephemeral)
  ↓ append
Layer 1: Session Event Log (new, persistent, full fidelity)
  ↓ derive
Layer 2: transcript_messages (existing, per-turn role/content)
  ↓ extract
Layer 3: memory_items (existing, facts + summaries, hot/warm/cold)
```

The event log is the new foundation. Layers 2 and 3 continue working as-is. A future refactor could derive Layer 2 from Layer 1 instead of the current manual `recordTurn` calls, but that's not required.

---

## Open Questions

1. **Delta coalescing** — should `session_history` return raw `text_delta` events (potentially hundreds per turn) or coalesce them into complete messages? Raw is simpler and preserves fidelity. Coalesced is better for client rendering. Could offer both via a query parameter.

2. **Event log as the transcript source** — should `transcript_messages` eventually be derived from the event log, or remain a parallel write? Parallel is simpler now, derived is cleaner long-term.

3. **Large payload events** — `tool_end` results can be very large (file contents, command output). Should these be truncated in the log, or stored in full? Full is safer for replay; truncated saves space.

4. **Encryption at rest** — if sessions contain sensitive conversation data, should the event log be encrypted? Not needed for local-first single-user, but relevant for multi-user deployments.
