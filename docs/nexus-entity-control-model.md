# Nexus Entity Control Model

This note turns the "who defines, who holds, who enforces" discussion into a working Nexus model.

The main conclusion is simple:

- `User / Org` defines intent, scope, and policy.
- `Orchestrator` is the trust root inside Nexus.
- `Worker agents` are deliberately narrow and temporary.
- `Typed pipelines` are a separate deterministic trust tier.
- `MCP / tools` are the hard enforcement boundary for side effects.
- `LLM` consumes context and proposes actions, but should not own authority.

## Actors

| Actor | Role |
|---|---|
| User / Org | Source of identity, workspace scope, and policy intent |
| Orchestrator | Canonical session owner, capability attenuator, router, persistence gate |
| Worker Agent | Task-local agent with scoped capabilities |
| Typed Pipeline | Deterministic executor with typed inputs and outputs |
| MCP / Tool | Tool host or external system that verifies and executes operations |
| LLM | Stateless inference engine that produces candidate outputs |

## Canonical Control Table

Legend:

- `D` = defines
- `H` = holds
- `E` = enforces
- `C` = consumes
- `P` = presents
- `R` = reads/writes through another owner

| Entity | User / Org | Orchestrator | Worker Agent | Typed Pipeline | MCP / Tool | LLM |
|---|---|---|---|---|---|---|
| Identity | D, H | C | H, P |  | E |  |
| Workspace scope | D | H, E | C | C | C |  |
| Permissions / policy | D | H, E | H, C | E | E | C |
| Session state | H (user view) | D, H, E | H (local view) | C | C (request-local) | C |
| Memory | D | H, E | R, C | C (if explicitly provided) | H (if storage-backed) | C |
| Skills | D (allowed set) | D, H, E | C, invokes | H, E when encoded as deterministic skill | H, E for tool-backed skills | C |
| Tools | D (allowed domains) | D, H, E | C, P | C, P | H, E |  |
| Business context | D | H, E, injects | C | C | C | C |
| System prompt / instructions | Partial D | D, H | C |  |  | C |
| Guardrails | D | H, E | C | E | E | weak C |
| Output / side effects | receives | E, commits | proposes | produces deterministic result | executes side effect | proposes text |

## Practical Reading Of The Table

### 1. Orchestrator is the trust root

The orchestrator is the only Nexus component that should combine:

- canonical session ownership
- memory persistence decisions
- capability attenuation
- routing across worker agents and pipelines
- final validation before side effects or commits

If a worker can bypass the orchestrator for durable writes, policy will drift.

### 2. Worker agents should not have ambient authority

A worker agent should:

- receive only the workspace slice it needs
- hold only scoped capabilities
- treat memory as mediated, not owned
- propose writes rather than assume they are committed

This keeps multi-agent execution composable. A compromised or confused worker has a smaller blast radius.

### 3. Typed pipelines are not "just another agent"

Pipelines are a different trust tier:

- no prompt assembly
- no latent reasoning authority
- deterministic transforms
- structural enforcement through schema and types

They complement policy rather than replace it:

- policy answers "may this action happen?"
- types answer "is this payload valid to continue?"

### 4. MCP / tools are the hard boundary

Real enforcement happens where side effects happen.

Examples:

- repo access tool verifies repository capability
- database tool verifies connection scope
- deployment tool verifies environment permission

The orchestrator may decide, but the tool boundary must still reject invalid or over-scoped requests.

### 5. LLM is a consumer, not an owner

The LLM:

- consumes prompt-time context
- proposes plans, edits, or tool calls
- does not own state after the turn
- should not be treated as an enforcement mechanism

This is the main reason to keep policy, memory, and capabilities outside the model boundary.

## Lifecycle Table

