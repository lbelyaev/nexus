# Pluggable Agent Runtime Architecture for OpenClaw

## The Core Question

Can the OpenClaw gateway treat its agent runtime as a swappable module — where pi-mono, Claude Code, Codex, Goose, Gemini CLI, or even a custom runtime are interchangeable backends behind a unified interface?

**Short answer: Yes, and ACP is the protocol that makes it possible. But the devil is in how you handle tool delegation, session ownership, and the approval UX.**

---

## 1. Current State: How the Three Runtimes Differ

### pi-mono (OpenClaw's current runtime)
- **Language:** TypeScript, runs in-process
- **Session model:** JSONL transcripts on disk, managed by Gateway
- **Tool model:** Tools are JS functions assembled at runtime, policy pipeline in-process
- **Streaming:** Internal event emitter, Gateway translates to WS frames
- **Compaction:** Simple pruning of old tool outputs + memory flush
- **Key trait:** The Gateway and the runtime are the *same process* — no serialization boundary

### Claude Code
- **Language:** TypeScript/Rust, runs as a separate process
- **Session model:** Native session persistence via Claude SDK, session ID per thread
- **Tool model:** Built-in tools (file read/write/edit, exec, browser) + MCP servers
- **Streaming:** ACP `session/update` notifications over stdio (NDJSON)
- **Compaction:** `/compact` slash command, agent-managed
- **Key trait:** The `claude-code-acp` bridge already exists — it translates ACP ↔ Claude SDK

### Codex CLI (OpenAI)
- **Language:** Rust, runs as a separate process ("App Server")
- **Session model:** Threads as durable containers with Item/Turn/Thread primitives, fork/resume
- **Tool model:** Built-in tools + MCP servers, sandbox modes (seatbelt/Landlock/bubblewrap)
- **Streaming:** App Server JSON-RPC protocol with lifecycle events (started → delta → completed)
- **Compaction:** `/compact` slash command
- **Key trait:** OpenAI explicitly designed the App Server as a reusable harness — and *rejected* MCP for the session layer because it couldn't express approval flows and streaming diffs

### Key Differences Summary

```
                    pi-mono          Claude Code        Codex
─────────────────────────────────────────────────────────────────
Process model       In-process       Subprocess         Subprocess
Protocol            Function calls   ACP over stdio     App Server JSON-RPC (+ ACP bridge)
Session ownership   Gateway owns     Agent owns         Agent owns
Tool registration   Gateway builds   Agent has built-in Agent has built-in
Tool execution      Gateway sandbox  Agent sandbox      Agent sandbox (seatbelt/Landlock)
Approval flow       Gateway policy   ACP permission     App Server approval request/response
MCP support         Via mcporter     Native             Native
Compaction          Gateway-driven   Agent-driven       Agent-driven
```

The fundamental tension: **pi-mono lets the Gateway own everything (sessions, tools, policy), while Claude Code and Codex own their own sessions, tools, and sandboxes.** A pluggable architecture must reconcile this.

---

## 2. The Pluggable Architecture

### 2.1 ACP as the Internal Abstraction

ACP is the natural interface. It already defines:
- `session/new`, `session/load`, `session/prompt`, `session/cancel`
- `session/update` for streaming events
- `session/setMode` for permission modes
- Slash commands (`/compact`, `/status`, `/init`)

The Gateway becomes an **ACP client** that speaks to pluggable **ACP agent servers**:

```
┌──────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                       │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────┐  │
│  │  Channels   │  │  Sessions   │  │  Agent Router     │  │
│  │  (adapters) │  │  (registry) │  │  (ACP client)     │  │
│  └──────┬─────┘  └──────┬─────┘  └─────────┬─────────┘  │
│         │               │                    │            │
│         └───────────────┴────────────────────┘            │
│                          │                                │
│              ┌───────────┴───────────┐                    │
│              │   ACP Multiplexer     │                    │
│              │   (session → agent)   │                    │
│              └───────────┬───────────┘                    │
└──────────────────────────┼───────────────────────────────┘
                           │ ACP over stdio / socket
              ┌────────────┼─────────────┐
              │            │             │
     ┌────────┴──┐  ┌─────┴────┐  ┌────┴────────┐
     │ pi-mono   │  │ Claude   │  │ Codex       │
     │ ACP       │  │ Code     │  │ App Server  │
     │ adapter   │  │ (native  │  │ (via codex- │
     │           │  │  ACP)    │  │  acp bridge)│
     └───────────┘  └──────────┘  └─────────────┘
```

