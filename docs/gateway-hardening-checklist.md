# Gateway Hardening Checklist (P0/P1)

_2026-03-05_

This is implementation-ordered so work can run in parallel with session handoff efforts.

## P0 (do first)

### P0.1 Remove floating promise in session creation

Goal: eliminate unhandled rejection/crash path in `handleSessionNew`.

Code touchpoints:
- `packages/gateway/src/router.ts`
  - `handleSessionNew` currently uses `createAcpSession(...).then(...)`.
  - switch to an internal `void (async () => { ... })().catch(...)` or dedicated async helper.

Acceptance:
- no floating `then` chains in `handleSessionNew`.
- success path unchanged (`session_created` event + state writes).
- failures always emit gateway `error` event and never surface as unhandled rejection.

Tests:
- extend `packages/gateway/src/__tests__/router.test.ts`
  - simulate `stateStore.createSession` throw after ACP creation and assert emitted `error`.

---

### P0.2 Fix concurrent prompt event-handler overwrite

Goal: stop `session.onEvent(...)` from being rebound per prompt.

Current risk:
- `session.onEvent(recordingEmitWithHooks)` in prompt path can overwrite earlier turn callbacks.

Code touchpoints:
- `packages/gateway/src/router.ts`
  - bind ACP `onEvent` once per session at creation/hydration time.
  - route raw ACP events through a session-scoped dispatcher.
  - correlate per-turn execution state via turn-scoped handlers keyed by turn/execution id.
  - remove reliance on rebinding listener in `handlePrompt`.

Acceptance:
- only one `session.onEvent` bind per ACP session lifecycle.
- two overlapping prompts on same session keep independent execution finalization.
- `sessionInFlightTurns` increments/decrements remain balanced under overlap.

Tests:
- add/extend in `packages/gateway/src/__tests__/router.test.ts`
  - concurrent prompts on same session.
  - assert both turns finalize and counters recover.

---

### P0.3 Add WS backpressure protection

Goal: prevent unbounded memory growth on slow clients.

Code touchpoints:
- `packages/gateway/src/server.ts`
  - before `ws.send`, inspect `ws.bufferedAmount`.
  - enforce threshold policy (for example: warn, drop non-critical deltas, or terminate slow connection).

Acceptance:
- gateway does not indefinitely queue outbound frames for slow consumer.
- behavior is explicit and logged.

Tests:
- `packages/gateway/src/__tests__/server.test.ts`
  - simulate high `bufferedAmount` and verify chosen policy.

---

### P0.4 Runtime auto-restart on exit

Goal: recover from transient runtime process crashes without gateway restart.

Code touchpoints:
- `packages/gateway/src/start.ts`
  - in `agent.onExit`, schedule bounded restart with backoff.
  - mark runtime health `degraded`/`starting` during restart window.
  - avoid tight restart loops (max attempts or cooldown).

Acceptance:
- transient runtime exit restarts automatically.
- sessions are closed only when restart policy deems runtime unavailable (or until revived, based on chosen strategy).

Tests:
- extend startup/runtime lifecycle tests in `packages/gateway/src/__tests__/`.

---

### P0.5 Atomic token usage increments

Goal: remove read-modify-write race in token counters.

Code touchpoints:
- `packages/state/src/sessions.ts`
  - add method like `incrementSessionTokenUsage(id, inputDelta, outputDelta)` with SQL arithmetic update.
- `packages/state/src/store.ts`, `packages/state/src/index.ts`
  - expose new method on `StateStore`.
- `packages/gateway/src/router.ts`
  - replace `incrementSessionTokenUsage` read+write logic with atomic store call.

Acceptance:
- concurrent prompt updates cannot drop token increments.

Tests:
- state unit tests validating arithmetic update behavior.

## P1 (next)

### P1.1 DB-side paginated session list

Goal: avoid full-table scan for listing.

Code touchpoints:
- `packages/state/src/sessions.ts`
  - add query with principal filter + limit + optional cursor.
- `packages/types/src/protocol.ts`
  - optionally extend `session_list` request shape to include pagination/filter params.
- `packages/gateway/src/router.ts`
  - use store-level filtered query instead of `listSessions()` + JS filter.

Acceptance:
- list latency stable with large historical session table.

---

### P1.2 Usage summary aggregation query

Goal: avoid looping large execution arrays for state counts.

Code touchpoints:
- `packages/state/src/executions.ts`
  - add grouped count query by state for `sessionId`.
- `packages/gateway/src/router.ts`
  - use grouped counts in `buildUsageSummary`.

Acceptance:
- `usage_query summary` cost largely constant vs execution history size.

---

### P1.3 Session list API parity across clients

Status:
- `/session list|resume|transfer|close` is now wired in channels, TUI, and web.
- keep alias `/transfer ...` temporarily for compatibility.

Follow-up:
- remove alias after one release window.
- update user docs/help text to `/session ...` only.

## Suggested execution order

1. P0.1 floating promise
2. P0.2 event binding/concurrency
3. P0.5 atomic token counters
4. P0.3 WS backpressure
5. P0.4 runtime restart
6. P1.1 session-list pagination
7. P1.2 usage aggregation
8. P1.3 alias removal cleanup

## Release gates

- All gateway and channels tests green:
  - `bun run test --filter=@nexus/gateway`
  - `bun run test --filter=@nexus/channels`
- Build gates:
  - `bun run build --filter=@nexus/gateway --filter=@nexus/channels --filter=@nexus/client-core --filter=@nexus/tui --filter=@nexus/web-client`
- Manual smoke:
  - Telegram `/session list`, `/session resume`, `/session transfer request/accept`.
  - Simulate runtime exit and verify restart/recovery behavior.
