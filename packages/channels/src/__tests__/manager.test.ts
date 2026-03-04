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
  const gatewayClient = {
    connect: vi.fn(async () => {
      handlers.onOpen?.();
    }),
    close: vi.fn(() => {
      handlers.onClose?.();
    }),
    send: vi.fn(),
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
    isOpen: vi.fn(() => true),
  };

  return { gatewayClient, handlers };
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
        text: "Approval required: Read file.ts\nTap Approve or Deny below.",
        quickActions: [
          { label: "Approve", command: "/approve req-qa-1" },
          { label: "Deny", command: "/deny req-qa-1" },
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
});
