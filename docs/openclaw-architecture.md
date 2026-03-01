# OpenClaw Architecture Decomposition & Critique

## 1. High-Level Architecture: What It Is

OpenClaw is a **single-process, local-first AI agent gateway** written in TypeScript/Node.js. The mental model:

```
┌─────────────────────────────────────────────────────────┐
│                    Gateway (port 18789)                  │
│                  Single Node.js Process                  │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐│
│  │ Channels │  │ Sessions  │  │   Agent Runtime        ││
│  │ (adapters│  │ (JSONL    │  │   (pi-mono fork)       ││
│  │  per     │  │  on disk) │  │                        ││
│  │  platform│  │           │  │  ┌──────┐ ┌─────────┐ ││
│  │  )       │  │           │  │  │Tools │ │ Skills  │ ││
│  │          │  │           │  │  │Policy│ │ (MD     │ ││
│  │          │  │           │  │  │Chain │ │  inject)│ ││
│  └────┬─────┘  └─────┬────┘  │  └──────┘ └─────────┘ ││
│       │              │       └────────────────────────┘│
│       │              │                                  │
│  ┌────┴──────────────┴──────────────────────────────┐  │
│  │           WebSocket Control Plane                 │  │
│  │     (operators, nodes, webchat, canvas)           │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │           Config + State (disk)                   │  │
│  │  openclaw.json | sessions.json | auth-profiles    │  │
│  │  transcripts (.jsonl) | credentials/ | memory/    │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │              │                │
    ┌────┴────┐   ┌─────┴─────┐   ┌─────┴─────┐
    │ WhatsApp│   │  Telegram │   │  Discord  │ ...
    │ Signal  │   │  Slack    │   │  iMessage │
    └─────────┘   └───────────┘   └───────────┘
```

### The Three Layers

1. **Gateway** — WebSocket server, session management, message dispatch, config hot-reload
2. **Channel Adapters** — Platform-specific normalization (WhatsApp, Telegram, Discord, etc.)
3. **Agent Runtime** — LLM loop derived from pi-mono: prompt assembly → model call → tool execution → streaming

---

## 2. Component Decomposition

### 2.1 Gateway (`src/gateway/`)

**What it does:** Single WebSocket server on port 18789. Multiplexes operator clients (CLI, TUI, Control UI), node clients (macOS/iOS/Android devices), webchat clients, and channel webhooks. All RPC is JSON frames with a `type` field, validated via TypeBox schemas.

**Key files:**
- `server.impl.ts` — `startGatewayServer()`, main entry
- `server-methods.ts` — RPC handler dispatch, organized by domain (`{domain}.{action}`)
- `method-scopes.ts` — Authorization scope checks per method

**Critique:**

- **God process.** Everything lives in one Node.js process. This is fine for a personal assistant on a Mac Mini, but it means a crash in any subsystem (e.g., a channel adapter OOMing on a large media file) takes down the entire gateway. There's no process isolation, no supervisor tree, no graceful degradation.

- **No separation between control plane and data plane.** The same WebSocket server handles both admin operations (config changes, security audits) and high-throughput message routing. In any serious deployment, these should be separate processes or at minimum separate listener endpoints with different auth requirements.

- **Auth is opt-in, not opt-out.** Authentication is disabled by default. The gateway trusts localhost connections implicitly. Combined with mDNS broadcasting config parameters, this is an invitation to lateral movement on any shared network. The standard approach: auth should be mandatory, with an explicit `--no-auth` flag for development.

- **No structured event bus.** Internal communication between subsystems (channels → gateway → agent runtime) is direct function calls. There's no event bus, no message queue, no ability to replay events or add observability. Adding a lightweight pub/sub layer (even just EventEmitter with typed events) would make the system much more extensible and testable.

### 2.2 Channel Adapters (`src/channels/`)

**What they do:** Each platform gets an adapter that normalizes inbound messages into an internal format and translates outbound responses back to platform-specific payloads. Adding a new channel means implementing one adapter.

**Critique:**

- **Good: Clean adapter pattern.** This is the best-designed part of OpenClaw. The channel-agnostic internal message format means the agent never knows which platform it's talking to. This is textbook hexagonal architecture.

