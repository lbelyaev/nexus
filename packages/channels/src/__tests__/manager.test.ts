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
  const adapter: ChannelAdapter = {
    id: "telegram-test",
    start: vi.fn(async (ctx: ChannelAdapterContext) => {
      context = ctx;
    }),
    stop: vi.fn(async () => undefined),
    sendMessage,
  };
  return {
    adapter,
    sendMessage,
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
});
