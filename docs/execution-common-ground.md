# Nexus Execution Common Ground

## Purpose

Define a single, shared execution model for:

1. Interactive user sessions
2. Agent/subagent delegation
3. Time-bound deterministic pipelines
4. Externally triggered automation via secure hooks

The goal is Linux-like consistency: different callers, one core execution substrate.

## Problem Statement

Today, Nexus is session-centric for interactive use. Future capabilities (scheduler, hooks, orchestration) require a first-class execution model that:

1. Unifies identity, permissions, policy, and observability
2. Supports deterministic automation and replay
3. Preserves strong security boundaries under delegation

## Core Model

### 1) Principal

The actor that starts work:

1. `user` (interactive human)
2. `service_account` (trusted process or integration)

Every run is attributable to one principal.

### 2) Execution (Primary Runtime Primitive)

A single run, independent of how it was triggered.

Suggested fields:

1. `executionId`
2. `parentExecutionId` (for subexecution trees/DAGs)
3. `source`: `interactive | schedule | hook | api`
4. `principalId`
5. `workspaceId`
6. `runtimeId`
7. `model`
8. `policySnapshotId`
9. `capabilityTokenId`
10. `deadline`
11. `budget`
12. `state`: `queued | running | succeeded | failed | cancelled | timed_out`

### 3) Session (Projection Layer)

A session is an interaction/view layer over one or more executions, not the security boundary itself.

## Agent/Subagent Architecture

## Delegation Contract

When a parent execution spawns a child, it must provide:

1. Brief/objective
2. Expected output schema
3. Workspace scope
4. Memory scope
5. Capability token (tools/fs/network/budget/time)
6. Escalation policy

## Permission Rule

Child permissions are attenuated:

`child_effective = parent_effective ∩ delegated_scope ∩ policy_overlays`

No child can gain capabilities the parent did not have.

## Communication Topology

Default: hub-and-spoke via orchestrator/gateway.

1. Parent <-> child via typed envelopes
2. Child-to-child direct channels off by default
3. Parent performs fan-in/coalescing

Message classes:

1. `brief`
2. `progress`
3. `artifact`
4. `escalation`
5. `done`

## Deterministic Pipeline Model

## Step Contract

Each step should be pinned and typed:

1. Typed input/output schema
2. Pinned runtime/model/tool profile
3. Pinned policy snapshot
4. Explicit timeout and budget

## Determinism Requirements

1. Idempotency key per run/request
2. Deterministic state transitions
3. Reproducible execution policy

For non-deterministic operations (network/time/external APIs):

1. Disallow in strict deterministic mode, or
2. Record/replay external tool responses

## External Secure Hooks

Hook triggers should create executions as a `service_account` under strict templates.

Required controls:

1. Trigger template binding (no arbitrary prompt surface)
2. Payload schema validation
3. Scoped capability token
4. Workspace/runtime allowlist
5. HMAC signature + timestamp + nonce (replay protection)
6. Rate limit + quota
7. Credential rotation support

## Security Model

## Capability Layers

Effective permissions for any execution are the intersection of:

1. Principal scope
2. Policy snapshot
3. Runtime profile restrictions
4. Execution capability token

## Escalation

High-risk actions route to approval/escalation logic at the appropriate parent/root boundary. Subexecutions cannot self-escalate silently.

## Observability and Audit

All events should carry causal IDs:

1. `executionId`
2. `parentExecutionId`
3. `sessionId` (if interactive)
4. `principalId`
5. `triggerId` (schedule/hook)
6. `policyDecisionId`
7. `toolCallId`
8. `approvalRequestId`

Outcome requirement:

Operators can answer: who triggered what, why it was allowed/denied, and what side effects occurred.

## Current Nexus Status vs Target

Aligned today:

1. Policy-mediated tool approvals
2. Runtime registry and per-session runtime/model selection
3. Workspace-aware session setup
4. Memory scoping concepts
5. Session audit/event plumbing

Not yet first-class:

1. Unified `Execution` primitive
2. Principal model (`user` vs `service_account`)
3. Policy/capability snapshotting per execution
4. Native parent/child execution graph protocol
5. Scheduler and deterministic pipeline engine
6. External secure hook ingress
7. Full DAG-level observability

## Recommended Implementation Order

1. Introduce `Execution` + `Principal` core types and persistence
2. Add capability tokens + policy snapshot binding at execution start
3. Add execution graph semantics (spawn/observe/cancel + fan-in)
4. Add scheduler/pipeline engine with deterministic step contracts
5. Add secure hook ingress based on `service_account` principals
6. Expand observability/admin surfaces to execution graph level

## Design Principle

Nexus should expose one execution kernel with multiple trigger front-ends. Interactive chat, scheduled jobs, and webhook automation become different entry points into the same deterministic, policy-governed system.
