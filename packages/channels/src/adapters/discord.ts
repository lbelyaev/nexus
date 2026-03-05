import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelOutboundMessage,
  ChannelQuickAction,
  ChannelStreamingState,
  ChannelTypingState,
} from "../types.js";

export interface DiscordAdapterOptions {
  id?: string;
  botToken: string;
  applicationId?: string;
  guildId?: string;
  allowedUserIds?: string[];
}

interface StreamTarget {
  channelId: string;
  messageId: string;
}

interface SendableMessage {
  id: string;
  edit: (content: string | { content: string }) => Promise<unknown>;
}

interface SendableChannel {
  send: (content: string | { content: string; components: Array<ActionRowBuilder<ButtonBuilder>> }) => Promise<SendableMessage>;
  sendTyping: () => Promise<void>;
  messages?: {
    fetch: (messageId: string) => Promise<SendableMessage>;
  };
}

import { formatMarkdownTables } from "./tables.js";

const DISCORD_QUICK_ACTION_PREFIX = "nx:";

export const formatMarkdownTablesForDiscord = (text: string): string =>
  formatMarkdownTables(text, (tableLines) => [
    "```text",
    ...tableLines,
    "```",
  ]);

const splitMessage = (text: string, max: number = 1800): string[] => {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut > 0) {
      cut += 1;
    } else {
      cut = max;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
};

const conversationToChannelId = (conversationId: string): string => {
  const separator = conversationId.indexOf(":");
  if (separator < 0) return conversationId;
  return conversationId.slice(0, separator);
};

const isSendableChannel = (value: unknown): value is SendableChannel => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.send === "function";
};

const resolveTextChannel = async (client: Client, channelId: string): Promise<SendableChannel | null> => {
  const cached = client.channels.cache.get(channelId);
  const resolved = cached ?? await client.channels.fetch(channelId).catch(() => null);
  if (!resolved || !resolved.isTextBased() || !isSendableChannel(resolved)) return null;
  return resolved;
};

const renderSenderDisplay = (message: Message): string => (
  message.member?.displayName
  ?? message.author.globalName
  ?? message.author.username
);

const renderInteractionSenderDisplay = (interaction: ButtonInteraction): string => {
  const guildMember = interaction.member as { displayName?: string } | null;
  return guildMember?.displayName
    ?? interaction.user.globalName
    ?? interaction.user.username;
};

const toCustomId = (command: string): string => `${DISCORD_QUICK_ACTION_PREFIX}${command}`;

const fromCustomId = (customId: string): string | null => {
  if (!customId.startsWith(DISCORD_QUICK_ACTION_PREFIX)) return null;
  const command = customId.slice(DISCORD_QUICK_ACTION_PREFIX.length).trim();
  return command || null;
};

const toActionRows = (quickActions: ChannelQuickAction[] | undefined): Array<ActionRowBuilder<ButtonBuilder>> | undefined => {
  if (!quickActions || quickActions.length === 0) return undefined;

  const buttons = quickActions.slice(0, 5).map((action, index) => new ButtonBuilder()
    .setCustomId(toCustomId(action.command))
    .setLabel(action.label)
    .setStyle(index === 0 ? ButtonStyle.Success : ButtonStyle.Danger));
  if (buttons.length === 0) return undefined;

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
};

const isImageAttachment = (attachment: {
  contentType: string | null;
  name: string | null;
}): boolean => {
  if (attachment.contentType?.startsWith("image/")) return true;
  if (!attachment.name) return false;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.name);
};

const normalizeInboundText = (message: Message, botUserId: string, hasImages: boolean): string | null => {
  const trimmed = message.content.trim();
  if (!message.guildId) {
    if (!trimmed && !hasImages) return null;
    return trimmed;
  }

  const mentionPrefix = new RegExp(`^<@!?${botUserId}>\\s*`);
  if (mentionPrefix.test(trimmed)) {
    const stripped = trimmed.replace(mentionPrefix, "").trim();
    if (!stripped && !hasImages) return null;
    return stripped;
  }

  // In guild text channels, require explicit slash-like command if not mentioned.
  if (trimmed.startsWith("/")) return trimmed;
  return null;
};

