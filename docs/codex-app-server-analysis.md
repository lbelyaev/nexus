# Codex App-Server Protocol — Analysis & Adoption Plan for Nexus

## Purpose

Cross-reference the Codex app-server protocol (OpenAI's rich client integration wire protocol) with Nexus's current gateway protocol. Identify ideas worth adopting, gaps to close, and things to deliberately skip.

---

## Protocol Comparison

### Conceptual Model

| Concept | Codex | Nexus |
|---------|-------|-------|
| Conversation | Thread (persistent, resumable, forkable) | Session (in-memory + SQLite metadata) |
| User request | Turn (multi-item, steerable) | Prompt (flat text + images) |
| Work unit | Item (typed: message, command, fileChange, mcpToolCall, ...) | Flat events (text_delta, tool_start, tool_end) |
| Approval | Per-item type (command vs file vs network) | Unified approval_request/response |
| Streaming | Per-item deltas with item/started + item/completed lifecycle | Flat delta stream per session |
| Sandbox | First-class policy object on thread/turn | Policy rules file (first-match-wins) |

### Feature Matrix

```
Feature                          Codex    Nexus    Gap
─────────────────────────────────────────────────────────
JSON-RPC 2.0 transport             yes      yes¹    —
stdio + WebSocket                  yes      yes     —
Initialize handshake               yes      yes     —
Capability negotiation             yes      no      medium
Session/thread persistence         yes      partial²
Session resume after disconnect    yes      yes     —
Session fork                       yes      no      low priority
Turn steering (mid-flight input)   yes      no      interesting
Item-typed work units              yes      no      high value
Per-item lifecycle events          yes      no      high value
Structured approval types          yes      partial³
acceptForSession escalation        yes      no      medium
Sandbox policy object              yes      no      medium
Thread compaction                  yes      no      medium
Plan mode / plan items             yes      no      low⁴
Review mode                        yes      no      skip⁵
Skills / apps discovery            yes      no      future
Multi-input (text/image/skill)     yes      partial⁶
Error taxonomy (codexErrorInfo)    yes      no      high value
Token usage streaming              yes      partial⁷
Thread archival                    yes      no      low
Config management via protocol     yes      no      low
Model listing via protocol         yes      yes⁸    —
Rollback (drop last N turns)       yes      no      interesting
Collaboration modes                yes      no      skip⁹
MCP server management              yes      partial
Principal identity / auth          basic    rich¹⁰  Nexus ahead
Session transfer                   no       yes     Nexus ahead
Session lifecycle state machine    no       yes     Nexus ahead
Memory provider integration        no       yes     Nexus ahead
Execution correlation IDs          no       yes     Nexus ahead
Policy engine (first-match rules)  no       yes     Nexus ahead
Runtime registry (multi-runtime)   no       yes     Nexus ahead
```

Notes:
1. Gateway↔Agent is JSON-RPC; Client↔Gateway is plain JSON messages (not JSON-RPC).
2. Session metadata persists in SQLite; transcripts owned by agent runtime.
3. Nexus has approval options with kinds but doesn't distinguish command vs file vs network.
4. Plan mode is runtime-specific; gateway shouldn't own it.
5. Review is Codex-specific (git-oriented); not applicable to runtime-agnostic gateway.
6. Nexus supports text + images; no skill/mention input types.
7. Token usage is tracked in session records but not streamed as events.
8. Via runtime registry model catalog + `/models` TUI command.
9. Collaboration modes are Codex multi-agent; Nexus has its own orchestration roadmap.
10. Nexus has principal-proof auth (ed25519 challenge), session transfer, lifecycle state machine.

---

## What Nexus Should Adopt

### Tier 1 — High Value, Moderate Effort

#### 1. Item-Typed Work Units

**What**: Replace flat `tool_start`/`tool_end`/`text_delta` with typed items that have explicit lifecycle (`item_started` → deltas → `item_completed`).

**Why**:
- Clients can render different item types differently (command output, file diff, agent message, MCP tool call).
- Each item gets an `itemId` for correlation — deltas reference their parent item.
- Completed items carry final authoritative state (exit code, diff, result).
- Enables future features like item-level retry, rollback, or approval.

**Proposed item types for Nexus**:
- `agent_message` — text output (replaces `text_delta` stream)
- `thinking` — reasoning/thinking output (replaces `thinking_delta`)
- `tool_call` — any tool invocation (replaces `tool_start`/`tool_end`)
- `approval_gate` — approval request as an item in the turn flow

**Protocol shape**:
```
item_started   { sessionId, turnId, itemId, itemType, ...initial }
item_delta     { sessionId, turnId, itemId, deltaType, ...delta }
item_completed { sessionId, turnId, itemId, itemType, ...final }
```

**Migration**: Old flat events can be emitted alongside items during a transition period, controlled by client capability negotiation.

#### 2. Structured Error Taxonomy

**What**: Replace `{ type: "error", message: string }` with typed error codes.

**Why**: Clients need to distinguish "context window exceeded" from "auth failed" from "runtime crashed" to show appropriate UX.

**Proposed codes**:
```
auth_failed
session_not_found
session_closed
runtime_unavailable
runtime_crashed
runtime_timeout
context_exceeded
rate_limited
policy_denied
invalid_request
internal_error
```

**Protocol shape**:
```
{ type: "error", sessionId, code: ErrorCode, message: string, details?: unknown }
```

#### 3. Capability Negotiation

**What**: Client declares capabilities in its first message (or during WS upgrade). Server adjusts event stream accordingly.

**Why**:
- Enables protocol evolution without breaking old clients.
- Clients can opt into item-typed events vs legacy flat events.
- Channels (Telegram, Discord) can declare their rendering capabilities.

**Proposed shape** (on `session_new` or a new `hello` message):
```
capabilities: {
  itemEvents?: boolean       // opt into item lifecycle events
  thinkingDeltas?: boolean   // opt into thinking/reasoning stream
  imageSupport?: boolean     // can render inline images
  approvalUx?: "full" | "binary"  // rich options vs simple allow/deny
}
```

### Tier 2 — Medium Value, Enables Interactive UX

#### 4. Turn Steering, Fork, and Rollback

These three form a coherent "interactive control" group — they give users the ability to course-correct, branch, and undo agent work. Together they make Nexus sessions feel like a workspace, not just a chat log.

##### 4a. Turn Steering

**What**: Allow client to append input to an in-flight turn without starting a new turn.

**Why**: Lets users course-correct the agent mid-execution ("actually, focus on the failing tests") without cancelling and re-prompting. Especially valuable in channel contexts where cancel + re-prompt is clunky.

**Protocol**: New `prompt_steer` client message:
```
{ type: "prompt_steer", sessionId, text, expectedTurnId? }
```

Gateway forwards as additional content to the ACP session. Requires ACP runtime support (Claude Agent SDK's `Pushable` input already supports this pattern).

##### 4b. Session Fork

**What**: Branch an existing session into a new one, copying conversation history up to the fork point.

**Why**:
- "Try a different approach" UX — user forks before a risky operation, keeps the original as a safe checkpoint.
- Exploration without commitment — fork, experiment, discard or keep.
- Natural fit with Nexus's multi-session model — forking is just creating a new session with seeded context.

**Protocol**: New `session_fork` client message:
```
{ type: "session_fork", sessionId, atTurnId?: string, runtimeId?: string, model?: string }
```
- `sessionId`: source session to fork from.
- `atTurnId`: optional — fork from this turn (default: latest). Enables "fork from 3 turns ago."
- `runtimeId`/`model`: optional overrides for the new session (fork to a different runtime/model).

Gateway response: `session_created` event for the new session, with a `forkedFrom` field:
```
{ type: "session_created", sessionId: "new-id", forkedFrom: { sessionId, atTurnId }, ... }
```

**Implementation considerations**:
- Requires the ACP runtime to support session creation with pre-seeded transcript. The Zed claude-agent-acp adapter's `session/new` could potentially accept initial context, or we use `session/fork` if the runtime supports it natively.
- If the runtime doesn't support native fork, gateway can synthesize it: create new ACP session, replay transcript as context injection.
- Fork metadata stored in SessionRecord for lineage tracking.

##### 4c. Turn Rollback

**What**: Drop the last N turns from a session's context, effectively "undoing" agent work.

**Why**:
- Agent went down a bad path — user wants to rewind and try again.
- Combined with fork: fork first (checkpoint), then rollback the original.
- Reduces wasted tokens on dead-end explorations.

**Protocol**: New `session_rollback` client message:
```
{ type: "session_rollback", sessionId, turns: number }
```

Gateway response: `session_rolled_back` event:
```
{ type: "session_rolled_back", sessionId, turnsDropped: number, remainingTurns: number }
```

**Implementation considerations**:
- Requires ACP runtime support. Codex has `thread/rollback` which drops turns and persists a marker.
- If runtime doesn't support native rollback, gateway can synthesize: close ACP session, create new one, replay transcript minus last N turns.
- Rollback events should be recorded in session lifecycle audit trail.
- Consider: should rollback also revert file changes? Probably not — that's git's job. Rollback is context-only.

#### 5. Approval Escalation (`acceptForSession`)

**What**: When approving a tool, offer "allow for this session" in addition to one-time allow.

**Why**: Reduces approval fatigue for repetitive operations (e.g., multiple file writes to the same directory).

**Implementation**: Already partially supported via `AcpPermissionOption.kind` (`allow_always`). The gap is surfacing session-scoped policy amendments in the gateway policy engine — a temporary rule added for the session's lifetime.

#### 6. Token Usage Streaming

**What**: Emit `token_usage_updated` events during/after turns.

**Why**: Clients can show live cost indicators. Budget alerts become possible.

**Protocol**:
```
{ type: "token_usage_updated", sessionId, input: number, output: number, total: number, costEstimate?: number }
```

#### 7. Context Compaction Trigger

**What**: Client or gateway can trigger context compaction for a session.

**Why**: Long sessions hit context limits. Proactive compaction extends session lifetime.

**Protocol**: New client message `session_compact` → gateway forwards to runtime → emits `session_compacted` event with before/after token counts.

**Dependency**: Requires ACP runtime support for compaction.

### Tier 3 — Defer

#### 8. Sandbox Policy Object

First-class sandbox scope on session creation. Currently handled by policy rules file. Could be useful when channels have different trust levels — e.g., Telegram sessions get `readOnly` sandbox by default, TUI sessions get `workspaceWrite`.

---

## What Nexus Should NOT Adopt

1. **Review mode** — Git-specific, not runtime-agnostic.
2. **Skills/apps discovery protocol** — Nexus uses MCP for tool extensibility; skills are a Codex-specific abstraction.
3. **Collaboration modes** — Nexus has its own agent orchestration roadmap.
4. **Config management via protocol** — Nexus uses file-based config with hot-reload plan; no need for wire protocol config writes.
5. **Windows sandbox setup** — Platform-specific.
6. **Thread archival** — Nexus sessions are lightweight; archival is a storage concern, not a protocol concern.
7. **Dynamic tool calls** — Experimental in Codex; Nexus uses MCP for client-side tools.

---

## Where Nexus Is Already Ahead

Worth noting — these are areas where Nexus's protocol is more mature than Codex's:

1. **Principal-proof identity**: Ed25519 challenge-response auth with device keypairs. Codex has `clientInfo` but no cryptographic identity.
2. **Session transfer**: Explicit request/accept/dismiss flow with policy. Codex has no equivalent.
3. **Session lifecycle state machine**: `live` → `parked` → `closed` with typed reasons and event audit trail. Codex has simpler `notLoaded`/`idle`/`active` status.
4. **Execution correlation**: `executionId`, `turnId`, `policySnapshotId` on every event. Codex has `turnId` but not execution/policy correlation.
5. **Policy engine**: First-match-wins rule evaluation with audit. Codex has approval policies but no pluggable policy engine.
6. **Runtime registry**: Multi-runtime with model routing and health. Codex is single-runtime.
7. **Memory provider**: Session + workspace scoped memory with tiered context. Codex has no memory abstraction.

---

## Adoption Sequence

Recommended order, aligned with existing roadmap milestones:

### Phase A — Protocol Evolution (fits M0.5 substrate work)

1. **Structured error codes** — smallest change, highest immediate value.
2. **Capability negotiation** — enables everything else without breaking existing clients.
3. **Token usage streaming** — low effort, visible user value.

### Phase B — Item Model (new milestone, between M0.5 and M1)

4. **Item-typed work units** — the biggest protocol change. Design carefully.
   - Start with `agent_message` + `tool_call` item types.
   - Add `thinking` and `approval_gate` items next.
   - Keep legacy flat events behind capability flag during transition.

### Phase C — Interactive Controls (fits M2 channel work)

5. **Turn steering** — course-correct agents mid-flight.
6. **Session fork** — branch sessions for safe exploration.
7. **Turn rollback** — undo bad agent turns without losing the session.
8. **Approval escalation** — reduces friction for channel users.
9. **Context compaction trigger** — important for long channel sessions.

These three (steer/fork/rollback) form a coherent "workspace control" group and should ship together. They transform sessions from disposable chat logs into durable, navigable workspaces.

### Phase D — Advanced (M3+)

10. Sandbox policy objects per session/channel.

---

## Open Questions

1. **Client↔Gateway JSON-RPC?** Codex uses JSON-RPC for everything. Nexus uses plain typed JSON for client↔gateway. Should we migrate? Pros: uniform tooling, built-in request/response correlation. Cons: more ceremony for simple fire-and-forget events.

2. **Item ID generation**: Gateway-assigned or runtime-assigned? If items map to ACP tool calls, the runtime already has IDs (`toolCallId`). Gateway could wrap with its own stable IDs.

3. **Backward compatibility window**: How long do we support flat events alongside item events? Recommendation: until all known clients (TUI, web, CLI, channels) are migrated.

4. **ACP protocol changes**: Item model and turn steering require the ACP bridge to expose richer event streams. The current `session/update` notification types (`agent_message_chunk`, `tool_call`, `tool_call_update`) already map reasonably well to items. Main gap: no item lifecycle signals from ACP — gateway would synthesize `item_started`/`item_completed` from the stream.

---

## Next Steps

1. Review this analysis and confirm priorities.
2. Design the item event schema in `@nexus/types` (TDD — types + guards first).
3. Add error taxonomy to `@nexus/types`.
4. Add capability negotiation to session creation flow.
5. Implement in gateway router, with tests.
