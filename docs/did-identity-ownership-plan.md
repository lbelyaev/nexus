# DID-Based Identity And Session Ownership Plan

_2026-03-14_

## Summary

Nexus should stop treating channel-specific principals as the canonical user identity.

Today we mix two different concepts:

- **Canonical user identity**: who actually owns a session
- **Channel/account identity**: how that user authenticated from Web, Telegram, TUI, CLI, or another surface

Those are not the same thing.

Examples:

- `telegram:12345` is a Telegram account identifier
- `web:alice` is a Web-facing account identifier
- neither should be the true user identity on its own

The canonical owner should be a real DID:

- `did:key:...`
- `did:web:...`
- `did:pkh:...`

Channel principals should resolve to that DID through verified bindings.

That gives us the model we actually want:

- one user can own the same sessions across Web, Telegram, TUI, and CLI
- session ownership stays strict and enforceable
- attach/detach stays connection-based
- transfer is only needed when moving a session to a different user DID

## Problem

Current Nexus session ownership is principal-based:

- Web sessions are owned by a Web principal
- Telegram sessions are owned by a Telegram principal
- session list and attach authorization are scoped to that principal

This produces the current behavior:

- Web cannot see Telegram-owned sessions
- Telegram cannot see Web-owned sessions
- transfer is required even when both surfaces belong to the same human

That is correct under the present model, but the model is too narrow. It encodes transport/account identity as if it were the durable user identity.

## Design Principle

Use DID as the canonical identity layer, and treat channel-specific principals as authentication methods or bound external accounts.

The correct separation is:

- **`ownerDid`**: canonical session owner
- **`principal`**: authenticated channel/account identity
- **`binding`**: verified statement that a principal belongs to an `ownerDid`

Examples:

| Concept | Example |
|---|---|
| Canonical owner DID | `did:key:z6Mk...` |
| Web principal | `web:alice` |
| Telegram principal | `telegram:12345` |
| TUI/CLI principal | `cli:laptop-01` |

If `web:alice` and `telegram:12345` are both verified bindings for the same `ownerDid`, they should see the same sessions.

## Standards Alignment

This plan should follow existing DID and adjacent standards instead of inventing a Nexus-specific identity model.

### What we should use

1. **W3C DID Core**

Use a real DID method as the canonical user identifier and use DID verification methods for authentication and proof workflows.

Notes:

- `alsoKnownAs` is not strong enough to be our authorization model.
- `equivalentId` / `canonicalId` are not the right mechanism for channel-account linking.

### 2. **DID Configuration / Linked Domains**

For Web identity, use linked-domain style proofs where possible:

- a web origin can prove it is associated with a DID
- that is the right standard building block for Web ownership and recovery

### 3. **Verifiable Credentials / Verifiable Presentations**

For bindings like:

- "`telegram:12345` belongs to `did:key:...`"
- "`cli:laptop-01` is an authorized device for `did:key:...`"

use VC-style attestations or signed binding records, even if the first implementation is a Nexus-local simplified form.

Important: VC is not the authorization framework. It is the proof vehicle for the binding.

## What We Should Not Do

1. Do not invent fake DID syntax like `did:user:123`.

If we need a new DID method, that is a much larger standards and interoperability commitment. We do not need that to solve Nexus identity.

2. Do not use raw principals as session owners.

`user:web:...` and `user:telegram:...` are channel auth artifacts, not stable owner identifiers.

3. Do not make transfer the normal cross-surface move for the same person.

If both principals map to the same `ownerDid`, session attach should be enough.

## Target Identity Model

### Canonical user

```typescript
interface OwnerIdentity {
  did: string;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}
```

### External principal

```typescript
interface BoundPrincipal {
  principalType: "user" | "service_account";
  principalId: string;              // e.g. "telegram:12345", "web:alice"
  source: "web" | "telegram" | "tui" | "cli" | "api";
  ownerDid: string;
  bindingStatus: "pending" | "verified" | "revoked";
  verificationMethodId?: string;    // DID verification method used to prove linkage
  proofFormat?: "did-auth" | "vc" | "linked-domain" | "nexus-signed-binding";
  createdAt: string;
  updatedAt: string;
}
```

