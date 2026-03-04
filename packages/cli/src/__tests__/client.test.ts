import { describe, expect, it, vi } from "vitest";
import type { GatewayEvent } from "@nexus/types";
import { createNexusCliClient } from "../client.js";

type Handler = (...args: unknown[]) => void;

const wsMock = vi.hoisted(() => {
  const instances: Array<{
    url: string;
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    on: (event: string, handler: Handler) => void;
    emit: (event: string, ...args: unknown[]) => void;
    close: () => void;
  }> = [];

  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;

    readonly url: string;
    readyState = MockWebSocket.CONNECTING;
    readonly send = vi.fn();
    private readonly handlers = new Map<string, Handler[]>();

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    on(event: string, handler: Handler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    emit(event: string, ...args: unknown[]): void {
      const list = this.handlers.get(event) ?? [];
      for (const handler of list) {
        handler(...args);
      }
    }

    close(): void {
      this.readyState = 3;
      this.emit("close");
    }
  }

  return { MockWebSocket, instances };
});

vi.mock("ws", () => ({
  default: wsMock.MockWebSocket,
}));

const latestSocket = () => {
  const socket = wsMock.instances.at(-1);
  if (!socket) throw new Error("No mock socket created");
  return socket;
};

describe("createNexusCliClient", () => {
  it("connects and appends auth token to websocket URL", async () => {
    const client = createNexusCliClient({
      url: "ws://127.0.0.1:18800/ws",
      token: "tok-value",
    });
    const onOpen = vi.fn();
    client.onOpen(onOpen);

    const connectPromise = client.connect();
    const socket = latestSocket();
    expect(socket.url).toContain("token=tok-value");
    socket.readyState = wsMock.MockWebSocket.OPEN;
    socket.emit("open");
    await connectPromise;

    expect(onOpen).toHaveBeenCalledOnce();
    expect(client.isOpen()).toBe(true);
  });

  it("throws when sending before websocket is open", () => {
    const client = createNexusCliClient({
      url: "ws://127.0.0.1:18800/ws",
      token: "tok-value",
    });

    expect(() => {
      client.send({ type: "session_new" });
    }).toThrow(/not connected/i);
  });

  it("parses gateway events and tracks session id", async () => {
    const client = createNexusCliClient({
      url: "ws://127.0.0.1:18800/ws",
      token: "tok-value",
    });
    const events: GatewayEvent[] = [];
    client.onEvent((event) => events.push(event));

    const connectPromise = client.connect();
    const socket = latestSocket();
    socket.readyState = wsMock.MockWebSocket.OPEN;
    socket.emit("open");
    await connectPromise;

    socket.emit("message", JSON.stringify({
      type: "session_created",
      sessionId: "gw-1",
      runtimeId: "claude",
      model: "claude-sonnet-4-6",
    }));
    socket.emit("message", JSON.stringify({
      type: "turn_end",
      sessionId: "gw-1",
      stopReason: "end_turn",
    }));

    expect(client.getSessionId()).toBe("gw-1");
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("session_created");
  });
});
