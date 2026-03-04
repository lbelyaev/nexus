# Nexus Domain Model (Identity, Workspace, Session)

This document captures the working entity model discussed during implementation.

## Core entities

1. User (person)
- A physical human identity.
- May hold memberships across multiple org/project boundaries.

2. Membership (role in org/project)
- User's role within a boundary (for example: owner, maintainer, operator).
- Future policy/auth should bind permissions to membership, not only raw user id.

3. Principal (authenticated actor)
- Identity presented on a concrete connection/client.
- Current protocol: `principalType` + `principalId` (for example: `user:telegram-main:139038976`).
- Backed by proof flows (nonce + signature) for stronger attribution.

4. Device / Client
- Concrete endpoint that acts as a principal: web UI, TUI, CLI, Telegram, Discord.
- A user can have many devices/clients.

5. Workspace
- Primary trust + context boundary.
- Sessions run inside a workspace.
- Workspace is expected to scope:
  - memory corpus
  - policy overlays
  - runtime/model allow-lists
  - secret/material access
  - budgets and audit views
  - channel mappings

6. Session
- Conversational execution context under one workspace.
- Bound to runtime/model selection and owned by a principal.
- Portable across clients via transfer/handoff, subject to policy checks.

7. Connection
- Transient transport instance (for example a WebSocket connection).
- Not identity by itself; identity is principal-level.

## Relationship summary

- User -> many Memberships
- User -> many Principals/Devices
- Workspace <- many Sessions
- Session -> one active owning Principal (transferable)
- Session <-> many Connections over time (reconnect/handoff)

## Practical interpretation of workspace

Treat workspace as the unit for "what context and permissions this session can use".

- If two sessions are in the same workspace, sharing memory/policy context is expected.
- If they are in different workspaces, isolation should be the default.
- Session transfer should typically stay in-workspace unless policy explicitly allows cross-workspace transitions.