- **Bad: No SDK/contract enforcement.** There's a "Plugin SDK" but no formal interface contract that's enforced at compile time. A channel plugin can register arbitrary tools via `listChannelAgentTools`, and there's no sandbox or capability restriction on what a channel plugin can do. Compare to how VS Code extensions declare capabilities in their manifest — OpenClaw plugins get implicit full trust.

- **Bad: Webhook auth is per-channel and inconsistent.** The Twilio webhook auth bypass (GHSA-c37p-4qqg-3p76) illustrates this — each channel implements its own webhook verification, and there's no shared middleware that enforces signature validation. This should be a gateway-level concern with a standard `verifyWebhook(req, channelConfig)` interface.

### 2.3 Agent Runtime (`src/agents/`)

**What it does:** Derived from `@mariozechner/pi-coding-agent` (pi-mono). The execution pipeline:

1. Resolve model + auth profile
2. Initialize or resume session
3. Assemble system prompt (IDENTITY.md + SOUL.md + injected skills + memory)
4. Enter tool loop: model call → tool execution → feed results back → repeat
5. Stream response to channel adapter
6. Persist transcript to JSONL
7. Memory flush / compaction

All paths converge on `runEmbeddedPiAgent()`.

**Critique:**

- **Tight coupling to pi-mono.** The runtime is a fork, not an integration. OpenClaw "replaces several [tools] in-place during assembly" from the upstream codingTools set. This makes upstream updates painful and creates an ever-widening delta. A cleaner approach: define an `AgentRuntime` interface, implement pi-mono as one provider, and make the tool registry a composition layer rather than monkey-patching.

- **System prompt assembly is fragile.** The prompt is assembled by concatenating markdown files (IDENTITY.md, SOUL.md, TOOLS.md, active skills, memory) with no token budgeting at assembly time. The context window guard only checks *after* assembly. This means on a constrained model (say, 32K context), a large memory file + multiple skills can silently blow past the limit before the guard fires. The assembly should be token-budget-aware from the start, with prioritized truncation.

- **Skill injection is all-or-nothing per turn.** The docs claim "selectively injects only the skill(s) relevant to the current turn," but the selection logic is essentially keyword matching against the user's message. There's no semantic routing, no learned relevance model, no feedback loop. For a system with potentially hundreds of skills, this becomes a prompt-stuffing problem. Compare to how MCP servers declare tool schemas — the model itself should choose which tools to invoke, not a keyword heuristic.

- **No structured output support.** The agent runtime doesn't support constrained decoding / structured outputs. Everything is free-text generation with tool calls. For many automation use cases (filling forms, generating structured data, API calls), this is wasteful and error-prone. The runtime should support JSON schema-constrained outputs natively.

### 2.4 Tool System (`src/agents/openclaw-tools.ts`, `src/agents/pi-tools.ts`)

**What it does:** Tools come from two origins: upstream pi-coding-agent tools (filesystem, exec, shell) and OpenClaw-native tools (sessions, memory, browser, cron, canvas, nodes, webhooks, image, TTS). Policy enforcement via a five-level chain: global → provider → agent → session → sandbox.

**Critique:**

- **Good: The policy pipeline.** Five cascading levels of allow/deny with deny-takes-precedence is a solid design. Tool groups (`group:runtime`, `group:fs`) allow coarse-grained control. This is one of the more thoughtful security designs in the codebase.

- **Bad: Tools inherit the process's credentials.** When a tool calls `exec`, it runs with the full permissions of the Node.js process. The Docker sandbox is opt-in and was itself vulnerable (CVE-2026-24763). The standard approach in 2026: tools should run in capability-constrained containers by default, with explicit permission escalation. Think Deno's permission model, not Node's ambient authority.

- **Bad: No tool attestation.** Skills from ClawHub are installed and run without cryptographic verification. The 12-20% malicious skill rate in ClawHub is a direct consequence. Skills should be signed, and the gateway should verify signatures before loading. Even npm has provenance attestations now.

- **Bad: Loop detection is reactive, not structural.** The `tools.loopDetection` config catches repeated tool calls after the fact. A better approach: model the tool execution as a state machine with explicit transition limits and cost budgets. If a tool loop would exceed $X in API costs or N minutes of execution, halt proactively.