### 2.2 What the Gateway Retains

Even with pluggable runtimes, the Gateway still owns:

1. **Channel routing** — Which messages go to which agent (unchanged)
2. **Session registry** — Maps session keys to agent runtime instances (new: includes runtime type)
3. **Identity & auth** — Gateway token/password, DM pairing, allowlists
4. **Observability** — Logging, metrics, cost tracking across all runtimes
5. **Policy overlay** — The Gateway can still enforce *additional* restrictions on top of what the agent runtime allows

What the Gateway **gives up**:

1. **Session transcript ownership** — Each runtime manages its own transcripts
2. **Tool assembly** — Each runtime brings its own tools
3. **System prompt construction** — Each runtime assembles its own context
4. **Compaction** — Each runtime manages its own context window

### 2.3 The Agent Runtime Interface

```typescript
// The Gateway speaks this to any agent runtime
interface AgentRuntimeConfig {
  id: string;                          // "pi-mono" | "claude-code" | "codex" | custom
  type: "in-process" | "subprocess" | "remote";
  command?: string[];                  // e.g. ["claude-code-acp"] or ["codex-acp"]
  env?: Record<string, string>;        // API keys, permission mode
  capabilities: RuntimeCapabilities;
}

interface RuntimeCapabilities {
  supportsAcp: boolean;
  supportsMcp: boolean;                // Can the runtime consume MCP servers?
  supportsApprovalFlow: boolean;       // Can approvals be delegated to Gateway?
  supportsToolInjection: boolean;      // Can the Gateway add tools?
  supportsSessionResume: boolean;      // Can sessions persist across restarts?
  supportsStreaming: boolean;
  supportsMultimodal: boolean;         // Images, audio, etc.
  supportsConcurrentInput: boolean;    // "Steer while streaming"
  maxContextTokens?: number;
}

// The ACP Multiplexer maintains this state
interface ManagedSession {
  sessionKey: string;                  // OpenClaw's key format
  runtimeId: string;                   // Which runtime owns this session
  acpSessionId: string;                // The runtime's internal session ID
  status: "active" | "idle" | "expired";
  createdAt: Date;
  lastActivityAt: Date;
  tokenUsage: { input: number; output: number; cost: number };
}
```

### 2.4 The Critical Design Decisions

#### Decision 1: Who Owns Tools?

**Option A: Runtime owns tools (recommended for Claude Code / Codex)**
The runtime brings its own filesystem, exec, browser tools. The Gateway can *additionally* expose OpenClaw-specific tools (memory, sessions_spawn, cron, node commands) via MCP. Both Claude Code and Codex natively consume MCP servers — so the Gateway runs an MCP server that provides OpenClaw tools, and the runtime connects to it.

```
Gateway MCP Server (openclaw-tools)
  ├── memory_search / memory_store
  ├── sessions_spawn / sessions_list
  ├── cron_schedule / cron_list
  ├── node_invoke (camera, screen, run)
  ├── canvas_update
  └── webhook_register
         │
         │ MCP (stdio or SSE)
         ▼
  Agent Runtime (Claude Code / Codex / etc.)
  ├── [built-in: file read/write/edit, exec, browser]
  └── [injected: openclaw-tools via MCP]
```

**Option B: Gateway owns tools (current pi-mono model)**
Works for in-process runtimes that don't have their own tool system. The Gateway assembles tools and passes them as function schemas to the LLM. This is how pi-mono works today.

**Recommended: Support both.** Runtimes declare `supportsToolInjection` and `supportsMcp` in their capabilities. If the runtime supports MCP, the Gateway exposes OpenClaw tools as an MCP server. If the runtime supports tool injection, the Gateway builds the tool set and passes schemas directly.

#### Decision 2: Who Handles Approvals?

This is the trickiest part. Currently:
- pi-mono: The Gateway's tool policy pipeline decides. No user prompt needed for allowed tools.
- Claude Code: ACP `permission_mode` (acceptEdits / bypassPermissions / etc.)
- Codex: The App Server pauses a Turn and sends an approval request to the client.

For a personal assistant responding on WhatsApp, you can't pop up a "do you approve this file write?" dialog. The Gateway needs to be the approval authority.

