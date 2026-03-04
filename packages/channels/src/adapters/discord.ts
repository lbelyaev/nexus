import type { ChannelAdapter, ChannelAdapterContext, ChannelOutboundMessage } from "../types.js";

export interface DiscordAdapterOptions {
  id?: string;
  botToken: string;
  applicationId?: string;
  guildId?: string;
}

export const createDiscordAdapter = (options: DiscordAdapterOptions): ChannelAdapter => {
  const { id = "discord", applicationId, guildId } = options;
  let ctx: ChannelAdapterContext | null = null;

  return {
    id,
    start: async (context) => {
      ctx = context;
      context.log.warn("discord_adapter_stub", {
        adapterId: id,
        message: "Discord transport is scaffolded but not connected yet. Telegram is functional in this milestone.",
        applicationId: applicationId ?? null,
        guildId: guildId ?? null,
      });
    },
    stop: async () => {
      ctx?.log.info("discord_adapter_stopped", { adapterId: id });
      ctx = null;
    },
    sendMessage: async (_message: ChannelOutboundMessage) => {
      ctx?.log.warn("discord_adapter_send_ignored", {
        adapterId: id,
        message: "Discord adapter transport is not implemented yet.",
      });
    },
  };
};