### Session ownership

```typescript
interface SessionOwner {
  sessionId: string;
  ownerDid: string;
  sourcePrincipalType?: "user" | "service_account";
  sourcePrincipalId?: string;
}
```

Rules:

- a session is owned by exactly one `ownerDid`
- many principals may resolve to that `ownerDid`
- attach is allowed when the authenticated principal resolves to the session `ownerDid`
- transfer changes `ownerDid`, not just the presenting principal

## Session Semantics Under DID Ownership

### Session list

`session_list` should return sessions owned by the caller's resolved `ownerDid`, not by the raw principal string.

Result:

- Web and Telegram show the same sessions if both principals bind to the same DID
- unrelated users still remain isolated

### Attach / Detach

Keep the tmux-style model already implemented:

- `ownerDid` controls who may attach
- newest attached connection becomes controller
- detach is connection-scoped, not ownership-scoped

This part of the system is already directionally correct. Only the identity root changes.

### Transfer

Transfer remains explicit, but the unit changes:

- current: principal -> principal
- target: `ownerDid -> ownerDid`

If Telegram and Web resolve to the same DID, no transfer is needed.

Transfer is only for:

- user A to user B
- org service account to user
- user to delegated service account

## Binding Flows

### Web binding

Preferred approach:

- use a DID-controlled keypair in the browser or the user's wallet
- if `did:web` is chosen, verify domain linkage using DID Configuration / linked domains
- store a verified `principal(web:...) -> ownerDid` binding after proof

### Telegram binding

This is not solved directly by DID Core, so Nexus needs an application binding flow.

Recommended shape:

1. User authenticates in Web as `ownerDid`
2. User initiates "link Telegram"
3. Nexus generates a short-lived challenge
4. User sends the challenge through Telegram to the Nexus bot
5. Telegram adapter proves control of `telegram:<account>`
6. Nexus records a verified binding from that Telegram principal to the same `ownerDid`

The proof record can later be upgraded to a VC-style artifact, but v1 can be a signed Nexus binding with clear provenance.

### TUI / CLI binding

Recommended shape:

- treat the local client as a device principal
- complete a browser or copied-code pairing flow against an already authenticated DID
- record `cli:<device-id> -> ownerDid`

## Storage Plan

Add canonical identity storage in `@nexus/state`.

### New tables

```sql
CREATE TABLE owner_identities (
  did TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE principal_bindings (
  principalType TEXT NOT NULL,
  principalId TEXT NOT NULL,
  source TEXT NOT NULL,
  ownerDid TEXT NOT NULL,
  bindingStatus TEXT NOT NULL,
  verificationMethodId TEXT,
  proofFormat TEXT,
  proofPayload TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (principalType, principalId),
  FOREIGN KEY (ownerDid) REFERENCES owner_identities(did)
);
```

### Session table changes

Sessions should gain:

```sql
ALTER TABLE sessions ADD COLUMN ownerDid TEXT;
ALTER TABLE sessions ADD COLUMN sourcePrincipalType TEXT;
ALTER TABLE sessions ADD COLUMN sourcePrincipalId TEXT;
```

`ownerDid` becomes the real authorization field.

`sourcePrincipal*` remains useful for audit and display.

## Protocol Changes

### Auth result

Auth should resolve to both:

- presented principal
- resolved owner DID

Add fields like:

```typescript
{
  type: "auth_result";
  ok: true;
  principalType: "user" | "service_account";
  principalId: string;
  ownerDid: string;
}
```

### Session events

Session-bearing events should include `ownerDid` where useful for debugging and audits, but the first implementation can keep that server-side.

### Identity / binding protocol

Add new protocol later, not in the same change as DID ownership cutover:

- `identity_status`
- `identity_link_begin`
- `identity_link_complete`
- `identity_bindings_list`
- `identity_binding_revoke`

Keep that out of the first migration if possible.

## Gateway Changes

### Principal resolution

Current gateway auth resolves:

