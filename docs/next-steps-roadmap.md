# Nexus — Next Steps Roadmap (Post-PoC)

## Purpose

Define the next major milestones after the current PoC stage, aligned to:

- Original Nexus goals in `docs/nexus-poc-architecture.md`
- Hardening and evolution themes in `docs/work-plans.md`
- First-principles lessons from `docs/openclaw-architecture.md` and `docs/pluggable-agent-runtime.md`

This document is execution-oriented: each milestone has scope, dependencies, and acceptance criteria.

---

## Current Baseline (What Already Works)

1. End-to-end chain is operational: TUI -> WS -> Gateway -> ACP -> runtime streaming.
2. Policy-mediated approvals are implemented.
3. Runtime registry exists (Claude/Codex), with per-session runtime/model selection.
4. TUI commands now include runtime/model controls and status visibility.
5. Headless orchestration Option A exists via `@nexus/cli`.
6. Memory provider is wired with session + workspace scopes, and hybrid context retrieval is used on prompts.
7. TUI includes `/workspace` and `/memory` operational commands for memory visibility and control.
8. Session creation supports explicit principal metadata (`principalType`, `principalId`) and source (`interactive | schedule | hook | api`).
9. Prompt and turn streams carry execution correlation fields (`executionId`, `turnId`, `policySnapshotId`) for tracing and audit joins.
10. Prompt idempotency keys are supported for duplicate suppression (`stopReason: "idempotent_duplicate"`).

Primary gaps:

1. No external chat channels (Telegram/Discord).
2. No persisted first-class `Execution` record/graph (`parentExecutionId`, durable state transitions) yet.
3. No scheduler/pipeline execution layer.
4. Security is still PoC-level (auth scope, secrets, sandbox posture, audit completeness).
5. No capability-token binding model yet (principal ∩ policy ∩ runtime ∩ execution token).
6. External secure hook ingress is not implemented.
7. Admin/observability surfaces are minimal.
8. Workspace model is not yet fully first-class across policy/auth/secrets (memory is ahead of other subsystems).

---

## First-Principles Constraints

1. Keep the gateway protocol-first and runtime-agnostic.
2. Preserve modular package boundaries; avoid another monolith.
3. Put policy/security decisions in deterministic components, not only in model behavior.
4. Make each new capability pluggable (memory providers, channel adapters, schedulers).
5. Ensure operational visibility before scale features.

---

## Milestone Sequence (Recommended)

## M0 — Reliability + Operability Foundation

### Why first
All later milestones depend on stable session lifecycle, runtime health handling, and debuggability.

### Scope

1. Structured logging with correlation IDs (`connectionId`, `sessionId`, `runtimeId`, `turnId`).
2. Runtime health model (startup checks, liveness, degraded/unavailable states).
3. Session lifecycle hardening:
   - explicit close
   - idle timeout
   - deterministic cleanup
4. Approval routing index (`requestId -> sessionId`) to remove session scans.
5. Reconnect/resume behavior for clients (minimum viable resume semantics).

### Acceptance criteria

1. Gateway emits structured logs for all session transitions and approvals.
2. Runtime crash produces explicit health/state event and no silent hangs.
3. Idle sessions are cleaned according to configured timeout.
4. Approval response routing is O(1) by request ID.
5. A reconnecting client can continue an existing session without data corruption.

### Non-goals

1. Multi-tenant auth redesign.
2. New channel adapters.

---

## M0.5 — Execution Substrate Common Ground

### Why now
Bridge interactive sessions to future scheduler/hooks/orchestration without redesigning the protocol later.

### Scope

1. Standardize principal/source envelope on session creation (`principalType`, `principalId`, `source`).
2. Attach execution correlation to turn/tool/approval events (`executionId`, `turnId`, `policySnapshotId`).
3. Add prompt idempotency key handling to prevent accidental duplicate execution starts.
4. Persist execution context in audit details for approvals/tool calls/errors.
5. Define and stage next substrate pieces:
   - durable `executions` table with lifecycle state machine
   - `parentExecutionId` for delegation graphs
   - capability token binding at execution start
6. Add principal-proof client identity + session handoff substrate:
   - durable client keypair (device identity)
   - nonce challenge + signature to bind WS connection to `principalId`
   - explicit session transfer primitives (request/accept) keyed by principal, not raw connection
   - stage account-level identity linking so one user can operate multiple device principals with controlled pull/resume semantics

