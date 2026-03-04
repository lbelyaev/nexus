# Sandboxed Persona (Read-Only / Low-Disclosure)

This setup creates a bot persona that is tightly constrained by deterministic policy, not prompt text alone.

## Goals

- Only trusted users can invoke the bot.
- The bot cannot perform write-like actions.
- Data exposure risk is reduced by isolation boundaries.

## 1) Restrict who can talk to the bot

Use channel allowlists:

- Discord: `channels.<id>.allowedUserIds`
- Telegram: `channels.<id>.allowedChatIds`

Example (Discord):

```json
{
  "channels": {
    "discord-main": {
      "kind": "discord",
      "botToken": "...",
      "allowedUserIds": ["291716660644282368"],
      "workspaceId": "sandbox-public"
    }
  }
}
```

## 2) Isolate workspace context

Route the channel to a dedicated workspace (for example `sandbox-public`) so memory/transcript scope is separated from higher-trust workspaces.

## 3) Enforce principal-scoped policy (no writes)

Policy rules now support:

- `principalType`
- `principalIdPattern`
- `source`
- `workspaceIdPattern`

Use these to deny write-capable tools for the sandbox persona:

```json
{
  "rules": [
    {
      "tool": "Write",
      "action": "deny",
      "principalIdPattern": "discord-main:",
      "source": "api",
      "workspaceIdPattern": "sandbox-public"
    },
    {
      "tool": "Edit",
      "action": "deny",
      "principalIdPattern": "discord-main:",
      "source": "api",
      "workspaceIdPattern": "sandbox-public"
    },
    {
      "tool": "MultiEdit",
      "action": "deny",
      "principalIdPattern": "discord-main:",
      "source": "api",
      "workspaceIdPattern": "sandbox-public"
    },
    {
      "tool": "Bash",
      "action": "deny",
      "principalIdPattern": "discord-main:",
      "source": "api",
      "workspaceIdPattern": "sandbox-public"
    },
    { "tool": "*", "action": "ask" }
  ]
}
```

Notes:

- Principal IDs from channels are `user:<adapterId>:<senderId>`.
- `principalIdPattern` is substring matching; `discord-main:` scopes to that adapter.

## 4) Reduce disclosure surface

For stronger non-disclosure guarantees, pair policy with runtime isolation:

- Separate runtime profile for sandbox persona.
- Minimal env vars (no production secrets).
- Restricted filesystem/sandboxed working directory.
- Disable or tightly gate network-capable tools.

## Current limitation

Policy enforcement is deterministic for tool use, but output content filtering/redaction is not yet a first-class policy layer. If you need hard outbound redaction, add a dedicated response filter stage in the channel manager/gateway.
