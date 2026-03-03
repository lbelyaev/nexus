import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { createGatewayServer, type GatewayServer } from "../server.js";
import { createRouter, type EventEmitter, type ManagedAcpSession } from "../router.js";
import { createStateStore, type StateStore } from "@nexus/state";
import type { PolicyConfig, GatewayEvent } from "@nexus/types";

const TEST_TOKEN = "e2e-test-token-xyz";

const createMockAcpSession = (id: string): ManagedAcpSession => ({
  id,
  acpSessionId: `acp-${id}`,
  runtimeId: "default",
  model: "claude",
  prompt: vi.fn().mockResolvedValue({ text: "mock response" }),
  respondToPermission: vi.fn().mockReturnValue(true),
  cancel: vi.fn(),
  onEvent: vi.fn(),
});

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

const waitForClose = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });

describe("E2E: WS client -> Gateway -> mock ACP session -> events back", () => {
  let server: GatewayServer;
  let stateStore: StateStore;
  let port: number;
  let sessionCounter: number;

  const policyConfig: PolicyConfig = {
    rules: [{ tool: "*", action: "allow" }],
  };

  beforeEach(async () => {
    sessionCounter = 0;
    stateStore = createStateStore(":memory:");

    const router = createRouter({
      createAcpSession: async (_runtimeId, _model, _onEvent: EventEmitter) => {
        sessionCounter += 1;
        return createMockAcpSession(`gw-session-${sessionCounter}`);
      },
      stateStore,
      policyConfig,
    });

    server = createGatewayServer({
      port: 0,
      host: "127.0.0.1",
      token: TEST_TOKEN,
      router,
    });

    const info = await server.start();
    port = info.port;
  });

  afterEach(async () => {
    await server.stop();
    stateStore.close();
  });

  describe("full prompt cycle", () => {
    it("creates a session, sends a prompt, and verifies state store", async () => {
      const { ws, messages } = await connectWs(port, TEST_TOKEN);

      // 1. Send session_new
      ws.send(JSON.stringify({ type: "session_new" }));
      const sessionCreatedRaw = await waitForMessage(messages);
      const sessionCreated = JSON.parse(sessionCreatedRaw) as GatewayEvent;

      expect(sessionCreated.type).toBe("session_created");
      if (sessionCreated.type !== "session_created") throw new Error("unreachable");

      const sessionId = sessionCreated.sessionId;
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe("string");
      expect(sessionCreated.model).toBe("claude");

      // 2. Verify session exists in state store
      const stored = stateStore.getSession(sessionId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe("active");
      expect(stored!.acpSessionId).toBe(`acp-${sessionId}`);

      // 3. Send a prompt — router now emits turn_end asynchronously
      ws.send(
        JSON.stringify({ type: "prompt", sessionId, text: "hello world" }),
      );
      const promptResponseRaw = await waitForMessage(messages);
      const promptResponse = JSON.parse(promptResponseRaw) as GatewayEvent;

      // Router emits turn_end when the mock prompt resolves
      expect(promptResponse.type).toBe("turn_end");
      if (promptResponse.type !== "turn_end") throw new Error("unreachable");
      expect(promptResponse.sessionId).toBe(sessionId);

      // 4. Verify lastActivityAt was updated in state store
      const updatedSession = stateStore.getSession(sessionId);
      expect(updatedSession).not.toBeNull();
      expect(updatedSession!.lastActivityAt).toBeDefined();

      ws.close();
    });

    it("returns error when prompting a non-existent session", async () => {
      const { ws, messages } = await connectWs(port, TEST_TOKEN);

      ws.send(
        JSON.stringify({
          type: "prompt",
          sessionId: "does-not-exist",
          text: "hello",
        }),
      );

      const responseRaw = await waitForMessage(messages);
      const response = JSON.parse(responseRaw) as GatewayEvent;

      expect(response.type).toBe("error");
      if (response.type !== "error") throw new Error("unreachable");
      expect(response.sessionId).toBe("does-not-exist");
      expect(response.message).toMatch(/not found/i);

      ws.close();
    });
  });

  describe("session list", () => {
    it("lists sessions after creating one", async () => {
      const { ws, messages } = await connectWs(port, TEST_TOKEN);

      // 1. Create a session
      ws.send(JSON.stringify({ type: "session_new" }));
      const createdRaw = await waitForMessage(messages);
      const created = JSON.parse(createdRaw) as GatewayEvent;
      expect(created.type).toBe("session_created");

      // 2. Request session list
      ws.send(JSON.stringify({ type: "session_list" }));
      const listRaw = await waitForMessage(messages);
      const list = JSON.parse(listRaw) as GatewayEvent;

      expect(list.type).toBe("session_list");
      if (list.type !== "session_list") throw new Error("unreachable");
      expect(list.sessions).toHaveLength(1);
      expect(list.sessions[0].status).toBe("active");
      expect(list.sessions[0].model).toBe("claude");

      if (created.type === "session_created") {
        expect(list.sessions[0].id).toBe(created.sessionId);
      }

      ws.close();
    });

    it("lists multiple sessions", async () => {
      const { ws, messages } = await connectWs(port, TEST_TOKEN);

      // Create two sessions
      ws.send(JSON.stringify({ type: "session_new" }));
      await waitForMessage(messages);

      ws.send(JSON.stringify({ type: "session_new" }));
      await waitForMessage(messages);

      // Request session list
      ws.send(JSON.stringify({ type: "session_list" }));
      const listRaw = await waitForMessage(messages);
      const list = JSON.parse(listRaw) as GatewayEvent;

      expect(list.type).toBe("session_list");
      if (list.type !== "session_list") throw new Error("unreachable");
      expect(list.sessions).toHaveLength(2);

      ws.close();
    });
  });

  describe("reconnect and resume", () => {
    it("replays transcript after reconnecting with same session id", async () => {
      const first = await connectWs(port, TEST_TOKEN);

      first.ws.send(JSON.stringify({ type: "session_new" }));
      const createdRaw = await waitForMessage(first.messages);
      const created = JSON.parse(createdRaw) as GatewayEvent;
      expect(created.type).toBe("session_created");
      if (created.type !== "session_created") throw new Error("unreachable");

      first.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "remember this line",
      }));
      const promptRaw = await waitForMessage(first.messages);
      const promptEvent = JSON.parse(promptRaw) as GatewayEvent;
      expect(promptEvent.type).toBe("turn_end");

      first.ws.close();
      await waitForClose(first.ws);

      const second = await connectWs(port, TEST_TOKEN);
      second.ws.send(JSON.stringify({
        type: "session_replay",
        sessionId: created.sessionId,
      }));

      const replayRaw = await waitForMessage(second.messages);
      const replayEvent = JSON.parse(replayRaw) as GatewayEvent;
      expect(replayEvent.type).toBe("transcript");
      if (replayEvent.type !== "transcript") throw new Error("unreachable");
      expect(replayEvent.sessionId).toBe(created.sessionId);
      expect(replayEvent.messages.some((m) => m.role === "user" && m.content.includes("remember this line"))).toBe(true);

      second.ws.close();
    });
  });
});