### 2.5 Session Management (`src/config/sessions.ts`)

**What it does:** Sessions are keyed by `{type}:{channelPeer}:{agentId}`. State persisted in `sessions.json` (metadata) and JSONL transcript files. Daily reset at 4 AM, idle expiry, per-channel/per-type overrides. Compaction trims old tool results before LLM calls.

**Critique:**

- **JSONL on disk is fine for personal use, fragile at scale.** No WAL, no crash recovery, no concurrent write protection. If the process crashes mid-write, the JSONL file can be corrupted. At minimum, use atomic writes (write to temp file, fsync, rename). Better: use SQLite with WAL mode — it's a single file, crash-safe, and queryable.

- **Compaction is too simple.** The current approach replaces old tool outputs with `[TOOL OUTPUT PRUNED]`. This loses potentially important context. A better approach: use the model itself to generate structured summaries of pruned segments (which OpenClaw already does for memory flushes, but not for general compaction). Even better: implement a tiered memory system — hot (full context), warm (summaries), cold (searchable embeddings).

- **No cross-session intelligence.** Each session is isolated. If I discuss a topic in my Telegram DM, that context doesn't inform my WhatsApp session with the same agent. Memory files are the workaround, but they're unstructured markdown dumped into the system prompt. A proper knowledge graph or structured memory store would enable much richer cross-session reasoning.

### 2.6 Security Architecture

**What exists:** DM pairing codes, allowlists, `openclaw security audit`, Docker sandbox, tool policy chains, credential storage under `~/.openclaw/credentials/`.

**What's wrong — fundamentally:**

- **The trust model is inverted.** OpenClaw treats the *gateway host* as the trust boundary, but the actual threats come from *content* flowing through the gateway (messages, emails, web pages, skills). Every inbound message is a potential prompt injection vector, and the architecture has no deterministic content validation layer. The LLM is both the executor and the validator — this is the "confused deputy" problem.

- **Credentials in plaintext on disk.** API keys, OAuth tokens, and passwords are stored in plaintext files. RedLine and Lumma stealers have already added OpenClaw file paths to their collection targets. Standard: use OS keychain (macOS Keychain, libsecret on Linux) or at minimum encrypted-at-rest with a master key derived from the user's password.

- **No principle of least privilege for the runtime itself.** The Node.js process runs with the user's full permissions. It can read `~/.ssh/`, access browser cookies, enumerate the filesystem. On macOS, it requests Full Disk Access. The standard approach: run the gateway under a dedicated service account with minimal filesystem access, and use capability-based delegation for privileged operations.

- **MCP integration is a gap.** The ACP bridge explicitly disables MCP capabilities. MCP tools go through a subprocess workaround (`mcporter` skill). In a world where MCP is becoming the standard for tool integration, this is a significant architectural gap. The tool system should natively speak MCP, with the gateway acting as an MCP host that brokers connections to MCP servers.

---

## 3. What Should Be Done Differently

### 3.1 Process Architecture: Supervisor Tree

Replace the monolith with a supervised process tree:

```
openclaw-supervisor
├── gateway-core         (control plane, WS, config)
├── agent-worker-pool    (N workers, one per active session)
├── channel-manager      (channel adapter lifecycle)
├── tool-sandbox-pool    (pre-warmed containers)
└── memory-service       (structured store, embeddings)
```

Each component restarts independently. The supervisor maintains health. This is the Erlang/OTP pattern, and it's directly applicable here. In Node.js, use `child_process.fork()` with IPC, or better yet, move to Deno with its built-in permission model.

### 3.2 Security: Capability-Based Architecture

Instead of ambient authority (the process can do anything), adopt a capability model:

- **Tools declare required capabilities** in their manifest (network, filesystem:read, filesystem:write, exec, keychain)
- **The gateway grants capabilities per-session** based on policy
- **Capabilities are revocable tokens**, not ambient permissions
- **Content is validated deterministically** before reaching the LLM — a "circuit breaker" layer that checks outbound network calls, file writes, and credential access against a policy, independent of the LLM's judgment

### 3.3 State: SQLite + Structured Memory

Replace JSONL + JSON files with:

