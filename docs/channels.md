# Nexus Channel Adapters (Telegram + Discord)

This milestone adds a pluggable channels layer in `@nexus/channels` and startup wiring in gateway.

## Current status

- Telegram: implemented (Bot API long-poll + send messages).
- Discord: implemented via `discord.js` (message intake, send, typing indicator, streaming-edit mode).

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
      "steeringMode": "on",
      "pollTimeoutSeconds": 25,
      "pollIntervalMs": 500
    },
    "discord-main": {
      "kind": "discord",
      "enabled": true,
      "botToken": "<discord-bot-token>",
      "guildId": "<optional-guild-id-filter>",
      "allowedUserIds": ["<your-discord-user-id>"],
      "runtimeId": "codex",
      "workspaceId": "default",
      "typingIndicator": true,
      "streamingMode": "edit",
      "steeringMode": "on"
    }
  }
}
```

Security note: keep real channel tokens in env or gitignored local config files (for example `config/*.local.json`). Do not commit live bot tokens.

Field notes:

- `runtimeId`, `model`, and `workspaceId` are optional; defaults come from normal session routing.
- `runtimeId` must match a runtime from `runtimes`.
- `allowedChatIds` is optional but strongly recommended for Telegram safety.
- `typingIndicator` controls chat typing pulses while a turn is in progress (default: `true`).
- `streamingMode` controls channel rendering behavior:
  - `off` (default): aggregate deltas and send one final message on `turn_end`.
  - `edit`: stream by editing a single in-flight message.
- `steeringMode` controls what happens when user sends a new message while a turn is running:
  - `off` (default): send as a normal prompt (runtime behavior applies).
  - `on`: queue as steer, cancel current turn, then auto-prompt after `turn_end`.
- `discord.guildId` is optional; if set, guild messages are filtered to that guild. DMs are still accepted.
- `discord.allowedUserIds` is optional; if set, only listed Discord user IDs can invoke Nexus (DMs + guild).
- Discord guild mode requires bot intent for message content in Discord developer settings.

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

## Discord input behavior

- DMs: plain text messages are accepted.
- Guild channels:
  - mention the bot (`@TeleNexus ...`) for plain prompts, or
  - use slash-like text commands (`/status`, `/help`, etc.).
- In guild channels, sessions are isolated per `(channel, user)` pair.

## Session mapping model

- One Nexus session per `(adapterId, conversationId)` pair.
- Principal is mapped as `user:<adapterId>:<senderId>`.
- Text deltas are buffered and sent as one message on `turn_end`.
- Tool approvals are surfaced into chat as commands.

This principal format is now usable in policy rules via `principalIdPattern`, which lets you scope allow/deny behavior to a channel or user without changing global policy for everyone.
