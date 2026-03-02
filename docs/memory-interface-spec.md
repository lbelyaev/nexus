# Nexus Memory Interface Spec (P1)

## Goal

Define a pluggable memory contract for Nexus that is:

1. Runtime-agnostic (Claude/Codex/etc.)
2. Storage-agnostic (SQLite now, replaceable later)
3. Context-budget-aware (hot/warm/cold tiers)

This spec maps directly to `@nexus/memory` and current gateway integration.

---

## Package

`@nexus/memory`

Core files:

1. `packages/memory/src/types.ts`
2. `packages/memory/src/provider.ts`
3. `packages/memory/src/index.ts`

---

## Core Interfaces

### MemoryProvider

```ts
interface MemoryProvider {
  id: string;
  recordTurn(input: MemoryTurnInput): void;
  search(input: MemorySearchInput): MemoryItem[];
  getContext(input: MemoryContextInput): MemoryContextOutput;
}
```

### Turn ingestion

```ts
interface MemoryTurnInput {
  sessionId: string;
  userText: string;
  assistantText?: string;
  timestamp?: string;
}
```

### Retrieval

```ts
interface MemorySearchInput {
  sessionId: string;
  query: string;
  limit?: number;
  kinds?: Array<"fact" | "summary">;
}
```

### Context assembly

```ts
interface MemoryContextInput {
  sessionId: string;
  prompt: string;
  budgetTokens?: number;
}

interface MemoryContextOutput {
  sessionId: string;
  budgetTokens: number;
  totalTokens: number;
  hot: TranscriptMessage[];
  warm: MemoryItem[];
  cold: MemoryItem[];
  rendered: string;
}
```

---

## Data Model

Shared memory types live in `@nexus/types` (`packages/types/src/memory.ts`):

1. `TranscriptMessage`
2. `MemoryItem` (`kind: "fact" | "summary"`)
3. Runtime guards:
   - `isTranscriptMessage`
   - `isMemoryItem`

SQLite schema (in `@nexus/state` migration):

1. `transcript_messages` (raw conversation/tool stream)
2. `memory_items` (derived `fact`/`summary` records)

---

## Default Provider (SQLite)

Factory:

```ts
createSqliteMemoryProvider(stateStore, config?)
```

Config:

```ts
interface SqliteMemoryProviderConfig {
  contextBudgetTokens?: number;   // default 1200
  hotMessageCount?: number;       // default 8
  warmSummaryCount?: number;      // default 4
  coldFactCount?: number;         // default 8
  maxFactsPerTurn?: number;       // default 6
  maxFactLength?: number;         // default 240
  summaryWindowMessages?: number; // default 10
}
```

Behavior:

1. `recordTurn`:
   - extracts fact candidates from user + assistant text
   - stores fact memory items with confidence/keywords
   - stores deduped rolling summary from recent transcript
2. `search`:
   - lexical token search over content/keywords
   - ranks by keyword overlap + confidence + recency
   - touches selected records (`lastAccessedAt`)
3. `getContext`:
   - builds budgeted context from:
     - hot: recent transcript
     - warm: summaries
     - cold: query-relevant facts
   - returns a rendered context fragment for prompt injection

---

## Gateway Integration

Gateway creates a memory provider in startup:

1. `packages/gateway/src/start.ts`
2. passes provider into router deps

Router usage:

1. `getContext` before `session.prompt`
2. injects rendered context if non-empty
3. `recordTurn` after turn completion

Failure handling:

1. Memory errors are logged and do not fail the turn.
2. Prompt proceeds even if memory context generation fails.

---

## Config Surface

Gateway config supports:

```json
{
  "memory": {
    "enabled": true,
    "provider": "sqlite",
    "contextBudgetTokens": 1200,
    "hotMessageCount": 8,
    "warmSummaryCount": 4,
    "coldFactCount": 8,
    "maxFactsPerTurn": 6,
    "maxFactLength": 240,
    "summaryWindowMessages": 10
  }
}
```

Validation lives in `packages/gateway/src/config.ts`.

---

## Extensibility Contract

To add a new provider (vector DB, graph, remote service):

1. implement `MemoryProvider`
2. map provider to same `MemoryItem`/`MemoryContextOutput` shapes
3. preserve token budget semantics in `getContext`
4. keep router contract unchanged

This keeps memory pluggable without gateway protocol changes.