### Acceptance criteria

1. Every prompt run has stable execution/turn identifiers visible in logs and client events.
2. Approval and tool events are joinable back to an execution ID and policy snapshot ID.
3. Duplicate prompt retries with the same idempotency key do not launch new runtime turns.
4. Session metadata supports non-interactive principals (`service_account`) and non-chat sources.
5. Contract tests validate protocol/runtime guards for all new fields.
6. Mutating actions are attributable to an authenticated `principalId` proven via signed nonce handshake.
7. Replay attempts with stale/used nonces are rejected deterministically.
8. Session handoff supports explicit transfer across clients/principals with policy-enforced authorization checks.

### Non-goals

1. Full execution DAG orchestration semantics in this milestone.
2. Hook endpoint implementation.
3. Scheduler UI/API.

---

## M1 — Pluggable Memory + Smart Context Management

### Scope

1. Define `MemoryProvider` interface:
   - `store`
   - `search`
   - `getContext`
   - `summarize`
2. Implement SQLite memory provider (baseline) with typed records:
   - entity/fact/event
   - source metadata
   - confidence
   - timestamps
3. Context manager with budget tiers:
   - hot: recent exact context
   - warm: summaries
   - cold: searchable historical memory
4. Workspace boundary support:
   - session scope memory
   - workspace-shared scope memory
   - hybrid retrieval for prompt context
5. Expose memory through tools (ACP/MCP-facing), not prompt blob injection.
6. Add memory observability:
   - retrieval hit rate
   - summary count
   - token budget usage by tier

### Dependencies

1. M0 logging + lifecycle stability.
2. Stable per-session identity keys.

### Acceptance criteria

1. Memory provider is replaceable behind interface; SQLite is just one implementation.
2. Agent can retrieve relevant facts via tool call during a turn.
3. Context assembly remains under configurable token budget.
4. Summaries preserve provenance (where fact came from).
5. Session and workspace memory scopes are independently queryable.
6. Tests cover provider contract and tiered context selection.

### Non-goals

1. Full knowledge graph UI.
2. Multi-modal memory (images/audio) in v1.

---

## M2 — Pluggable Clients (Discord + Telegram)

### Scope

1. Define `ChannelAdapter` contract:
   - inbound normalization -> internal prompt events
   - outbound rendering/capability constraints
   - approval UX mapping per channel
2. Implement Discord adapter (first) and Telegram adapter (second).
3. Session identity strategy for channels:
   - user/channel/thread mapping
   - explicit session resume semantics
4. Capability negotiation layer:
   - plain text / markdown subset / attachments / interactive actions
5. Channel-level policy overlays (per adapter and per workspace).

### Dependencies

1. M0 session lifecycle robustness.
2. M1 context tooling for cross-session continuity.

### Acceptance criteria

1. Both adapters can create and continue sessions through gateway protocol.
2. Approval requests are actionable in-channel with deterministic response mapping.
3. Channel-specific rendering constraints are enforced (no broken rich output flood).
4. Per-channel rate limits and basic abuse guardrails are in place.
5. End-to-end tests exist for adapter -> gateway -> runtime -> adapter loop.

### Non-goals

1. WhatsApp/inbox ecosystem parity in same milestone.
2. Full web admin panel for channels.

---

## M3 — Task Scheduler + Pipeline Builder

### Scope

1. Durable scheduler primitives:
   - one-shot jobs
   - cron jobs
   - retries with backoff
   - dead-letter queue
2. Pipeline model (DAG-lite for v1):
   - step inputs/outputs
   - conditionals
   - cancellation and resume
3. Execution engine integration with gateway sessions (headless path via `@nexus/cli` or direct protocol client).
4. Policy enforcement at step boundaries.
5. Run history and audit records for pipeline executions.

### Dependencies

1. M0 lifecycle + observability.
2. M1 memory (for context continuity between scheduled runs).

### Acceptance criteria

1. Scheduled job executes reliably after process restart.
2. Pipeline steps produce typed outputs and deterministic state transitions.
3. Failures are retryable and fully auditable.
4. User can cancel an in-flight pipeline and observe terminal state.
5. At least one real workflow template is shipped and tested.

### Non-goals

1. Full visual pipeline editor.
2. Arbitrary distributed worker cluster in v1.

