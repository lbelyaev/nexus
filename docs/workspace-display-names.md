# Workspace Display Names — Planning Doc

## Problem

Both the TUI and web client hardcode chat role labels ("You"/"Assistant" and "user"/"assistant"). There's no way to configure display names per workspace or globally.

## How others handle it

| Project | Approach | Clean separation? |
|---|---|---|
| **OpenClaw** | Markdown files (IDENTITY.md, USER.md, SOUL.md) loaded into LLM context each session. UI still shows generic labels — the LLM "knows" names but the UI doesn't. | No — conflates UI labels with LLM persona |
| **NanoClaw** | No config system. Fork the repo, edit hardcoded strings, or use `/customize` to have Claude rewrite the code. | No |
| **IronClaw** | Structured agent profiles focused on tool permissions/security. No display name config. | N/A |

**Key insight**: None cleanly separate **UI labels** (what the chat bubble header says) from **LLM persona** (how the agent refers to itself in text). These are different concerns.

## Proposed design for Nexus

Separate the two concerns:

1. **`displayNames`** — structured config for UI labels, rendered by clients immediately
2. **Persona/system prompt** — separate concern that feeds into ACP session params

### Where display names live: workspace config

Workspaces are currently bare string IDs. Promote them to a first-class config object:

```jsonc
// nexus.config.json
{
  "workspaces": {
    "default": {
      "displayNames": {
        "user": "Leo",
        "assistant": "Nexus"
      }
    },
    "work": {
      "displayNames": {
        "user": "Leo",
        "assistant": "Copilot"
      }
    }
  }
}
```

### Type additions

```typescript
// packages/types/src/config.ts
interface WorkspaceConfig {
  displayNames?: {
    user?: string;
    assistant?: string;
  };
  // future: theme, persona, system prompt, etc.
}

// In NexusConfig
workspaces?: Record<string, WorkspaceConfig>;
```

### Protocol: surface names to clients

Include display names in the `session_created` event:

```typescript
// packages/types/src/protocol.ts — session_created event
{
  type: "session_created";
  sessionId: string;
  displayNames?: {
    user?: string;
    assistant?: string;
  };
  // ...existing fields
}
```

Clients use these if present, fall back to current defaults if absent.

### Client changes

**TUI** (`packages/tui/src/components/Chat.tsx`):
- Read `displayNames` from session/connection state
- Replace `"You: "` → `displayNames.user ?? "You"`
- Replace `"Assistant: "` → `displayNames.assistant ?? "Assistant"`

**Web client** (`packages/web-client/src/components/NexusWebClient.tsx`):
- Read `displayNames` from session state
- Replace `message.role` header → resolved display name

### Gateway changes

**Config loading** (`packages/gateway/src/start.ts`):
- Parse `workspaces` config section
- On `session_new`, look up workspace config by `workspaceId`
- Include `displayNames` in `session_created` response

### Estimated effort

| Item | Estimate |
|---|---|
| Type additions | Trivial |
| Config parsing + gateway plumbing | Small (hours) |
| TUI label swap | Trivial (~5 lines) |
| Web client label swap | Trivial (~3 lines) |
| Tests | Small |
| **Total** | **~half a day** |

## Future extensions

Once workspaces have a config object, it's natural to add:
- `theme` — color scheme per workspace
- `persona` — system prompt injected into ACP sessions
- `defaultRuntime` — preferred runtime per workspace
- `mcpServers` — workspace-scoped MCP server declarations

This keeps the workspace as the central customization point without over-engineering upfront.
