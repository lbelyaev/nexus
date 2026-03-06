import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "@nexus/types";
import type { ChannelAdapter, ChannelAdapterContext, ChannelOutboundMessage } from "../types.js";
import { createChannelManager } from "../manager.js";

const createGatewayClientMock = vi.hoisted(() => vi.fn());

vi.mock("../gatewayClient.js", () => ({
  createGatewayClient: (...args: unknown[]) => createGatewayClientMock(...args),
}));

interface GatewayHandlers {
  onEvent?: (event: GatewayEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

const createMockGateway = () => {
  const handlers: GatewayHandlers = {};
  let open = false;
  const gatewayClient = {
    connect: vi.fn(async () => {
      open = true;
      handlers.onOpen?.();
    }),
    close: vi.fn(() => {
      open = false;
      handlers.onClose?.();
    }),
    send: vi.fn((_message: unknown) => {
      if (!open) {
        throw new Error("Gateway websocket is not connected");
      }
    }),
    onEvent: vi.fn((handler: (event: GatewayEvent) => void) => {
      handlers.onEvent = handler;
    }),
    onOpen: vi.fn((handler: () => void) => {
      handlers.onOpen = handler;
    }),
    onClose: vi.fn((handler: () => void) => {
      handlers.onClose = handler;
    }),
    onError: vi.fn((handler: (error: Error) => void) => {
      handlers.onError = handler;
    }),
    isOpen: vi.fn(() => open),
  };

  return { gatewayClient, handlers };
};

const wireAuthFlow = (
  gatewayClient: { send: ReturnType<typeof vi.fn> },
  handlers: GatewayHandlers,
) => {
  let challengeCounter = 1;
  gatewayClient.send.mockImplementation((payload: unknown) => {
    const message = payload as {
      type?: string;
      principalType?: "user" | "service_account";
      principalId?: string;
      challengeId?: string;
    };
    if (message.type !== "auth_proof") return;

    const principalType = message.principalType ?? "user";
    const principalId = message.principalId ?? "unknown";
    if (!message.challengeId) {
      const challengeId = `challenge-${challengeCounter}`;
      const nonce = `nonce-${challengeCounter}`;
      challengeCounter += 1;
      handlers.onEvent?.({
        type: "auth_challenge",
        algorithm: "ed25519",
        challengeId,
        nonce,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      handlers.onEvent?.({
        type: "auth_result",
        ok: false,
        principalType,
        principalId,
        message: "Auth challenge is missing or expired; requested a new challenge.",
      });
      return;
    }

    handlers.onEvent?.({
      type: "auth_result",
      ok: true,
      principalType,
      principalId,
      message: "Authenticated connection principal.",
    });
  });
};

const createAdapter = () => {
  let context: ChannelAdapterContext | undefined;
  const sendMessage = vi.fn(async (_message: ChannelOutboundMessage) => undefined);
  const setTyping = vi.fn(async () => undefined);
  const upsertStreamingMessage = vi.fn(async () => undefined);
  const supportsQuickActions = false;
  const adapter: ChannelAdapter = {
    id: "telegram-test",
    supportsQuickActions,
    start: vi.fn(async (ctx: ChannelAdapterContext) => {
      context = ctx;
    }),
    stop: vi.fn(async () => undefined),
    sendMessage,
    setTyping,
    upsertStreamingMessage,
  };
  return {
    adapter,
    sendMessage,
    setTyping,
    upsertStreamingMessage,
    getContext: () => context,
  };
};

describe("createChannelManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a session then forwards inbound prompt to gateway", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const inboundPromise = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "hello nexus",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_new",
        runtimeId: undefined,
        model: undefined,
        workspaceId: undefined,
        principalType: "user",
        principalId: "user:telegram-test:user-1",
        source: "api",
      });
    });

    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-1",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });

    await inboundPromise;

    expect(gatewayClient.send).toHaveBeenCalledWith({
      type: "prompt",
      sessionId: "gw-session-1",
      text: "hello nexus",
      images: undefined,
    });

