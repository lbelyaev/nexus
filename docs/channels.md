# Nexus Channel Adapters (Telegram + Discord)

This milestone adds a pluggable channels layer in `@nexus/channels` and startup wiring in gateway.

## Current status

- Telegram: implemented (Bot API long-poll + send messages).
- Discord: scaffolded only (adapter exists, logs warning, transport not yet connected).

## Config shape

Add a `channels` object to your gateway config (`NEXUS_CONFIG` file):

```json
{
  "channels": {
    "telegram-main": {
      "kind": "telegram",
      "enabled": true,
      "botToken": "<telegram-bot-token>",
      "allowedChatIds": ["123456789"],
      "runtimeId": "claude",
      "model": "claude-sonnet-4-5-20250929",
      "workspaceId": "default",
      "typingIndicator": true,
      "streamingMode": "off",
      "pollTimeoutSeconds": 25,
      "pollIntervalMs": 500
    },
    "discord-main": {
      "kind": "discord",
      "enabled": false,
      "botToken": "<discord-bot-token>",
      "runtimeId": "codex",
      "workspaceId": "default"
    }
  }
}
```

Field notes:

- `runtimeId`, `model`, and `workspaceId` are optional; defaults come from normal session routing.
- `runtimeId` must match a runtime from `runtimes`.
- `allowedChatIds` is optional but strongly recommended for Telegram safety.
- `typingIndicator` controls chat typing pulses while a turn is in progress (default: `true`).
- `streamingMode` controls channel rendering behavior:
  - `off` (default): aggregate deltas and send one final message on `turn_end`.
  - `edit`: stream by editing a single in-flight message (currently implemented for Telegram).
- `discord` is accepted by config validation, but currently runs as a stub adapter.

## Run

From repo root:

```bash
NEXUS_CONFIG=../../config/nexus.multi.json bun run --filter=@nexus/gateway dev
```

or use your existing root script:

```bash
bun run gateway:dev:multi
```

## Telegram channel commands

Inside Telegram chats connected to the bot:

- `/help`
- `/status`
- `/new`
- `/cancel`
- `/approve <requestId|all>`
- `/deny <requestId>`

## Session mapping model

- One Nexus session per `(adapterId, conversationId)` pair.
- Principal is mapped as `user:<adapterId>:<senderId>`.
- Text deltas are buffered and sent as one message on `turn_end`.
- Tool approvals are surfaced into chat as commands.
