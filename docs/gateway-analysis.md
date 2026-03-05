# Gateway Analysis: Bottlenecks & Fragile Pieces

_2026-03-04_

## Critical (crash / data-loss risk)

### 1. In-Memory State — No Persistence Recovery

The router holds 12+ Maps of session state in memory (`sessions`, `sessionOwners`, `sessionPrincipals`, `sessionPolicyContexts`, `sessionLastActivityMs`, `sessionInFlightTurns`, `requestToSession`, `sessionIdempotency`, `sessionToPendingRequests`, `authChallenges`, `consumedAuthChallenges`, `sessionTransfers`). If the gateway process restarts, all of this is gone. The SQLite store only has session records and audit logs — it can't reconstruct in-flight state (ACP session handles, owner bindings, pending approvals).

A crash during an active turn means the user sees nothing. The `hydrateSessionIfPersisted` path creates a *new* ACP session with the same gateway session ID, but the agent's conversation context is lost (each `session/new` starts fresh in most ACP runtimes).

Note: State persistence now includes sessions, transcript, memory entries, executions, and channel bindings; however runtime process/session handles and in-flight ownership/approval maps remain in-memory only.

### 2. `session.onEvent` Rebinding on Every Prompt

`router.ts:1600` — `session.onEvent(recordingEmitWithHooks)` is called on every prompt. This replaces the event listener for that ACP session. If two prompts fire concurrently on the same session (no guard prevents this), the second `onEvent` call overwrites the first's recording emitter. The first prompt's `turn_end` callback (finalize execution, bump in-flight counter) may never fire correctly.

The `bumpInFlightTurns` counter can drift, causing sessions to either never get swept or get swept prematurely.

### 3. Floating Promise in `handleSessionNew`

`router.ts:812` — `createAcpSession(...).then(...)` is a floating promise. If the promise rejects and the error handler itself throws, it's an unhandled rejection that crashes the process. The error handler at line 863 looks safe, but any unexpected error in the success path (e.g., `stateStore.createSession` throwing) would be unhandled.

## High (throughput ceiling)

### 4. Single ACP Process Per Runtime

`start.ts:315` spawns one agent process per runtime profile. All sessions for a given runtime share that single process over stdio NDJSON. If the agent blocks on a long tool execution (5-min timeout at line 318), all other sessions queued behind it in the same process are stalled. There's no process pooling or request multiplexing.

With N concurrent sessions on one runtime, throughput is limited by the agent's serial processing. A single hung prompt blocks the whole runtime.

### 5. No Backpressure on WebSocket Writes

`server.ts:71-73` — the `emit` function does `ws.send(JSON.stringify(event))` with no buffering or backpressure check. If the client can't consume events fast enough (e.g., streaming text_deltas over a slow connection), the ws send buffer grows unbounded in memory.

### 6. Runtime Exit Without Restart

`start.ts:322-335` — when a runtime process exits, the gateway marks it unavailable and closes all sessions, but never attempts to restart it. A transient agent crash (OOM, segfault) permanently takes down that runtime until the whole gateway is restarted.

## Medium (scaling concern)

### 7. `buildUsageSummary` Scans All Executions

`router.ts:1973` calls `stateStore.listExecutions(sessionId, 5_000)` and loops through all of them to count states. For long-lived sessions with hundreds of executions, this is an O(n) scan on every usage query.

### 8. `handleSessionList` Full Table Scan + Filter

`router.ts:1754` calls `stateStore.listSessions()` (returns all sessions ever created), then filters in JS. Principal filtering is now applied in router, but there is still no pagination and no index-assisted filtering by principal/status. Grows linearly with total session count across gateway lifetime.

### 9. `incrementSessionTokenUsage` — Read-Modify-Write Race

`router.ts:493-501` reads the session record, adds deltas, and writes back. If two concurrent prompts on the same session both call this, they read the same base value and one update is lost. SQLite serializes writes, but the read happens outside the transaction.

## Low

### 10. `sweepIdleSessions` Iterates All Active Sessions

`router.ts:2354` iterates the full `sessions` Map every 30 seconds. Fine for tens of sessions but scales linearly. Not a concern at current scale.

## Execution Plan

See `docs/gateway-hardening-checklist.md` for an implementation-ordered P0/P1 plan with acceptance criteria.
