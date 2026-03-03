import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayServer, type GatewayServer } from "../server.js";
import type { Router, EventEmitter } from "../router.js";
import type { GatewayEvent } from "@nexus/types";

const TEST_TOKEN = "test-token-abc123";

const mockRouter: Router = {
  registerConnection: () => {},
  unregisterConnection: () => {},
  setRuntimeHealth: (runtimeId, status, reason) => ({
    runtimeId,
    status,
    updatedAt: "2026-01-01T00:00:00Z",
    ...(reason ? { reason } : {}),
  }),
  getRuntimeHealth: () => [],
  closeSessionsByRuntime: () => [],
  sweepIdleSessions: () => [],
  handleMessage: (msg, emit) => {
    if (msg.type === "session_list") {
      emit({ type: "session_list", sessions: [] } as GatewayEvent);
      return;
    }
    if (msg.type === "session_new") {
      emit({
        type: "session_created",
        sessionId: "test-session",
        model: "claude",
      } as GatewayEvent);
      return;
    }
    emit({
      type: "error",
      sessionId: "",
      message: "unhandled",
    } as GatewayEvent);
  },
};

const connectWs = (
  port: number,
  token?: string,
): Promise<{ ws: WebSocket; messages: string[] }> =>
  new Promise((resolve, reject) => {
    const url = token
      ? `ws://127.0.0.1:${port}/ws?token=${token}`
      : `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(url);
    const messages: string[] = [];

    ws.on("message", (data) => {
      messages.push(data.toString());
    });

    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", (err) => reject(err));
  });

/** Wait for a WS to fully close (handles both close and error paths). */
const waitForDisconnect = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
    ws.on("error", () => {
      // After error, ws may still emit close — but resolve immediately
      // since the connection is effectively dead.
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        resolve();
      } else {
        ws.on("close", () => resolve());
      }
    });
  });

const waitForMessage = (messages: string[], timeout = 2000): Promise<string> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (messages.length > 0) {
        resolve(messages.shift()!);
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error("Timeout waiting for message"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });

describe("createGatewayServer", () => {
  let server: GatewayServer;
  let port: number;
  let stopped: boolean;

  beforeEach(async () => {
    stopped = false;
    server = createGatewayServer({
      port: 0,
      host: "127.0.0.1",
      token: TEST_TOKEN,
      router: mockRouter,
    });
    const info = await server.start();
    port = info.port;
  });

  afterEach(async () => {
    if (!stopped) {
      await server.stop();
    }
  });

  it("/health endpoint returns { status: 'ok' } without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("/health includes custom health payload when provided", async () => {
    await server.stop();
    stopped = true;
    server = createGatewayServer({
      port: 0,
      host: "127.0.0.1",
      token: TEST_TOKEN,
      router: mockRouter,
      healthProvider: () => ({
        runtimes: [{ runtimeId: "claude", status: "healthy" }],
      }),
    });
    const info = await server.start();
    port = info.port;
    stopped = false;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      runtimes: [{ runtimeId: "claude", status: "healthy" }],
    });
  });

  it("WebSocket connection without token is rejected", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(url);
    await waitForDisconnect(ws);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("WebSocket connection with wrong token is rejected", async () => {
    const url = `ws://127.0.0.1:${port}/ws?token=wrong-token`;
    const ws = new WebSocket(url);
    await waitForDisconnect(ws);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("WebSocket connection with correct token is accepted", async () => {
    const { ws } = await connectWs(port, TEST_TOKEN);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("client sends valid JSON and receives response", async () => {
    const { ws, messages } = await connectWs(port, TEST_TOKEN);

    ws.send(JSON.stringify({ type: "session_list" }));
    const response = await waitForMessage(messages);
    const parsed = JSON.parse(response);
    expect(parsed.type).toBe("session_list");
    expect(parsed.sessions).toEqual([]);

    ws.close();
  });

  it("malformed JSON from client results in error event, no crash", async () => {
    const { ws, messages } = await connectWs(port, TEST_TOKEN);

    ws.send("not valid json {{{");
    const response = await waitForMessage(messages);
    const parsed = JSON.parse(response);
    expect(parsed.type).toBe("error");
    expect(parsed.message).toBeDefined();
    expect(parsed.sessionId).toBe("");

    // Server should still be alive — send another message
    ws.send(JSON.stringify({ type: "session_list" }));
    const response2 = await waitForMessage(messages);
    const parsed2 = JSON.parse(response2);
    expect(parsed2.type).toBe("session_list");

    ws.close();
  });

  it("server graceful shutdown closes connections", async () => {
    const { ws } = await connectWs(port, TEST_TOKEN);
    const disconnectPromise = waitForDisconnect(ws);

    await server.stop();
    stopped = true;
    await disconnectPromise;

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