- **SQLite with WAL** for session metadata and transcripts (crash-safe, queryable, single-file)
- **Structured memory store** with typed facts, not markdown blobs (e.g., `{entity: "Leo", relation: "works_at", value: "apelogic.ai", confidence: 0.95, source: "session:abc123"}`)
- **Vector embeddings** for semantic memory search (SQLite with `sqlite-vec` or similar)
- **Cross-session knowledge graph** that the agent can query explicitly rather than having memory dumped into every system prompt

### 3.4 Tool System: Native MCP Host

The gateway should be an MCP host:

- **Internal tools** are MCP servers running in-process or as sidecars
- **External tools** connect via MCP's standard transport (stdio, SSE, streamable HTTP)
- **Skill installation** = registering an MCP server, with manifest-declared capabilities
- **Tool attestation** via signed manifests (similar to npm provenance)
- **Budget enforcement** — each MCP tool call is metered and the session has a cost/time budget

### 3.5 Agent Runtime: Pluggable, Not Forked

Define a clean `AgentRuntime` interface:

```typescript
interface AgentRuntime {
  createSession(config: SessionConfig): Session;
  run(session: Session, message: Message, tools: ToolRegistry): AsyncIterable<StreamEvent>;
  compact(session: Session): Promise<CompactionResult>;
}
```

Pi-mono becomes one implementation. Claude Code's runtime could be another. Local models via Ollama could be a third. The gateway orchestrates — it doesn't need to know the internals of how inference happens.

### 3.6 Skill System: Sandboxed by Default

- Skills run in **Wasm sandboxes** (Extism, Wasmtime) or **container sandboxes** by default
- Skills declare capabilities in a **manifest** (network hosts, filesystem paths, env vars)
- ClawHub requires **signed builds** with reproducible build attestations
- The gateway performs **static analysis** on skill code before installation (the Cisco "Skill Scanner" approach, but built-in)
- **Skill review** — community-driven or automated — gates promotion from "experimental" to "verified"

---

## 4. What OpenClaw Gets Right

To be fair, several design decisions are genuinely good:

1. **Local-first philosophy.** Your data stays on your machine. The gateway is the trust boundary, not a cloud service. This is the right default for a personal assistant.

2. **Channel adapter pattern.** Clean separation between platform-specific concerns and agent logic. Adding a new channel is genuinely easy.

3. **Tool policy pipeline.** Five cascading levels with deny-takes-precedence is well-thought-out. The `group:` abstraction for bulk tool management is useful.

4. **Session key design.** The `{type}:{peer}:{agent}` key format with per-type and per-channel reset policies is flexible and covers real-world use cases well.

5. **ACP support.** Being an early ACP adopter means OpenClaw works natively in Zed and JetBrains IDEs. The bridge design is clean.

6. **Hot-reload config.** Watching `openclaw.json` for changes and applying them without restart is a good operational pattern.

7. **Steering while streaming.** The ability to inject new messages mid-execution and redirect the agent is a genuinely novel UX pattern that most chat systems don't support.

---

## 5. Summary Scorecard

| Dimension | Current State | Target State |
|-----------|--------------|-------------|
| **Process isolation** | Single monolith | Supervised process tree |
| **Auth default** | Disabled | Mandatory, explicit opt-out |
| **Credential storage** | Plaintext files | OS keychain / encrypted-at-rest |
| **Tool sandboxing** | Opt-in Docker | Default Wasm/container sandbox |
| **Skill verification** | None | Signed manifests + static analysis |
| **Session storage** | JSONL on disk | SQLite WAL |
| **Memory model** | Markdown in system prompt | Structured knowledge graph + embeddings |
| **MCP integration** | Disabled in ACP bridge | Native MCP host |
| **Content validation** | LLM-only (confused deputy) | Deterministic circuit breaker layer |
| **Agent runtime** | Forked pi-mono | Pluggable interface |
| **Observability** | Logs + `/status` | Structured events + OpenTelemetry |
| **Prompt assembly** | Concatenate then check | Token-budget-aware from start |

---

*Analysis based on OpenClaw codebase as of February 28, 2026 (commit 8090cb), plus security research from Cisco Talos, Giskard, Kaspersky, Microsoft Defender, Endor Labs, and Bitsight.*