export const createDiscordAdapter = (options: DiscordAdapterOptions): ChannelAdapter => {
  const {
    id = "discord",
    botToken,
    applicationId,
    guildId,
    allowedUserIds,
  } = options;

  let client: Client | null = null;
  let ctx: ChannelAdapterContext | null = null;
  const streamTargets = new Map<string, StreamTarget>();
  const allowedUsers = allowedUserIds && allowedUserIds.length > 0
    ? new Set(allowedUserIds.map((v) => v.trim()).filter(Boolean))
    : null;

  return {
    id,
    supportsQuickActions: true,
    start: async (context) => {
      ctx = context;
      const discordClient = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
      });
      client = discordClient;

      discordClient.on("messageCreate", (message) => {
        if (!ctx) return;
        if (message.author.bot) return;
        // Apply guild filter only to guild traffic; do not block DMs when a guild filter is set.
        if (guildId && message.guildId && message.guildId !== guildId) return;
        if (allowedUsers && !allowedUsers.has(message.author.id)) {
          ctx.log.debug("discord_message_filtered_user", {
            adapterId: id,
            userId: message.author.id,
            channelId: message.channelId,
          });
          return;
        }
        const botUserId = discordClient.user?.id;
        if (!botUserId) return;
        const images = Array.from(message.attachments.values())
          .filter((attachment) => isImageAttachment({
            contentType: attachment.contentType,
            name: attachment.name,
          }))
          .map((attachment) => ({
            url: attachment.url,
            ...(attachment.contentType ? { mediaType: attachment.contentType } : {}),
          }));

        const text = normalizeInboundText(message, botUserId, images.length > 0);
        if (text === null) return;

        const conversationId = message.guildId
          ? `${message.channelId}:${message.author.id}`
          : message.channelId;

        void ctx.onMessage({
          adapterId: id,
          conversationId,
          senderId: message.author.id,
          senderDisplayName: renderSenderDisplay(message),
          text,
          images,
        }).catch((error) => {
          ctx?.log.warn("discord_inbound_message_failed", {
            adapterId: id,
            channelId: message.channelId,
            authorId: message.author.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });

      discordClient.on("interactionCreate", (interaction) => {
        if (!ctx) return;
        if (!interaction.isButton()) return;
        if (guildId && interaction.guildId && interaction.guildId !== guildId) return;
        if (guildId && !interaction.guildId) return;
        if (allowedUsers && !allowedUsers.has(interaction.user.id)) {
          ctx.log.debug("discord_interaction_filtered_user", {
            adapterId: id,
            userId: interaction.user.id,
            channelId: interaction.channelId,
          });
          return;
        }

        const command = fromCustomId(interaction.customId);
        if (!command) return;

        const conversationId = interaction.guildId
          ? `${interaction.channelId}:${interaction.user.id}`
          : interaction.channelId;

        void ctx.onMessage({
          adapterId: id,
          conversationId,
          senderId: interaction.user.id,
          senderDisplayName: renderInteractionSenderDisplay(interaction),
          text: command,
        }).then(async () => {
          // Remove buttons on first click to avoid stale repeat actions.
          await interaction.update({ components: [] }).catch(async () => {
            await interaction.deferUpdate().catch(() => undefined);
          });
        }).catch(async (error) => {
          ctx?.log.warn("discord_button_interaction_failed", {
            adapterId: id,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await interaction.reply({
            content: "Nexus couldn't process that action. Please try again.",
            ephemeral: true,
          }).catch(() => undefined);
        });
      });

      discordClient.on("error", (error) => {
        context.log.warn("discord_client_error", {
          adapterId: id,
          error: error.message,
        });
      });

      await discordClient.login(botToken);
      context.log.info("discord_adapter_started", {
        adapterId: id,
        applicationId: applicationId ?? null,
        guildId: guildId ?? null,
        filteredUserCount: allowedUsers?.size ?? 0,
        botUserId: discordClient.user?.id ?? null,
      });
    },
    stop: async () => {
      streamTargets.clear();
      const discordClient = client;
      client = null;
      if (discordClient) {
        await discordClient.destroy();
      }
      ctx?.log.info("discord_adapter_stopped", {
        adapterId: id,
        applicationId: applicationId ?? null,
        guildId: guildId ?? null,
      });
      ctx = null;
    },
    sendMessage: async (message: ChannelOutboundMessage) => {
      if (!client) return;
      const channelId = conversationToChannelId(message.conversationId);
      const channel = await resolveTextChannel(client, channelId);
      if (!channel) {
        ctx?.log.warn("discord_send_channel_not_found", {
          adapterId: id,
          conversationId: message.conversationId,
          channelId,
        });
        return;
      }
      const chunks = splitMessage(formatMarkdownTablesForDiscord(message.text));
      const actionRows = toActionRows(message.quickActions);
      for (const [index, chunk] of chunks.entries()) {
        if (index === 0 && actionRows) {
          await channel.send({ content: chunk, components: actionRows });
        } else {
          await channel.send(chunk);
        }
      }
    },
    setTyping: async (state: ChannelTypingState) => {
      if (!state.active || !client) return;
      const channelId = conversationToChannelId(state.conversationId);
      const channel = await resolveTextChannel(client, channelId);
      if (!channel) return;
      await channel.sendTyping();
    },
    upsertStreamingMessage: async (state: ChannelStreamingState) => {
      if (!client) return;
      const channelId = conversationToChannelId(state.conversationId);
      const channel = await resolveTextChannel(client, channelId);
      if (!channel) return;

      const text = formatMarkdownTablesForDiscord(state.text.trim());
      const existing = streamTargets.get(state.streamId);
      if (!existing) {
        if (!text && !state.done) return;
        const created = await channel.send(text || "...");
        streamTargets.set(state.streamId, {
          channelId,
          messageId: created.id,
        });
        if (state.done) streamTargets.delete(state.streamId);
        return;
      }

      const targetChannel = await resolveTextChannel(client, existing.channelId);
      const messageManager = targetChannel?.messages;
      if (!targetChannel || !messageManager) {
        streamTargets.delete(state.streamId);
        return;
      }

      const content = text || "...";
      try {
        const msg = await messageManager.fetch(existing.messageId);
        await msg.edit(content);
      } catch {
        const recreated = await targetChannel.send(content);
        streamTargets.set(state.streamId, {
          channelId: existing.channelId,
          messageId: recreated.id,
        });
      }

      if (state.done) {
        streamTargets.delete(state.streamId);
      }
    },
  };
};