    await manager.stop();
  });

  it("restores persisted conversation bindings and reuses session after restart", async () => {
    const { gatewayClient } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();
    const bindingStore = {
      getChannelBinding: vi.fn(() => ({
        adapterId: "telegram-test",
        conversationId: "chat-persisted",
        sessionId: "gw-session-persisted",
        principalType: "user" as const,
        principalId: "user:telegram-test:user-1",
        runtimeId: "claude",
        model: "claude-sonnet-4-6",
        workspaceId: "default",
        typingIndicator: true,
        streamingMode: "off" as const,
        steeringMode: "off" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:05:00Z",
      })),
      upsertChannelBinding: vi.fn(),
      deleteChannelBinding: vi.fn(),
    };

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
      bindingStore,
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-persisted",
      senderId: "user-1",
      text: "continue",
    });

    expect(bindingStore.getChannelBinding).toHaveBeenCalledWith("telegram-test", "chat-persisted");
    expect(gatewayClient.send).toHaveBeenCalledWith({
      type: "prompt",
      sessionId: "gw-session-persisted",
      text: "continue",
      images: undefined,
    });
    expect(
      gatewayClient.send.mock.calls.filter(
        ([payload]) => (payload as { type?: string }).type === "session_new",
      ),
    ).toHaveLength(0);

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-persisted",
      senderId: "user-1",
      text: "/new",
    });
    expect(bindingStore.deleteChannelBinding).toHaveBeenCalledWith("telegram-test", "chat-persisted");

    await manager.stop();
  });

  it("maps prompt timeout errors to user-friendly channel message", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const inboundPromise = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "run a long query",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-2",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await inboundPromise;

    handlers.onEvent?.({
      type: "error",
      sessionId: "gw-session-2",
      message: 'RPC request "session/prompt" (id=5) timed out after 300000ms',
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-1",
        text: "Response timed out. You can retry, use /cancel, or send a new message to steer.",
      });
    });

    await manager.stop();
  });

  it("surfaces session_invalidated as cold-recovery notice", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const inboundPromise = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-invalidate",
      senderId: "user-1",
      text: "hello",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });

    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-invalidate",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await inboundPromise;

    handlers.onEvent?.({
      type: "session_invalidated",
      sessionId: "gw-session-invalidate",
      reason: "runtime_state_lost",
      message: "Session runtime state was lost after restart and cold-restored.",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: "chat-invalidate",
        text: expect.stringContaining("Session runtime restarted"),
      }));
    });

    await manager.stop();
  });

  it("queues prompts while disconnected and flushes them after reconnect", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      reconnectDelayMs: 30,
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const firstPrompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-reconnect-queue",
      senderId: "user-1",
      text: "first",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-reconnect-1",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await firstPrompt;

    gatewayClient.close();

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-reconnect-queue",
      senderId: "user-1",
      text: "second while disconnected",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-reconnect-queue",
        text: "Nexus is reconnecting. I will send your message when the connection is back.",
      });
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "prompt",
        sessionId: "gw-session-reconnect-1",
        text: "second while disconnected",
        images: undefined,
      });
    });

    await manager.stop();
  });

  it("retries once when gateway reports missing session", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const inboundPromise = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "hello once",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-1",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await inboundPromise;

    handlers.onEvent?.({
      type: "error",
      sessionId: "gw-session-1",
      message: "Session not found: gw-session-1",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-1",
        text: "Session was reset on gateway. Retrying your last message once...",
      });
    });

    await vi.waitFor(() => {
      const sessionNewCalls = gatewayClient.send.mock.calls.filter(
        ([payload]) => (payload as { type?: string }).type === "session_new",
      );
      expect(sessionNewCalls.length).toBeGreaterThanOrEqual(2);
    });

    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-2",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "prompt",
        sessionId: "gw-session-2",
        text: "hello once",
        images: undefined,
      });
    });

    await manager.stop();
  });

  it("retries once when gateway reports closed non-resumable session", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const inboundPromise = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-closed",
      senderId: "user-1",
      text: "resume me",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-closed-1",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await inboundPromise;

    handlers.onEvent?.({
      type: "error",
      sessionId: "gw-session-closed-1",
      message: "Session is closed and cannot be resumed. Start a new session.",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-closed",
        text: "Session was reset on gateway. Retrying your last message once...",
      });
    });

    await vi.waitFor(() => {
      const sessionNewCalls = gatewayClient.send.mock.calls.filter(
        ([payload]) => (payload as { type?: string }).type === "session_new",
      );
      expect(sessionNewCalls.length).toBeGreaterThanOrEqual(2);
    });

    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-closed-2",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "prompt",
        sessionId: "gw-session-closed-2",
        text: "resume me",
        images: undefined,
      });
    });

    await manager.stop();
  });

  it("queues steer and auto-prompts queued message after turn_end when steering mode is enabled", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{
        adapter: adapterFixture.adapter,
        route: { steeringMode: "on" },
      }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const firstPrompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "first",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-1",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await firstPrompt;

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "prompt",
        sessionId: "gw-session-1",
        text: "first",
        images: undefined,
      });
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "second steer",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "cancel",
        sessionId: "gw-session-1",
      });
    });
    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-1",
        text: "Steering queued. Cancelling current turn...",
      });
    });

    handlers.onEvent?.({
      type: "turn_end",
      sessionId: "gw-session-1",
      stopReason: "cancelled",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "prompt",
        sessionId: "gw-session-1",
        text: "second steer",
        images: undefined,
      });
    });

    await manager.stop();
  });

  it("supports /approve all with optionId and clears pending approvals", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "needs tools",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-1",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "approval_request",
      sessionId: "gw-session-1",
      requestId: "req-1",
      tool: "Read /tmp/a.ts",
      description: "Read file",
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
      ],
    });
    handlers.onEvent?.({
      type: "approval_request",
      sessionId: "gw-session-1",
      requestId: "req-2",
      tool: "Read /tmp/b.ts",
      description: "Read file",
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
      ],
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "/approve all",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "approval_response",
        requestId: "req-1",
        optionId: "allow_once",
      });
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "approval_response",
        requestId: "req-2",
        optionId: "allow_once",
      });
    });
    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-1",
        text: "Approved 2 request(s).",
      });
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "/approve req-1",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-1",
        text: "No pending approval request: req-1",
      });
    });

    await manager.stop();
  });

  it("handles /usage locally and renders usage_result summary", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-usage",
      senderId: "user-1",
      text: "seed usage session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-usage",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    gatewayClient.send.mockClear();
    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-usage",
      senderId: "user-1",
      text: "/usage",
    });

    expect(gatewayClient.send).toHaveBeenCalledWith({
      type: "usage_query",
      sessionId: "gw-session-usage",
      action: "summary",
    });

    handlers.onEvent?.({
      type: "usage_result",
      sessionId: "gw-session-usage",
      action: "summary",
      summary: {
        tokens: { input: 10, output: 5, total: 15 },
        executions: {
          total: 3,
          queued: 1,
          running: 0,
          succeeded: 2,
          failed: 0,
          cancelled: 0,
          timedOut: 0,
        },
      },
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-usage",
        text: "Usage summary:\ntokens=input:10, output:5, total:15\nexecutions=total:3, queued:1, running:0, succeeded:2, failed:0, cancelled:0, timed_out:0",
      });
    });

    await manager.stop();
  });

  it("parses /usage search scope and forwards usage_query", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-usage-search",
      senderId: "user-1",
      text: "seed search session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-usage-search",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    gatewayClient.send.mockClear();
    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-usage-search",
      senderId: "user-1",
      text: "/usage search retries workspace",
    });

    expect(gatewayClient.send).toHaveBeenCalledWith({
      type: "usage_query",
      sessionId: "gw-session-usage-search",
      action: "search",
      query: "retries",
      scope: "workspace",
    });

    await manager.stop();
  });

  it("handles /session list and renders scoped session rows", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    wireAuthFlow(gatewayClient, handlers);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-list",
      senderId: "user-1",
      text: "seed list session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-list-active",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:telegram-test:user-1",
      source: "api",
    });
    await prompt;

    gatewayClient.send.mockClear();
    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-list",
      senderId: "user-1",
      text: "/session list 5",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "auth_proof",
        principalType: "user",
        principalId: "user:telegram-test:user-1",
      }));
      expect(gatewayClient.send).toHaveBeenCalledWith({ type: "session_list", limit: 5 });
    });

    handlers.onEvent?.({
      type: "session_list",
      sessions: [
        {
          id: "gw-session-list-active",
          status: "active",
          model: "claude-sonnet-4-6",
          workspaceId: "default",
          principalType: "user",
          principalId: "user:telegram-test:user-1",
          source: "api",
          createdAt: "2026-03-01T00:00:00.000Z",
          lastActivityAt: "2026-03-04T01:00:00.000Z",
        },
      ],
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-session-list",
        text: [
          "Sessions (1/1):",
          "- gw-session-list-active (current) status=active workspace=default model=claude-sonnet-4-6 last=2026-03-04T01:00:00.000Z",
          "Use /session resume <sessionId> to attach this conversation.",
        ].join("\n"),
      });
    });

    await manager.stop();
  });

  it("handles /session list next using server cursor", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    wireAuthFlow(gatewayClient, handlers);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-list-next",
      senderId: "user-1",
      text: "seed list session next",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-list-next-active",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:telegram-test:user-1",
      source: "api",
    });
    await prompt;

    gatewayClient.send.mockClear();
    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-list-next",
      senderId: "user-1",
      text: "/session list 2",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({ type: "session_list", limit: 2 });
    });

    handlers.onEvent?.({
      type: "session_list",
      hasMore: true,
      nextCursor: "cursor-2",
      sessions: [
        {
          id: "gw-session-list-next-active",
          status: "active",
          model: "claude-sonnet-4-6",
          workspaceId: "default",
          principalType: "user",
          principalId: "user:telegram-test:user-1",
          source: "api",
          createdAt: "2026-03-01T00:00:00.000Z",
          lastActivityAt: "2026-03-04T01:00:00.000Z",
        },
      ],
    });

    gatewayClient.send.mockClear();
    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-list-next",
      senderId: "user-1",
      text: "/session list next",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_list",
        limit: 2,
        cursor: "cursor-2",
      });
    });

    await manager.stop();
  });

  it("resumes conversation binding with /session resume", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    wireAuthFlow(gatewayClient, handlers);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-resume",
      senderId: "user-1",
      text: "seed resume session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-local",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:telegram-test:user-1",
      source: "api",
    });
    await prompt;

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-resume",
      senderId: "user-1",
      text: "/session resume gw-session-archive",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "auth_proof",
        principalType: "user",
        principalId: "user:telegram-test:user-1",
      }));
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_replay",
        sessionId: "gw-session-archive",
      });
    });

    handlers.onEvent?.({
      type: "transcript",
      sessionId: "gw-session-archive",
      messages: [],
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-resume",
      senderId: "user-1",
      text: "post-resume prompt",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "prompt",
        sessionId: "gw-session-archive",
        text: "post-resume prompt",
        images: undefined,
      });
    });

    await manager.stop();
  });

  it("uses session_takeover message for /session takeover", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    wireAuthFlow(gatewayClient, handlers);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-session-takeover",
      senderId: "user-1",
      text: "/session takeover gw-session-parked",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "auth_proof",
        principalType: "user",
        principalId: "user:telegram-test:user-1",
      }));
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_takeover",
        sessionId: "gw-session-parked",
      });
    });

    handlers.onEvent?.({
      type: "transcript",
      sessionId: "gw-session-parked",
      messages: [],
    });

    await manager.stop();
  });

  it("sends routed runtime/model/workspace on session creation", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{
        adapter: adapterFixture.adapter,
        route: {
          runtimeId: "codex",
          model: "gpt-5.3-codex",
          workspaceId: "research",
        },
      }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const inboundPromise = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-route",
      senderId: "user-1",
      text: "route me",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_new",
        runtimeId: "codex",
        model: "gpt-5.3-codex",
        workspaceId: "research",
        principalType: "user",
        principalId: "user:telegram-test:user-1",
        source: "api",
      });
    });

    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-route",
      runtimeId: "codex",
      model: "gpt-5.3-codex",
      workspaceId: "research",
    });
    await inboundPromise;

    await manager.stop();
  });

  it("uses adapter quick actions for approval requests when supported", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();
    adapterFixture.adapter.supportsQuickActions = true;

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-qa",
      senderId: "user-1",
      text: "need approval",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-qa",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "approval_request",
      sessionId: "gw-session-qa",
      requestId: "req-qa-1",
      tool: "Read /tmp/very/long/path/to/file.ts",
      description: "Read file",
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
      ],
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-qa",
        text: "Approval required: Read file.ts",
        quickActions: [
          { label: "Approve", command: "/approve req-qa-1" },
          { label: "Approve All", command: "/approve all" },
          { label: "Deny", command: "/deny req-qa-1" },
        ],
      });
    });

    await manager.stop();
  });

  it("queues approval prompts and surfaces next prompt after single approval", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();
    adapterFixture.adapter.supportsQuickActions = true;

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-approval-queue",
      senderId: "user-1",
      text: "need multiple approvals",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-approval-queue",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "approval_request",
      sessionId: "gw-session-approval-queue",
      requestId: "req-queue-1",
      tool: "Bash",
      description: "Run command",
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
      ],
    });
    handlers.onEvent?.({
      type: "approval_request",
      sessionId: "gw-session-approval-queue",
      requestId: "req-queue-2",
      tool: "Read /tmp/b.ts",
      description: "Read file",
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
      ],
    });

    await vi.waitFor(() => {
      const approvalMessages = adapterFixture.sendMessage.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg.conversationId === "chat-approval-queue" && msg.text.startsWith("Approval required:"));
      expect(approvalMessages).toHaveLength(1);
      expect(approvalMessages[0]).toMatchObject({
        text: "Approval required: Bash",
      });
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-approval-queue",
      senderId: "user-1",
      text: "/approve req-queue-1",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "approval_response",
        requestId: "req-queue-1",
        optionId: "allow_once",
      });
    });
    expect(
      adapterFixture.sendMessage.mock.calls.some(([msg]) => (
        msg.conversationId === "chat-approval-queue" && msg.text === "Approved Bash."
      )),
    ).toBe(false);

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-approval-queue",
        text: "Approval required: Read b.ts",
        quickActions: [
          { label: "Approve", command: "/approve req-queue-2" },
          { label: "Approve All", command: "/approve all" },
          { label: "Deny", command: "/deny req-queue-2" },
        ],
      });
    });

    await manager.stop();
  });

  it("streams assistant text via adapter upsert when streaming mode is edit", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{
        adapter: adapterFixture.adapter,
        route: { streamingMode: "edit" },
      }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-stream",
      senderId: "user-1",
      text: "stream me",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-stream",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "text_delta",
      sessionId: "gw-session-stream",
      delta: "Hello ",
    });
    handlers.onEvent?.({
      type: "text_delta",
      sessionId: "gw-session-stream",
      delta: "world",
    });
    handlers.onEvent?.({
      type: "turn_end",
      sessionId: "gw-session-stream",
      stopReason: "end_turn",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.upsertStreamingMessage).toHaveBeenCalledWith({
        conversationId: "chat-stream",
        streamId: "gw-session-stream",
        text: "Hello world",
        done: true,
      });
    });
    expect(
      adapterFixture.sendMessage.mock.calls.some(
        ([payload]) =>
          (payload as ChannelOutboundMessage).conversationId === "chat-stream"
          && (payload as ChannelOutboundMessage).text === "Hello world",
      ),
    ).toBe(false);

    await manager.stop();
  });

  it("toggles typing indicator around prompt/turn lifecycle", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-typing",
      senderId: "user-1",
      text: "typing test",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-typing",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    await vi.waitFor(() => {
      expect(adapterFixture.setTyping).toHaveBeenCalledWith({
        conversationId: "chat-typing",
        active: true,
      });
    });

    handlers.onEvent?.({
      type: "turn_end",
      sessionId: "gw-session-typing",
      stopReason: "end_turn",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.setTyping).toHaveBeenCalledWith({
        conversationId: "chat-typing",
        active: false,
      });
    });

    await manager.stop();
  });

  it("respects typingIndicator=false route override", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{
        adapter: adapterFixture.adapter,
        route: { typingIndicator: false },
      }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-notyping",
      senderId: "user-1",
      text: "no typing",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-notyping",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "text_delta",
      sessionId: "gw-session-notyping",
      delta: "hello",
    });
    handlers.onEvent?.({
      type: "turn_end",
      sessionId: "gw-session-notyping",
      stopReason: "end_turn",
    });

    expect(adapterFixture.setTyping).not.toHaveBeenCalled();

    await manager.stop();
  });

  it("authenticates transfer requester and forwards /session transfer request", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    wireAuthFlow(gatewayClient, handlers);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-request",
      senderId: "user-1",
      text: "seed session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-owner",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-request",
      senderId: "user-1",
      text: "/session transfer request user:telegram-test:user-2 user 90000",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "auth_proof",
        principalType: "user",
        principalId: "user:telegram-test:user-1",
      }));
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_transfer_request",
        sessionId: "gw-session-owner",
        targetPrincipalType: "user",
        targetPrincipalId: "user:telegram-test:user-2",
        expiresInMs: 90000,
      });
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-transfer-request",
        text: "Transfer requested for session gw-session-owner -> user:telegram-test:user-2 (ttl=90000ms)",
      });
    });

    await manager.stop();
  });

  it("retries transfer auth when gateway rotates challenge after missing/expired result", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    let challengeCounter = 1;
    let signedAttempt = 0;
    gatewayClient.send.mockImplementation((payload: unknown) => {
      const message = payload as {
        type?: string;
        principalType?: "user" | "service_account";
        principalId?: string;
        challengeId?: string;
      };
      if (message.type !== "auth_proof") return;

      const principalType = message.principalType ?? "user";
      const principalId = message.principalId ?? "unknown";
      if (!message.challengeId) {
        const challengeId = `challenge-${challengeCounter}`;
        const nonce = `nonce-${challengeCounter}`;
        challengeCounter += 1;
        handlers.onEvent?.({
          type: "auth_challenge",
          algorithm: "ed25519",
          challengeId,
          nonce,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return;
      }

      signedAttempt += 1;
      if (signedAttempt === 1) {
        // Simulate gateway rotating challenge after rejecting the signed proof.
        handlers.onEvent?.({
          type: "auth_result",
          ok: false,
          principalType,
          principalId,
          message: "Auth challenge is missing or expired; requested a new challenge.",
        });
        handlers.onEvent?.({
          type: "auth_challenge",
          algorithm: "ed25519",
          challengeId: "challenge-2",
          nonce: "nonce-2",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return;
      }

      handlers.onEvent?.({
        type: "auth_result",
        ok: true,
        principalType,
        principalId,
        message: "Authenticated connection principal.",
      });
    });

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-retry",
      senderId: "user-1",
      text: "seed session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-owner-retry",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-retry",
      senderId: "user-1",
      text: "/transfer request user:telegram-test:user-2 user 90000",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "session_transfer_request",
        sessionId: "gw-session-owner-retry",
        targetPrincipalType: "user",
        targetPrincipalId: "user:telegram-test:user-2",
        expiresInMs: 90000,
      }));
    });
    expect(signedAttempt).toBeGreaterThanOrEqual(2);

    await manager.stop();
  });

  it("retries transfer auth when gateway resends active challenge", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    let challengeCounter = 1;
    let signedAttempt = 0;
    gatewayClient.send.mockImplementation((payload: unknown) => {
      const message = payload as {
        type?: string;
        principalType?: "user" | "service_account";
        principalId?: string;
        challengeId?: string;
      };
      if (message.type !== "auth_proof") return;

      const principalType = message.principalType ?? "user";
      const principalId = message.principalId ?? "unknown";
      if (!message.challengeId) {
        const challengeId = `challenge-${challengeCounter}`;
        const nonce = `nonce-${challengeCounter}`;
        challengeCounter += 1;
        handlers.onEvent?.({
          type: "auth_challenge",
          algorithm: "ed25519",
          challengeId,
          nonce,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return;
      }

      signedAttempt += 1;
      if (signedAttempt === 1) {
        handlers.onEvent?.({
          type: "auth_result",
          ok: false,
          principalType,
          principalId,
          message: "Auth challenge required; resent active challenge.",
        });
        handlers.onEvent?.({
          type: "auth_challenge",
          algorithm: "ed25519",
          challengeId: message.challengeId,
          nonce: "nonce-reissued",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return;
      }

      handlers.onEvent?.({
        type: "auth_result",
        ok: true,
        principalType,
        principalId,
        message: "Authenticated connection principal.",
      });
    });

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-retry-resent",
      senderId: "user-1",
      text: "seed session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-owner-retry-resent",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-retry-resent",
      senderId: "user-1",
      text: "/transfer request user:telegram-test:user-2 user 90000",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "session_transfer_request",
        sessionId: "gw-session-owner-retry-resent",
        targetPrincipalType: "user",
        targetPrincipalId: "user:telegram-test:user-2",
        expiresInMs: 90000,
      }));
    });
    expect(signedAttempt).toBeGreaterThanOrEqual(2);

    await manager.stop();
  });

  it("ignores stale probe auth_result errors and succeeds on signed proof", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    let challengeCounter = 1;
    let signedAttempt = 0;
    gatewayClient.send.mockImplementation((payload: unknown) => {
      const message = payload as {
        type?: string;
        principalType?: "user" | "service_account";
        principalId?: string;
        challengeId?: string;
      };
      if (message.type !== "auth_proof") return;

      const principalType = message.principalType ?? "user";
      const principalId = message.principalId ?? "unknown";
      if (!message.challengeId) {
        const challengeId = `challenge-${challengeCounter}`;
        const nonce = `nonce-${challengeCounter}`;
        challengeCounter += 1;
        handlers.onEvent?.({
          type: "auth_challenge",
          algorithm: "ed25519",
          challengeId,
          nonce,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        // Simulate older gateway behavior that also emits a probe-side auth_result failure.
        handlers.onEvent?.({
          type: "auth_result",
          ok: false,
          principalType,
          principalId,
          message: "Auth challenge required; resent active challenge.",
        });
        return;
      }

      signedAttempt += 1;
      handlers.onEvent?.({
        type: "auth_result",
        ok: true,
        principalType,
        principalId,
        message: "Authenticated connection principal.",
      });
    });

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-stale-probe-result",
      senderId: "user-1",
      text: "seed session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-owner-stale-probe",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-stale-probe-result",
      senderId: "user-1",
      text: "/transfer request user:telegram-test:user-2 user 90000",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "session_transfer_request",
        sessionId: "gw-session-owner-stale-probe",
        targetPrincipalType: "user",
        targetPrincipalId: "user:telegram-test:user-2",
        expiresInMs: 90000,
      }));
    });
    expect(signedAttempt).toBeGreaterThanOrEqual(1);

    await manager.stop();
  });

  it("accepts pending transfer and rebinds conversation session on session_transferred", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    wireAuthFlow(gatewayClient, handlers);
    const adapterFixture = createAdapter();
    adapterFixture.adapter.supportsQuickActions = true;

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-accept",
      senderId: "user-1",
      text: "seed session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-local",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "session_transfer_requested",
      sessionId: "gw-session-shared",
      fromPrincipalType: "user",
      fromPrincipalId: "user:web:user-1",
      targetPrincipalType: "user",
      targetPrincipalId: "user:telegram-test:user-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith({
        conversationId: "chat-transfer-accept",
        text: "Session transfer request received.\nsession=gw-session-shared\nfrom=user:web:user-1",
        quickActions: [
          { label: "Accept", command: "/session transfer accept gw-session-shared" },
          { label: "Dismiss", command: "/session transfer dismiss gw-session-shared" },
        ],
      });
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-accept",
      senderId: "user-1",
      text: "/session transfer accept",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_transfer_accept",
        sessionId: "gw-session-shared",
      });
    });

    handlers.onEvent?.({
      type: "session_transferred",
      sessionId: "gw-session-shared",
      fromPrincipalType: "user",
      fromPrincipalId: "user:web:user-1",
      targetPrincipalType: "user",
      targetPrincipalId: "user:telegram-test:user-1",
      transferredAt: new Date().toISOString(),
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-accept",
      senderId: "user-1",
      text: "after transfer",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "prompt",
        sessionId: "gw-session-shared",
        text: "after transfer",
        images: undefined,
      });
    });

    await manager.stop();
  });

  it("forwards /session transfer dismiss to gateway and handles transfer update", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    wireAuthFlow(gatewayClient, handlers);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-dismiss",
      senderId: "user-1",
      text: "seed session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-local",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "session_transfer_requested",
      sessionId: "gw-session-shared",
      fromPrincipalType: "user",
      fromPrincipalId: "user:web:user-1",
      targetPrincipalType: "user",
      targetPrincipalId: "user:telegram-test:user-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-dismiss",
      senderId: "user-1",
      text: "/session transfer dismiss gw-session-shared",
    });

    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith({
        type: "session_transfer_dismiss",
        sessionId: "gw-session-shared",
      });
    });

    handlers.onEvent?.({
      type: "session_transfer_updated",
      sessionId: "gw-session-shared",
      fromPrincipalType: "user",
      fromPrincipalId: "user:web:user-1",
      targetPrincipalType: "user",
      targetPrincipalId: "user:telegram-test:user-1",
      state: "dismissed",
      updatedAt: new Date().toISOString(),
      reason: "target_dismissed",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: "chat-transfer-dismiss",
        text: "Transfer update for session gw-session-shared: dismissed (target dismissed).",
      }));
    });

    await manager.stop();
  });

  it("detaches source conversation session after transfer away", async () => {
    const { gatewayClient, handlers } = createMockGateway();
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const adapterFixture = createAdapter();

    const manager = createChannelManager({
      gatewayUrl: "ws://127.0.0.1:18800/ws",
      token: "test-token",
      adapters: [{ adapter: adapterFixture.adapter }],
    });

    await manager.start();
    const context = adapterFixture.getContext();
    expect(context).toBeDefined();

    const prompt = context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-away",
      senderId: "user-1",
      text: "seed session",
    });
    await vi.waitFor(() => {
      expect(gatewayClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session_new" }));
    });
    handlers.onEvent?.({
      type: "session_created",
      sessionId: "gw-session-away",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
      workspaceId: "default",
    });
    await prompt;

    handlers.onEvent?.({
      type: "session_transferred",
      sessionId: "gw-session-away",
      fromPrincipalType: "user",
      fromPrincipalId: "user:telegram-test:user-1",
      targetPrincipalType: "user",
      targetPrincipalId: "user:web:user-1",
      transferredAt: new Date().toISOString(),
    });

    await context!.onMessage({
      adapterId: "telegram-test",
      conversationId: "chat-transfer-away",
      senderId: "user-1",
      text: "/status",
    });

    await vi.waitFor(() => {
      expect(adapterFixture.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: "chat-transfer-away",
        text: "No active session for this conversation. Send any prompt to create one.",
      }));
    });

    await manager.stop();
  });
});