| Entity | Source of truth | Typical lifetime | Notes |
|---|---|---|---|
| Identity | User / Org auth system | Long-lived | Stable across sessions and devices |
| Workspace scope | User / Org + Nexus config | Long-lived | Main trust and isolation boundary |
| Permissions / policy | User / Org policy + orchestrator attenuation | Long-lived with request-time derivation | Derived caps should be revocable and narrow |
| Session state | Orchestrator | Session-lived | User and workers each have partial views |
| Worker local state | Worker Agent | Task-lived | Should be discardable without correctness loss |
| Pipeline run state | Typed Pipeline | Request-lived | Prefer stateless execution |
| Memory | Orchestrator-managed store | Medium to long-lived | Shared only by explicit policy |
| Business context | Domain systems / orchestrator projections | Medium to long-lived | Should be injected selectively, not dumped wholesale |
| System prompt / instructions | Orchestrator + runtime conventions | Request or session-lived | Materialized view, not source of truth |
| Tool capabilities | Orchestrator-derived, tool-verified | Request or session-lived | Must be scoped to actor and workspace |
| LLM context window | Runtime only | Turn-lived | Lost unless externalized |

## Concrete Example: Repo A Read/Write, Repo B Read-Only

Assume the user is operating in workspace `acme`, with this declared policy:

- `repo-A`: read/write
- `repo-B`: read-only
- `repo-C`: no access

### 1. User / Org

Defines the desired access model:

| Repo | Allowed operations |
|---|---|
| `repo-A` | read, write |
| `repo-B` | read |
| `repo-C` | none |

### 2. Orchestrator

Transforms that policy into task-scoped grants.

Example:

- code-edit worker gets `repo-A:read`, `repo-A:write`, `repo-B:read`
- search/index pipeline gets `repo-A:read`, `repo-B:read`
- no actor receives any capability for `repo-C`

The orchestrator should also narrow by task. A docs-only worker may not need `repo-A:write` even if the user overall has it.

### 3. Worker Agent

The worker can:

- read `repo-A`
- write `repo-A`
- read `repo-B`
- not write `repo-B`
- not read or write `repo-C`

Critically, this is not advisory. The worker should hold only those actual capabilities.

### 4. Typed Pipeline

If the worker sends a write request into a deterministic edit pipeline, the pipeline can additionally enforce:

- target repo must be in allowed write scope
- target path must conform to schema/rules
- payload must match expected patch structure

This is structural enforcement, not full policy ownership.

### 5. MCP / Tool

The repo tool is the final hard check:

- `readFile(repo-B, path)` succeeds if the presented capability includes `repo-B:read`
- `writeFile(repo-B, path)` fails because no `repo-B:write` capability exists
- any operation on `repo-C` fails

### 6. LLM

The model may suggest:

- "I should edit `repo-B` to fix this"

But that suggestion is only a proposal. The action is blocked by the orchestrator/pipeline/tool chain.

## Design Rules For Nexus

1. Keep policy declaration outside workers.
2. Make the orchestrator the only capability attenuator inside Nexus.
3. Give workers scoped, revocable, non-ambient authority.
4. Treat typed pipelines as deterministic safety islands.
5. Require MCP / tools to verify capabilities independently.
6. Treat LLM output as untrusted until validated.
7. Keep memory persistence behind orchestrator control.
8. Model workspace as the primary isolation boundary.

## Open Questions

- Whether memory should ever be directly writable by workers, or only via orchestrator-reviewed intents.
- Whether typed pipelines can mint narrower derived capabilities for sub-steps, or should stay capability-blind.
- How session ownership and transfer work when one user spans multiple devices and principals.
- How much business context should be materialized into prompts versus exposed as tool-backed retrieval.

## Working Summary

Nexus should not model "the agent" as one thing.

The cleaner model is:

- `User / Org` sets policy and scope.
- `Orchestrator` owns coordination and trust.
- `Worker agents` reason locally with narrow capabilities.
- `Typed pipelines` enforce structure deterministically.
- `MCP / tools` enforce real-world access.
- `LLM` proposes, but does not own.

That decomposition is what makes multi-agent orchestration and deterministic pipelines additive instead of contradictory.