---

## M4 — Security Hardening Program

### Scope

1. Secrets management hardening:
   - provider abstraction (env/local secure store/vault)
   - redaction in logs
   - rotation hooks
2. Auth evolution:
   - scoped credentials (user/session/runtime)
   - expiration/renewal
   - short-lived WS connection tickets (issued from authenticated identity)
   - explicit token classes (bootstrap/admin/user/session/service)
3. Bootstrap + install hardening:
   - first-run bootstrap mode with one-time setup secret
   - server signing key generation and secret-manager persistence
   - disable bootstrap mode after first admin is provisioned
   - no committed real secrets/tokens in tracked config
4. Policy engine evolution:
   - regex/structured conditions
   - per-user/per-channel policy overlays
5. Runtime sandbox posture:
   - runtime profile restrictions (FS/network/tool categories)
   - hardened defaults for untrusted channels
6. Security audit trail completeness:
   - all approval decisions
   - policy match reason
   - runtime tool execution metadata

### Dependencies

1. M0 log and state foundations.
2. M2 channel adapters (for threat model validation).

### Acceptance criteria

1. Secret material does not appear in logs under normal and error paths.
2. Scoped auth prevents unauthorized session and admin actions.
3. Every tool action has attributable policy decision records.
4. Security profiles can be applied per runtime/channel combination.
5. Threat-model walkthrough is documented and test-backed for top abuse paths.
6. Bootstrap setup secret is one-time use and rejected after initial admin provisioning.
7. WS connection tickets are short-lived, auditable, and bound to authenticated principal identity.
8. Checked-in config files contain no live credentials; local overrides are gitignored.

### Non-goals

1. Formal compliance certification.
2. Hardware TEEs or confidential compute in this phase.

---

## M5 — Strategic Additions (From OpenClaw Comparison)

These should run as parallel tracks or follow-ups depending on team bandwidth.

### Track A: Structured Outputs

1. Add protocol path for schema-constrained responses (not only free text deltas).
2. Runtime capability flags for structured-output support.
3. Deterministic parser/validator in gateway with fallback behavior.

Acceptance:

1. Client can request JSON schema output and receive validated payload.
2. Invalid outputs surface explicit, typed errors.

### Track B: Admin/Observe Plane (Option C)

1. Add admin introspection endpoints/streams for sessions, events, and health.
2. Separate auth scope from user chat scope.

Acceptance:

1. Operators can inspect active sessions and recent events without log scraping.
2. Admin auth cannot be used as chat auth.

### Track C: Cost + Usage Normalization

1. Normalize token/cost telemetry across runtimes.
2. Per-session and per-pipeline cost views.

Acceptance:

1. Same metric schema works for Claude and Codex paths.
2. Budget alerts can trigger policy outcomes (warn/deny/require approval).

---

## 90-Day Suggested Plan

1. Days 1-21: M0 (foundation) + M0.5 protocol substrate (principal/source/correlation/idempotency).
2. Days 22-50: M1 (memory/context) baseline provider + budget manager.
3. Days 51-75: M2 (Discord then Telegram) + channel policy overlays.
4. Days 76-90: M3 scheduler/pipeline MVP + M4 security tranche 1 kickoff.

Parallel during entire window:

1. Track B (admin/observe plane) incremental rollout.
2. Design work for Track A (structured outputs) and Track C (cost normalization).

---

## Definition of Done (Program Level)

1. Every milestone lands with:
   - contract tests
   - package-level unit tests
   - at least one end-to-end scenario
2. No milestone introduces cross-package architectural shortcuts that break pluggability.
3. Security and audit data are preserved across restarts.
4. Operator can answer: "what happened, why, and under which policy?" for any session/pipeline run.

---

## Open Decisions to Resolve Early

1. Memory backend path after SQLite baseline:
   - stay SQLite + extension
   - external vector/search service
2. Orchestration posture after Option A:
   - continue with Option C first (recommended)
   - jump to full session graph (Option B)
3. Auth model target:
   - single-tenant hardened
   - multi-user first-class
4. Bootstrap secret and identity provider posture:
   - local bootstrap + built-in auth first
   - external IdP (OIDC/SAML) first
5. Scheduler execution model:
   - embedded worker
   - external worker process pool

These decisions should be explicitly recorded before starting M2/M3 implementation.
