import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelOutboundMessage,
  ChannelQuickAction,
  ChannelStreamingState,
  ChannelTypingState,
} from "../types.js";

import { formatMarkdownTables } from "./tables.js";

export interface TelegramAdapterOptions {
  id?: string;
  botToken: string;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  pollIntervalMs?: number;
  allowedChatIds?: string[];
  commands?: Array<{ command: string; description: string }>;
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
    caption?: string;
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id: string;
      mime_type?: string;
      file_name?: string;
      file_size?: number;
    };
  };
  callback_query?: {
    id: string;
    from?: {
      id: number;
      is_bot: boolean;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    data?: string;
    message?: {
      message_id: number;
      chat: {
        id: number;
        type: string;
        title?: string;
        username?: string;
        first_name?: string;
        last_name?: string;
      };
    };
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
}

interface TelegramMessageResponse {
  message_id: number;
}

interface TelegramFileResponse {
  file_path?: string;
}

const TELEGRAM_CALLBACK_PREFIX = "nx:";
const TELEGRAM_STREAM_EDIT_MAX = 3800;
const TELEGRAM_STREAM_TRUNCATION_SUFFIX = "\n\n...";
const DEFAULT_TELEGRAM_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "help", description: "Show available Nexus commands." },
  { command: "commands", description: "List slash commands." },
  { command: "status", description: "Show current session status." },
  { command: "usage", description: "Show usage metrics and memory stats." },
  { command: "session", description: "List/resume/transfer/close sessions." },
  { command: "new", description: "Start a new session for this chat." },
  { command: "cancel", description: "Cancel the current turn." },
  { command: "approve", description: "Approve pending tool requests." },
  { command: "deny", description: "Deny pending tool requests." },
];