- `principalType`
- `principalId`
- verified/unverified state

It should resolve:

```typescript
interface ResolvedConnectionIdentity {
  principalType: "user" | "service_account";
  principalId: string;
  ownerDid: string;
  verified: boolean;
  source: "web" | "telegram" | "tui" | "cli" | "api";
}
```

### Authorization checks

Replace:

- "does this principal own the session?"

With:

- "does this connection's resolved `ownerDid` own the session?"

Applies to:

- `session_list`
- `session_attach`
- `session_history`
- `session_lifecycle_query`
- `prompt`
- `cancel`
- `close`
- transfer request / accept / dismiss

### Transfer logic

Pending transfers should target:

- `targetOwnerDid`

not just `targetPrincipalId`.

The accepting principal succeeds if it resolves to the target DID.

## Client Changes

### Web

- replace browser-generated raw principal as the long-term owner identity
- support DID-backed identity and linked-domain proof
- session list and attach stay the same from the UI point of view
- add account-linking UI for Telegram / CLI / device principals

### Telegram

- keep Telegram account as the presented principal
- resolve that principal to an `ownerDid`
- once linked, session list/attach should naturally show the user's shared sessions

### TUI / CLI

- add pairing flow so the device principal resolves to a DID
- once paired, these clients join the same session namespace as Web

## Migration Plan

### Phase 0: Document and stabilize attach/detach

Done first:

- tmux-style attach/detach semantics
- controller connection separate from ownership

### Phase 1: Add owner DID storage alongside existing principal ownership

Do not cut over auth yet.

- add `ownerDid` columns and binding tables
- backfill existing sessions with synthetic owner DIDs if needed
- keep current `principalId` behavior as compatibility

### Phase 2: Resolve principals to owner DID in gateway auth

- add principal binding lookup
- include `ownerDid` in auth result
- log both principal and owner DID

### Phase 3: Switch session authorization to `ownerDid`

- `session_list`
- `session_attach`
- prompt/cancel/close checks
- transfer checks

At this point, Web and Telegram can share sessions if linked to the same DID.

### Phase 4: Add user-facing linking flows

- Web linked-domain / DID auth
- Telegram linking challenge
- TUI/CLI pairing

### Phase 5: Remove principal-owned session assumptions

After migration confidence:

- stop using raw principal as session owner
- keep raw principal only as auth context and audit metadata

## Risks

### 1. Correlation and privacy

A single DID across all surfaces makes cross-channel correlation easy.

That may be desirable for Nexus continuity, but we should explicitly choose it. Pairwise DIDs may be preferable later for privacy-sensitive deployments.

### 2. DID method choice

We should not block the whole design on one DID method.

Recommendation:

- start with `did:key` for local/developer simplicity
- support `did:web` for web-linked deployments
- leave room for wallet-backed methods later

### 3. Telegram proof model is application-specific

There is no turnkey DID Core primitive that says "Telegram account X belongs to DID Y".

We will still need a Nexus linking ceremony and binding record.

### 4. Migration complexity

We are changing the root of authorization. That must be staged carefully with dual-read / dual-write compatibility during rollout.

## Recommended First Implementation Slice

1. Add `ownerDid` and `principal_bindings` storage in `@nexus/state`
2. Introduce a gateway `ResolvedConnectionIdentity` that includes `ownerDid`
3. Continue emitting the current principal fields, but log owner DID internally
4. Switch `session_list` and `session_attach` authorization to DID-based ownership
5. Keep transfer principal-based temporarily only if needed for compatibility
6. Build Telegram/Web linking flow after DID-backed auth is proven stable

This gets the most important user-facing win first:

- one human sees the same session list across channels

without trying to solve every identity UX problem in the same patch.

## Working Summary

The right model is:

- **DID identifies the user**
- **principals identify channel-specific accounts or devices**
- **bindings prove which principals belong to which DID**
- **sessions are owned by DID**
- **connections attach/detach to sessions**
- **transfer is only for DID-to-DID ownership changes**

That gives Nexus a standards-aligned identity root while preserving the tmux-style session model already in progress.
