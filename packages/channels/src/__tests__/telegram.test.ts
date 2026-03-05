import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramAdapter } from "../adapters/telegram.js";

const jsonResponse = (result: unknown): Response =>
  new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("createTelegramAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends final messages with Telegram HTML parse mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 11 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({ botToken: "token" });
    await adapter.sendMessage({
      conversationId: "chat-1",
      text: "Hello **world**",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toBe("Hello <b>world</b>");
  });

  it("falls back to plain text when Telegram rejects formatted entities", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Bad Request: can't parse entities", { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ message_id: 22 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({ botToken: "token" });
    await adapter.sendMessage({
      conversationId: "chat-2",
      text: "Broken ** markdown",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstPayload.parse_mode).toBe("HTML");
    expect(secondPayload.parse_mode).toBeUndefined();
    expect(secondPayload.text).toBe("Broken ** markdown");
  });

  it("formats only the final streaming edit", async () => {
    const fetchMock = vi.fn()
      // initial sendMessage (plain)
      .mockResolvedValueOnce(jsonResponse({ message_id: 33 }))
      // in-flight editMessageText (plain)
      .mockResolvedValueOnce(jsonResponse(true))
      // final editMessageText (formatted)
      .mockResolvedValueOnce(jsonResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({ botToken: "token" });
    await adapter.upsertStreamingMessage?.({
      conversationId: "chat-3",
      streamId: "stream-1",
      text: "Hello **world**",
      done: false,
    });
    await adapter.upsertStreamingMessage?.({
      conversationId: "chat-3",
      streamId: "stream-1",
      text: "Hello **world**",
      done: false,
    });
    await adapter.upsertStreamingMessage?.({
      conversationId: "chat-3",
      streamId: "stream-1",
      text: "Hello **world**",
      done: true,
    });

    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const thirdPayload = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));

    expect(firstPayload.parse_mode).toBeUndefined();
    expect(secondPayload.parse_mode).toBeUndefined();
    expect(thirdPayload.parse_mode).toBe("HTML");
    expect(thirdPayload.text).toBe("Hello <b>world</b>");
  });

  it("adds inline keyboard buttons for quick actions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 77 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({ botToken: "token" });
    await adapter.sendMessage({
      conversationId: "chat-7",
      text: "Approval required",
      quickActions: [
        { label: "Approve", command: "/approve req-1" },
        { label: "Deny", command: "/deny req-1" },
      ],
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.reply_markup?.inline_keyboard).toEqual([
      [
        { text: "Approve", callback_data: "nx:/approve req-1" },
        { text: "Deny", callback_data: "nx:/deny req-1" },
      ],
    ]);
  });

  it("maps callback query button presses into inbound slash commands", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const payloadOffset = requestBody.offset as number | undefined;
      const method = String(_url).split("/").at(-1);

      if (method === "getUpdates") {
        if ((payloadOffset ?? 0) >= 2) return jsonResponse([]);
        return jsonResponse([
          {
            update_id: 1,
            callback_query: {
              id: "cb-1",
              data: "nx:/approve req-42",
              from: { id: 9, is_bot: false, first_name: "Leo" },
              message: { message_id: 12, chat: { id: 123, type: "private" } },
            },
          },
        ]);
      }
      if (method === "editMessageReplyMarkup") return jsonResponse(true);
      if (method === "answerCallbackQuery") return jsonResponse(true);
      return jsonResponse(true);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({
      botToken: "token",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 10,
    });
    await adapter.start({
      onMessage,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({
        adapterId: "telegram",
        conversationId: "123",
        senderId: "9",
        senderDisplayName: "Leo",
        text: "/approve req-42",
      });
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/editMessageReplyMarkup"))).toBe(true);
    await adapter.stop();
  });

  it("forwards photo messages as image inputs", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const payloadOffset = requestBody.offset as number | undefined;

      if (method === "getUpdates") {
        if ((payloadOffset ?? 0) >= 2) return jsonResponse([]);
        return jsonResponse([
          {
            update_id: 1,
            message: {
              message_id: 3,
              from: { id: 11, is_bot: false, first_name: "Leo" },
              chat: { id: 456, type: "private" },
              caption: "what is shown here?",
              photo: [
                { file_id: "small", file_unique_id: "s1", width: 320, height: 240, file_size: 1000 },
                { file_id: "big", file_unique_id: "s2", width: 1280, height: 960, file_size: 9999 },
              ],
            },
          },
        ]);
      }
      if (method === "getFile") {
        const fileId = String(requestBody.file_id ?? "");
        if (fileId === "big") return jsonResponse({ file_path: "photos/big.jpg" });
        return jsonResponse({});
      }
      return jsonResponse(true);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({
      botToken: "token",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 10,
    });

    await adapter.start({
      onMessage,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith({
        adapterId: "telegram",
        conversationId: "456",
        senderId: "11",
        senderDisplayName: "Leo",
        text: "what is shown here?",
        images: [{ url: "https://api.telegram.org/file/bottoken/photos/big.jpg", mediaType: "image/jpeg" }],
      });
    });

    await adapter.stop();
  });

  it("serializes concurrent stream updates to avoid duplicate sendMessage calls", async () => {
    let firstSendResolved = false;
    let releaseFirstSend: () => void = () => undefined;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = () => {
        firstSendResolved = true;
        resolve();
      };
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "sendMessage") {
        if (!firstSendResolved) {
          await firstSendGate;
        }
        return jsonResponse({ message_id: 99 });
      }
      if (method === "editMessageText") {
        return jsonResponse(true);
      }
      return jsonResponse(true);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({ botToken: "token" });
    const first = adapter.upsertStreamingMessage?.({
      conversationId: "chat-9",
      streamId: "stream-race",
      text: "hello",
      done: false,
    });
    const second = adapter.upsertStreamingMessage?.({
      conversationId: "chat-9",
      streamId: "stream-race",
      text: "hello world",
      done: false,
    });

    releaseFirstSend();
    await Promise.all([first, second]);

    const methods = fetchMock.mock.calls.map((call) => String(call[0]).split("/").at(-1));
    expect(methods.filter((m) => m === "sendMessage")).toHaveLength(1);
    expect(methods.filter((m) => m === "editMessageText")).toHaveLength(1);
  });

  it("registers slash commands on startup", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "setMyCommands") return jsonResponse(true);
      if (method === "getUpdates") return jsonResponse([]);
      return jsonResponse(true);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTelegramAdapter({
      botToken: "token",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 10,
    });
    await adapter.start({
      onMessage,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes("/setMyCommands"));
      expect(call).toBeDefined();
      const init = call?.[1];
      const rawBody = init && typeof init.body === "string" ? init.body : "{}";
      const payload = JSON.parse(rawBody) as {
        commands?: Array<{ command: string; description: string }>;
      };
      expect(payload.commands?.some((entry) => entry.command === "usage")).toBe(true);
      expect(payload.commands?.some((entry) => entry.command === "commands")).toBe(true);
      expect(payload.commands?.some((entry) => entry.command === "session")).toBe(true);
    });

    await adapter.stop();
  });
});