const escapeHtml = (text: string): string => text
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const markdownToTelegramHtml = (text: string): string => {
  let working = text.replaceAll("\r\n", "\n");
  const placeholders: string[] = [];
  const toPlaceholder = (value: string): string => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(value);
    return token;
  };

  // Preserve code fences and inline code before markdown substitutions.
  working = working.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, code: string) =>
    toPlaceholder(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`));
  working = working.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    toPlaceholder(`<code>${escapeHtml(code)}</code>`));

  // Convert markdown tables to <pre> blocks before HTML-escaping the rest.
  working = formatMarkdownTables(working, (tableLines) => [
    toPlaceholder(`<pre>${escapeHtml(tableLines.join("\n"))}</pre>`),
  ]);

  working = escapeHtml(working);
  working = working.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<a href=\"$2\">$1</a>");
  working = working.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<b>$1</b>");
  working = working.replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  working = working.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  working = working.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    const value = placeholders[Number(index)];
    return value ?? "";
  });

  return working;
};

const isEntityParseError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /can't parse entities|parse entities|parse_mode|entity/i.test(message);
};

const isMessageTooLongError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /message[_ ]too[_ ]long|message is too long/i.test(message);
};

const toCallbackData = (command: string): string | undefined => {
  const data = `${TELEGRAM_CALLBACK_PREFIX}${command}`;
  if (Buffer.byteLength(data, "utf8") > 64) return undefined;
  return data;
};

const fromCallbackData = (data: string | undefined): string | undefined => {
  if (!data || !data.startsWith(TELEGRAM_CALLBACK_PREFIX)) return undefined;
  return data.slice(TELEGRAM_CALLBACK_PREFIX.length).trim() || undefined;
};

const toInlineKeyboard = (quickActions: ChannelQuickAction[] | undefined): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined => {
  if (!quickActions || quickActions.length === 0) return undefined;
  const buttons = quickActions
    .map((action) => {
      const callbackData = toCallbackData(action.command);
      if (!callbackData) return null;
      return { text: action.label, callback_data: callbackData };
    })
    .filter((value): value is { text: string; callback_data: string } => value !== null);
  if (buttons.length === 0) return undefined;

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return { inline_keyboard: rows };
};

const removeInlineKeyboard = async (
  apiCall: <T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<T>,
  chatId: string,
  messageId?: number,
): Promise<void> => {
  if (!messageId) return;
  await apiCall("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [],
    },
  }).catch(() => undefined);
};

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

const truncateStreamingPreview = (text: string, max: number = TELEGRAM_STREAM_EDIT_MAX): string => {
  if (text.length <= max) return text;
  const headLength = Math.max(0, max - TELEGRAM_STREAM_TRUNCATION_SUFFIX.length);
  return `${text.slice(0, headLength)}${TELEGRAM_STREAM_TRUNCATION_SUFFIX}`;
};

export const createTelegramAdapter = (options: TelegramAdapterOptions): ChannelAdapter => {
  const {
    id = "telegram",
    botToken,
    apiBaseUrl = "https://api.telegram.org",
    pollTimeoutSeconds = 25,
    pollIntervalMs = 500,
    allowedChatIds,
    commands = DEFAULT_TELEGRAM_COMMANDS,
  } = options;

  let ctx: ChannelAdapterContext | null = null;
  let running = false;
  let updateOffset = 0;
  let pollAbort: AbortController | null = null;
  const streamingMessageIds = new Map<string, number>();
  const streamWritesInFlight = new Map<string, Promise<void>>();
  const fileUrlCache = new Map<string, string>();

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

      const callbackQuery = update.callback_query;
      if (callbackQuery?.id && callbackQuery.message?.chat?.id) {
        const chatId = String(callbackQuery.message.chat.id);
        if (allowed && !allowed.has(chatId)) {
          ctx.log.debug("telegram_callback_filtered_chat", {
            adapterId: id,
            chatId,
          });
          await apiCall("answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
          }).catch(() => undefined);
          continue;
        }

        const command = fromCallbackData(callbackQuery.data);
        if (command) {
          const senderId = String(callbackQuery.from?.id ?? callbackQuery.message.chat.id);
          await ctx.onMessage({
            adapterId: id,
            conversationId: chatId,
            senderId,
            senderDisplayName: callbackQuery.from
              ? [callbackQuery.from.first_name, callbackQuery.from.last_name].filter(Boolean).join(" ")
                || callbackQuery.from.username
              : undefined,
            text: command,
          });
          await removeInlineKeyboard(apiCall, chatId, callbackQuery.message.message_id);
        }

        await apiCall("answerCallbackQuery", {
          callback_query_id: callbackQuery.id,
        }).catch(() => undefined);
        continue;
      }

      const message = update.message;
      if (!message) continue;

      const chatId = String(message.chat.id);
      if (allowed && !allowed.has(chatId)) {
        ctx.log.debug("telegram_message_filtered_chat", {
          adapterId: id,
          chatId,
        });
        continue;
      }

      const imageUrls: Array<{ url: string; mediaType?: string }> = [];
      const imageFileRefs: Array<{ fileId: string; mediaType?: string }> = [];
      const largestPhoto = message.photo && message.photo.length > 0
        ? [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]
        : undefined;
      if (largestPhoto?.file_id) {
        imageFileRefs.push({ fileId: largestPhoto.file_id, mediaType: "image/jpeg" });
      } else if (message.document?.mime_type?.startsWith("image/") && message.document.file_id) {
        imageFileRefs.push({ fileId: message.document.file_id, mediaType: message.document.mime_type });
      }

      for (const imageFileRef of imageFileRefs) {
        const { fileId, mediaType } = imageFileRef;
        try {
          const cachedUrl = fileUrlCache.get(fileId);
          if (cachedUrl) {
            imageUrls.push({ url: cachedUrl, ...(mediaType ? { mediaType } : {}) });
            continue;
          }
          const file = await apiCall<TelegramFileResponse>("getFile", { file_id: fileId });
          if (!file.file_path) continue;
          const fileUrl = `${apiBaseUrl}/file/bot${botToken}/${file.file_path}`;
          fileUrlCache.set(fileId, fileUrl);
          imageUrls.push({ url: fileUrl, ...(mediaType ? { mediaType } : {}) });
        } catch (error) {
          ctx.log.warn("telegram_image_resolve_failed", {
            adapterId: id,
            chatId,
            fileId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const inboundText = message.text ?? message.caption ?? "";
      if (!inboundText.trim() && imageUrls.length === 0) continue;

      const senderId = String(message.from?.id ?? message.chat.id);
      await ctx.onMessage({
        adapterId: id,
        conversationId: chatId,
        senderId,
        senderDisplayName: renderSender(update),
        text: inboundText,
        images: imageUrls,
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
        allowed_updates: ["message", "callback_query"],
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

  const sendText = async (
    conversationId: string,
    text: string,
    quickActions?: ChannelQuickAction[],
  ): Promise<void> => {
    const inlineKeyboard = toInlineKeyboard(quickActions);
    try {
      await apiCall<TelegramMessageResponse>("sendMessage", {
        chat_id: conversationId,
        text: markdownToTelegramHtml(text),
        parse_mode: "HTML",
        disable_web_page_preview: false,
        ...(inlineKeyboard ? { reply_markup: inlineKeyboard } : {}),
      });
    } catch (error) {
      if (!isEntityParseError(error)) throw error;
      ctx?.log.warn("telegram_parse_mode_fallback_plain", {
        adapterId: id,
        conversationId,
      });
      await apiCall<TelegramMessageResponse>("sendMessage", {
        chat_id: conversationId,
        text,
        disable_web_page_preview: false,
        ...(inlineKeyboard ? { reply_markup: inlineKeyboard } : {}),
      });
    }
  };

  const sendChunkedText = async (
    conversationId: string,
    text: string,
    quickActions?: ChannelQuickAction[],
  ): Promise<void> => {
    const chunks = splitMessage(text);
    for (const [index, chunk] of chunks.entries()) {
      await sendText(
        conversationId,
        chunk,
        index === 0 ? quickActions : undefined,
      );
    }
  };

  const replaceStreamingPreviewWithChunkedFinal = async (
    conversationId: string,
    streamId: string,
    messageId: number | undefined,
    text: string,
    reason: "too_long" | "edit_failed",
  ): Promise<void> => {
    ctx?.log.warn("telegram_streaming_chunked_final_fallback", {
      adapterId: id,
      conversationId,
      streamId,
      reason,
    });
    if (messageId) {
      await apiCall("deleteMessage", {
        chat_id: conversationId,
        message_id: messageId,
      }).catch(async () => {
        await apiCall("editMessageText", {
          chat_id: conversationId,
          message_id: messageId,
          text: "Response continued below.",
          disable_web_page_preview: false,
        }).catch(() => undefined);
      });
    }
    await sendChunkedText(conversationId, text);
  };

  const setTyping = async (state: ChannelTypingState): Promise<void> => {
    if (!state.active) return;
    await apiCall("sendChatAction", {
      chat_id: state.conversationId,
      action: "typing",
    });
  };

  const upsertStreamingMessage = async (state: ChannelStreamingState): Promise<void> => {
    const previous = streamWritesInFlight.get(state.streamId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!state.text && !state.done) return;
        const currentMessageId = streamingMessageIds.get(state.streamId);
        const previewText = state.text ? truncateStreamingPreview(state.text) : "";
        const shouldChunkFinalText = state.done && state.text.length > TELEGRAM_STREAM_EDIT_MAX;
        if (!currentMessageId) {
          if (!state.text) return;
          if (shouldChunkFinalText) {
            await sendChunkedText(state.conversationId, state.text);
            return;
          }
          if (state.done) {
            await sendText(state.conversationId, state.text);
            return;
          }
          const created = await apiCall<TelegramMessageResponse>("sendMessage", {
            chat_id: state.conversationId,
            text: previewText,
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

        if (state.done) {
          if (shouldChunkFinalText) {
            await replaceStreamingPreviewWithChunkedFinal(
              state.conversationId,
              state.streamId,
              currentMessageId,
              state.text,
              "too_long",
            );
            streamingMessageIds.delete(state.streamId);
            return;
          }
          try {
            await apiCall("editMessageText", {
              chat_id: state.conversationId,
              message_id: currentMessageId,
              text: markdownToTelegramHtml(state.text),
              parse_mode: "HTML",
              disable_web_page_preview: false,
            });
          } catch (error) {
            if (isEntityParseError(error)) {
              ctx?.log.warn("telegram_parse_mode_fallback_plain_edit", {
                adapterId: id,
                conversationId: state.conversationId,
                streamId: state.streamId,
              });
              try {
                await apiCall("editMessageText", {
                  chat_id: state.conversationId,
                  message_id: currentMessageId,
                  text: state.text,
                  disable_web_page_preview: false,
                });
              } catch (plainError) {
                if (!isMessageTooLongError(plainError)) throw plainError;
                await replaceStreamingPreviewWithChunkedFinal(
                  state.conversationId,
                  state.streamId,
                  currentMessageId,
                  state.text,
                  "too_long",
                );
              }
            } else if (isMessageTooLongError(error)) {
              await replaceStreamingPreviewWithChunkedFinal(
                state.conversationId,
                state.streamId,
                currentMessageId,
                state.text,
                "too_long",
              );
            } else {
              throw error;
            }
          }
        } else {
          await apiCall("editMessageText", {
            chat_id: state.conversationId,
            message_id: currentMessageId,
            text: previewText,
            disable_web_page_preview: false,
          });
        }
        if (state.done) {
          streamingMessageIds.delete(state.streamId);
        }
      });
    streamWritesInFlight.set(state.streamId, next);
    try {
      await next;
    } finally {
      if (streamWritesInFlight.get(state.streamId) === next) {
        streamWritesInFlight.delete(state.streamId);
      }
    }
  };

  return {
    id,
    supportsQuickActions: true,
    start: async (context) => {
      ctx = context;
      running = true;
      context.log.info("telegram_adapter_started", {
        adapterId: id,
        pollTimeoutSeconds,
        pollIntervalMs,
        filteredChatCount: allowed?.size ?? 0,
      });
      if (commands.length > 0) {
        try {
          await apiCall("setMyCommands", {
            commands: commands.map((entry) => ({
              command: entry.command,
              description: entry.description,
            })),
          });
          context.log.info("telegram_commands_registered", {
            adapterId: id,
            commandCount: commands.length,
          });
        } catch (error) {
          context.log.warn("telegram_commands_register_failed", {
            adapterId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      void pollLoop();
    },
    stop: async () => {
      running = false;
      pollAbort?.abort();
      pollAbort = null;
      streamingMessageIds.clear();
      streamWritesInFlight.clear();
      ctx?.log.info("telegram_adapter_stopped", { adapterId: id });
      ctx = null;
    },
    sendMessage: async (message: ChannelOutboundMessage) => {
      await sendChunkedText(message.conversationId, message.text, message.quickActions);
    },
    setTyping,
    upsertStreamingMessage,
  };
};