**Proposed: Gateway-mediated approval**
1. The runtime sends an ACP-style approval request
2. The ACP multiplexer intercepts it
3. The Gateway evaluates against its policy chain (global → provider → agent → session)
4. If policy allows → auto-approve and forward to runtime
5. If policy denies → auto-deny and log
6. If policy says "ask" → forward to the user via their channel, wait for response

This means the Gateway acts as a **policy proxy** in the approval flow, which is exactly the right separation of concerns.

#### Decision 3: Who Manages Memory?

**Current state:** OpenClaw's memory is markdown files injected into the system prompt by the Gateway. With external runtimes, the Gateway no longer controls prompt assembly.

**Solution: Memory as an MCP tool**
Instead of injecting memory into the prompt, expose it as tools:
- `memory_search(query)` — semantic search over past context
- `memory_store(key, value, metadata)` — persist a fact
- `memory_context()` — retrieve relevant context for current session

The runtime's own system prompt tells it "you have access to a memory system — use it proactively." This is more token-efficient than dumping everything into the system prompt, and it works identically across all runtimes.

#### Decision 4: How to Handle Skills?

OpenClaw skills are markdown files injected into the prompt. With external runtimes:

**Option A: Skills as MCP tools** — Each skill becomes an MCP tool with a `skill_invoke(skillName, input)` interface. The runtime calls the skill when relevant.

**Option B: Skills as system prompt appendix** — For runtimes that support system prompt customization (Claude Code supports `CLAUDE.md`, Codex supports `AGENTS.md`), the Gateway generates a combined system prompt file that includes relevant skills.

**Option C: Hybrid** — Use CLAUDE.md / AGENTS.md for identity and personality (SOUL.md equivalent), and MCP tools for action-oriented skills. This is the cleanest separation.

---

## 3. The pi-mono ACP Adapter

To make this work, pi-mono (the current runtime) needs to be wrapped in an ACP server. This is the reverse of what OpenClaw currently does (it has an ACP *client* bridge for IDEs).

```typescript
// Conceptual: pi-mono wrapped as an ACP agent server
class PiMonoAcpAgent implements AcpAgent {
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    // Set up workspace, load config
    return { capabilities: { tools: true, streaming: true } };
  }

  async newSession(params: NewSessionParams): Promise<SessionInfo> {
    // Create JSONL transcript, assemble system prompt
    // Load tools via existing pipeline
    return { sessionId, model, tools: toolSchemas };
  }

  async prompt(params: PromptParams): AsyncIterable<SessionUpdate> {
    // Run the existing pi-embedded-runner
    // Translate internal events → ACP session/update notifications
    for await (const event of runEmbeddedPiAgent(session, message, tools)) {
      yield translateToAcpUpdate(event);
    }
  }

  async cancel(params: CancelParams): Promise<void> {
    // Abort the current run
  }
}
```

This wrapper is relatively thin — it's mostly event translation. The key benefit: pi-mono is now *one* runtime among many, not a special case.

---

## 4. Runtime Routing

The Gateway needs to decide which runtime handles each session. This can be:

### Static routing (simplest)
```json5
// openclaw.json
{
  agents: {
    list: [
      {
        id: "main",
        runtime: "claude-code",
        // All DM sessions use Claude Code
      },
      {
        id: "coder",
        runtime: "codex",
        // Coding tasks routed here
      },
      {
        id: "assistant",
        runtime: "pi-mono",
        // Legacy/general assistant
      }
    ]
  }
}
```

### Dynamic routing (advanced)
A lightweight classifier (could be a small local model or keyword matching) examines the inbound message and routes to the appropriate runtime:

- Coding task → Codex (best sandbox model, Rust performance)
- General assistant → Claude Code (best reasoning)
- Legacy/custom skills → pi-mono (full skill ecosystem)

### User-switchable
The user says `/runtime codex` or `/runtime claude-code` mid-conversation, similar to how `/model` switches models today. Session context would need to be serialized and re-injected.

---

## 5. What This Enables

### 5.1 Best-of-breed per task
Route coding tasks to Codex (Rust sandbox, GPT-5), research tasks to Claude Code (Opus reasoning), and automation tasks to pi-mono (OpenClaw skill ecosystem). Each runtime plays to its strengths.

### 5.2 Vendor independence
If Anthropic's API goes down, sessions can failover to Codex or a local model runtime. The Gateway's session registry tracks which runtime has which session, and the ACP protocol is runtime-agnostic.

