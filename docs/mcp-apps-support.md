# MCP Apps Support — Planning Doc

## Background

**MCP Apps** (formerly MCP-UI) is the first official extension to the Model Context Protocol, standardized January 2026. It enables MCP servers to deliver interactive HTML UIs rendered in sandboxed iframes, with bidirectional JSON-RPC communication between the UI and the host.

Adoption: ChatGPT, Claude, Goose, and VS Code have shipped support. The spec was co-developed by Anthropic, OpenAI, and the MCP-UI community.

### Key concepts

- **`ui://` resources**: MCP servers declare UI resources using a `ui://` URI scheme, served as HTML5 documents via `resources/read`
- **Tool-UI linkage**: Tools reference UI resources through `_meta.ui.resourceUri` metadata
- **Iframe sandboxing**: Hosts render UIs in sandboxed iframes with enforced CSP and permission policies
- **Bidirectional comms**: Iframes communicate with the host via `postMessage` carrying JSON-RPC 2.0 messages

### Spec references

- Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- SDK: https://github.com/modelcontextprotocol/ext-apps
- Docs: https://modelcontextprotocol.io/docs/extensions/apps

---

## Nexus architecture context

In Nexus, the **agent runtime** (Claude Code, Codex, Gemini CLI) owns MCP server connections. The gateway is a protocol translator between clients and runtimes — it does not manage MCP servers directly.

Current state:
- `mcpServers` is always `[]` in ACP `session/new` — no MCP server config passthrough
- Tool events (`tool_start`, `tool_end`) flow end-to-end but carry no UI metadata
- TUI renders tool names/params as text; web client has basic tool display

---

## Option 1: Passthrough (recommended)

Let the agent runtime handle all MCP Apps communication. Nexus forwards UI metadata to clients, and the web client renders iframes.

### Work items

#### 1. MCP server config passthrough
- Add `mcpServers` to gateway config schema (per-runtime or global)
- Pass configured MCP servers to ACP `session/new` params
- Files: `packages/gateway/src/start.ts`, config schema in `packages/types`

#### 2. Extend event types with UI metadata
- Add optional `ui` field to `tool_start` / `tool_end` gateway events:
  ```ts
  ui?: {
    resourceUri: string;
    html?: string;       // prefetched content
    csp?: CspConfig;
    permissions?: UiPermissions;
  }
  ```
- Carry `_meta.ui` from ACP `session/update` through the translation layer
- Files: `packages/types/src/protocol.ts`, `packages/acp-bridge/src/session.ts`

#### 3. Web client iframe renderer
- New React component that renders `ui://` resources in sandboxed iframes
- Enforce CSP from metadata (`sandbox`, `csp` attribute, `allow` for permissions)
- Apply host theme variables as CSS custom properties
- Files: `packages/web-client/src/components/`

#### 4. postMessage bridge (client-side)
- Wire `postMessage` listener in the web client
- Translate iframe JSON-RPC messages to/from gateway WebSocket messages
- New message types: `ui_rpc_request` / `ui_rpc_response` on the client-gateway protocol
- Files: `packages/web-client/`, `packages/types/src/protocol.ts`

#### 5. TUI fallback
- TUI cannot render iframes — show tool name + "UI available in web client" indicator
- No code changes needed if `ui` field is optional (TUI ignores it)

### Estimated effort

| Item | Estimate |
|---|---|
| Config passthrough | Small (hours) |
| Event type extensions | Small (hours) |
| Iframe renderer | Medium (1-2 days) |
| postMessage bridge | Medium (1-2 days) |
| TUI fallback | Trivial |
| **Total** | **~3 days** |

### What this does NOT cover

- Gateway-managed MCP servers (Option 2 — gateway as MCP host)
- MCP Apps discovery/marketplace
- Multi-server UI composition
- App-to-app communication

### Dependencies

- Agent runtime must support MCP Apps (Claude Code does as of early 2026)
- Web client must exist (currently in `packages/web-client`)

---

## Future: Option 2 (gateway as MCP host)

If Nexus ever needs to manage MCP servers directly (e.g., for runtimes that don't support MCP natively), the gateway would need:
- Full MCP client implementation
- Resource fetching and caching
- Iframe content proxying
- Bidirectional JSON-RPC bridge at the gateway level

This is a multi-week effort and should only be considered if there's a concrete need. The passthrough approach covers the primary use case.
