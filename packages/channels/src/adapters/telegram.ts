import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelOutboundMessage,
  ChannelStreamingState,
  ChannelTypingState,
} from "../types.js";

export interface TelegramAdapterOptions {
  id?: string;
  botToken: string;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  pollIntervalMs?: number;
  allowedChatIds?: string[];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    text?: string;
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
}

interface TelegramMessageResponse {
  message_id: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const renderSender = (update: TelegramUpdate): string | undefined => {
  const from = update.message?.from;
  if (!from) return undefined;
  const parts = [from.first_name, from.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return from.username;
};

const splitMessage = (text: string, max: number = 3800): string[] => {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
};

export const createTelegramAdapter = (options: TelegramAdapterOptions): ChannelAdapter => {
  const {
    id = "telegram",
    botToken,
    apiBaseUrl = "https://api.telegram.org",
    pollTimeoutSeconds = 25,
    pollIntervalMs = 500,
    allowedChatIds,
  } = options;

  let ctx: ChannelAdapterContext | null = null;
  let running = false;
  let updateOffset = 0;
  let pollAbort: AbortController | null = null;
  const streamingMessageIds = new Map<string, number>();

  const allowed = allowedChatIds && allowedChatIds.length > 0
    ? new Set(allowedChatIds.map((v) => v.trim()).filter(Boolean))
    : null;

  const apiCall = async <T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(`${apiBaseUrl}/bot${botToken}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API ${method} failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const parsed = await res.json() as TelegramResponse<T>;
    if (!parsed.ok) {
      throw new Error(`Telegram API ${method} returned ok=false`);
    }
    return parsed.result;
  };

  const processUpdates = async (updates: TelegramUpdate[]): Promise<void> => {
    if (!ctx) return;

    for (const update of updates) {
      if (update.update_id >= updateOffset) {
        updateOffset = update.update_id + 1;
      }

      const message = update.message;
      if (!message?.text) continue;

      const chatId = String(message.chat.id);
      if (allowed && !allowed.has(chatId)) {
        ctx.log.debug("telegram_message_filtered_chat", {
          adapterId: id,
          chatId,
        });
        continue;
      }

      const senderId = String(message.from?.id ?? message.chat.id);
      await ctx.onMessage({
        adapterId: id,
        conversationId: chatId,
        senderId,
        senderDisplayName: renderSender(update),
        text: message.text,
      });
    }
  };

  const pollOnce = async (): Promise<void> => {
    pollAbort = new AbortController();
    const result = await apiCall<TelegramUpdate[]>(
      "getUpdates",
      {
        timeout: pollTimeoutSeconds,
        offset: updateOffset,
        allowed_updates: ["message"],
      },
      pollAbort.signal,
    );
    await processUpdates(result);
  };

  const pollLoop = async (): Promise<void> => {
    if (!ctx) return;
    while (running) {
      try {
        await pollOnce();
      } catch (error) {
        if (!running) break;
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warn("telegram_poll_error", { adapterId: id, error: message });
      }
      if (running && pollIntervalMs > 0) {
        await delay(pollIntervalMs);
      }
    }
  };

  const sendText = async (conversationId: string, text: string): Promise<void> => {
    await apiCall<TelegramMessageResponse>("sendMessage", {
      chat_id: conversationId,
      text,
      disable_web_page_preview: false,
    });
  };

  const setTyping = async (state: ChannelTypingState): Promise<void> => {
    if (!state.active) return;
    await apiCall("sendChatAction", {
      chat_id: state.conversationId,
      action: "typing",
    });
  };

  const upsertStreamingMessage = async (state: ChannelStreamingState): Promise<void> => {
    if (!state.text && !state.done) return;
    const currentMessageId = streamingMessageIds.get(state.streamId);
    if (!currentMessageId) {
      if (!state.text) return;
      const created = await apiCall<TelegramMessageResponse>("sendMessage", {
        chat_id: state.conversationId,
        text: state.text,
        disable_web_page_preview: false,
      });
      streamingMessageIds.set(state.streamId, created.message_id);
      if (state.done) {
        streamingMessageIds.delete(state.streamId);
      }
      return;
    }

    if (!state.text) {
      if (state.done) {
        streamingMessageIds.delete(state.streamId);
      }
      return;
    }

    await apiCall("editMessageText", {
      chat_id: state.conversationId,
      message_id: currentMessageId,
      text: state.text,
      disable_web_page_preview: false,
    });
    if (state.done) {
      streamingMessageIds.delete(state.streamId);
    }
  };

  return {
    id,
    start: async (context) => {
      ctx = context;
      running = true;
      context.log.info("telegram_adapter_started", {
        adapterId: id,
        pollTimeoutSeconds,
        pollIntervalMs,
        filteredChatCount: allowed?.size ?? 0,
      });
      void pollLoop();
    },
    stop: async () => {
      running = false;
      pollAbort?.abort();
      pollAbort = null;
      streamingMessageIds.clear();
      ctx?.log.info("telegram_adapter_stopped", { adapterId: id });
      ctx = null;
    },
    sendMessage: async (message: ChannelOutboundMessage) => {
      const chunks = splitMessage(message.text);
      for (const chunk of chunks) {
        await sendText(message.conversationId, chunk);
      }
    },
    setTyping,
    upsertStreamingMessage,
  };
};