### 5.3 Local model support
A runtime adapter for Ollama/llama.cpp/vLLM would let you run fully offline sessions for sensitive work, while routing other sessions to cloud runtimes.

### 5.4 A/B testing runtimes
Run the same prompt through multiple runtimes and compare results. Useful for evaluating new models or runtime versions.

### 5.5 Graduated trust
Use a restricted runtime (read-only tools, no exec) for untrusted inbound messages (group chats, public channels), and a full-capability runtime for trusted DMs.

---

## 6. The Hard Problems

### 6.1 Session portability
If you switch runtimes mid-conversation, how do you transfer context? ACP doesn't define a "session export" primitive. Options:
- Serialize the transcript and inject it as a user message to the new runtime (lossy but simple)
- Define a session interchange format (complex but correct)
- Don't support mid-conversation switching — only on session reset

### 6.2 Tool schema divergence
Claude Code's `Edit` tool and Codex's `edit_text_file` tool do the same thing but with different schemas. The Gateway's MCP server for OpenClaw-specific tools uses one schema, but the runtime's built-in tools are their own. This means the same logical operation ("edit a file") has different tool names depending on the runtime. The system prompt or AGENTS.md needs to be runtime-aware.

### 6.3 Cost attribution
Different runtimes have different pricing models. Codex is included with ChatGPT Plus; Claude Code uses API tokens; pi-mono uses whichever LLM you configure. The Gateway needs a unified cost tracking layer that normalizes across runtimes.

### 6.4 Streaming semantics
ACP's `session/update` is relatively simple (text deltas + lifecycle events). Codex's App Server has richer semantics (Items with started/delta/completed lifecycle, Turns, Threads). The ACP multiplexer needs to normalize these into a consistent stream format for channels.

### 6.5 Feature parity for channels
A WhatsApp user expects text responses. A Zed user expects diffs and file operations. A Canvas user expects HTML rendering. The Gateway needs to negotiate capabilities between the channel and the runtime: "this channel supports text + images only, so don't emit diff blocks."

---

## 7. Implementation Roadmap

### Phase 1: Extract pi-mono into ACP adapter
- Wrap the existing pi-embedded-runner in an ACP server
- Gateway communicates with it over ACP instead of direct function calls
- No user-visible changes — same behavior, new internal boundary

### Phase 2: Add Claude Code as second runtime
- Use `@zed-industries/claude-code-acp` (or similar) as the subprocess
- Gateway exposes OpenClaw tools via MCP server
- Gateway mediates approval flow
- Support static routing: `runtime: "claude-code"` in agent config

### Phase 3: Add Codex as third runtime
- Use `codex-acp` bridge or Codex App Server directly
- Same MCP tool injection pattern
- Same approval mediation

### Phase 4: Dynamic routing + session portability
- Implement the routing classifier
- Define session interchange format
- Support `/runtime` switching

### Phase 5: Local model runtime
- Adapter for Ollama/vLLM that speaks ACP
- Restricted capability set (no cloud tools)
- Offline-capable sessions

---

## 8. Comparison with Existing Approaches

### AgentPool (phil65)
Already does this! YAML-configured ACP agents (Claude Code, Codex, Goose) with an MCP bridge for internal toolsets. Key difference: AgentPool is a library/SDK, not a persistent gateway with channels and memory. OpenClaw would add the channel layer, session persistence, and multi-user routing on top.

### Ruflo
Multi-agent orchestration for Claude Code with plugins/skills. Different goal — it's about *coordinating* multiple agents on a task, not about making the runtime pluggable from the gateway's perspective.

### Vibecode Terminal
Runs Claude Code, Codex, Gemini CLI, Cursor CLI in web sandboxes. Closest to the multi-runtime idea, but without the channel adapter + persistent memory layer.

---

## 9. The Key Insight

The pattern that emerges: **ACP is to agent runtimes what LSP is to language servers.** The Gateway becomes a "client" that can connect to any ACP-compatible agent server, just like an IDE connects to any LSP-compatible language server.

The Gateway's unique value shifts from "running the agent loop" to:
1. **Channel multiplexing** (the inbox)
2. **Policy enforcement** (the trust boundary)
3. **Tool brokering** (OpenClaw-specific capabilities via MCP)
4. **Persistent identity** (SOUL.md, memory, cross-session knowledge)
5. **Observability** (unified logging, cost tracking, audit trail)

The agent runtime becomes a commodity — swap it based on the task, the model, or even the user's preference. The Gateway is the durable infrastructure.
