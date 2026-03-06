import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { generateKeyPairSync, sign } from "node:crypto";
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
        const next = messages.shift()!;
        try {
          const parsed = JSON.parse(next) as GatewayEvent;
          // Connection-level auth/runtime bootstrap events can arrive before
          // test-triggered session events; skip them in generic wait helper.
          if (parsed.type === "auth_challenge" || parsed.type === "runtime_health") {
            setTimeout(check, 0);
            return;
          }
        } catch {
          // Keep raw handling behavior if this is not parseable JSON.
        }
        resolve(next);
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

const waitForEvent = <T extends GatewayEvent["type"]>(
  messages: string[],
  type: T,
  timeout = 2000,
): Promise<Extract<GatewayEvent, { type: T }>> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const deferred: string[] = [];
      while (messages.length > 0) {
        const next = messages.shift()!;
        let parsed: GatewayEvent | null = null;
        try {
          parsed = JSON.parse(next) as GatewayEvent;
        } catch {
          deferred.push(next);
          continue;
        }
        if (parsed.type === type) {
          if (deferred.length > 0) {
            messages.unshift(...deferred);
          }
          resolve(parsed as Extract<GatewayEvent, { type: T }>);
          return;
        }
        deferred.push(next);
      }
      if (deferred.length > 0) {
        messages.unshift(...deferred);
      }
      if (Date.now() - start > timeout) {
        reject(new Error(`Timeout waiting for event: ${type}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });

const sendAuthProof = async (
  ws: WebSocket,
  messages: string[],
  principalId: string,
): Promise<void> => {
  const challenge = await waitForEvent(messages, "auth_challenge");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = `${challenge.challengeId}:${challenge.nonce}:user:${principalId}`;
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  const exportedPublicKey = publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();

  ws.send(JSON.stringify({
    type: "auth_proof",
    principalType: "user",
    principalId,
    publicKey: exportedPublicKey,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    signature,
    algorithm: "ed25519",
  }));

  const result = await waitForEvent(messages, "auth_result");
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.message ?? "auth_proof was rejected");
  }
};

describe("E2E: WS client -> Gateway -> mock ACP session -> events back", () => {
  let server: GatewayServer;
  let stateStore: StateStore;
  let port: number;
  let sessionCounter: number;

  const policyConfig: PolicyConfig = {
    rules: [{ tool: "*", action: "allow" }],
  };

  const startServer = async (): Promise<void> => {
    const router = createRouter({
      createAcpSession: async (_runtimeId, _model, _onEvent: EventEmitter, _policyContext) => {
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
  };

  const restartServer = async (): Promise<void> => {
    await server.stop();
    await startServer();
  };

  beforeEach(async () => {
    sessionCounter = 0;
    stateStore = createStateStore(":memory:");
    await startServer();
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

  describe("authenticated session transfer", () => {
    it("allows transfer after authenticating a session that was created pre-auth", async () => {
      const owner = await connectWs(port, TEST_TOKEN);
      const target = await connectWs(port, TEST_TOKEN);

      owner.ws.send(JSON.stringify({ type: "session_new" }));
      const created = await waitForEvent(owner.messages, "session_created");
      expect(created.principalId).toBe("user:local");

      await sendAuthProof(owner.ws, owner.messages, "user:owner:e2e");
      await sendAuthProof(target.ws, target.messages, "user:target:e2e");

      owner.ws.send(JSON.stringify({
        type: "session_transfer_request",
        sessionId: created.sessionId,
        targetPrincipalId: "user:target:e2e",
      }));

      const requestedForTarget = await waitForEvent(target.messages, "session_transfer_requested");
      expect(requestedForTarget.sessionId).toBe(created.sessionId);

      target.ws.send(JSON.stringify({
        type: "session_transfer_accept",
        sessionId: created.sessionId,
      }));

      const transferredTarget = await waitForEvent(target.messages, "session_transferred");
      expect(transferredTarget.sessionId).toBe(created.sessionId);

      owner.ws.close();
      target.ws.close();
      await waitForClose(owner.ws);
      await waitForClose(target.ws);
    });

    it("transfers ownership to target principal and enforces new owner", async () => {
      const owner = await connectWs(port, TEST_TOKEN);
      const target = await connectWs(port, TEST_TOKEN);

      await sendAuthProof(owner.ws, owner.messages, "user:owner:e2e");
      await sendAuthProof(target.ws, target.messages, "user:target:e2e");

      owner.ws.send(JSON.stringify({ type: "session_new" }));
      const created = await waitForEvent(owner.messages, "session_created");

      owner.ws.send(JSON.stringify({
        type: "session_transfer_request",
        sessionId: created.sessionId,
        targetPrincipalId: "user:target:e2e",
      }));

      const requestedForTarget = await waitForEvent(target.messages, "session_transfer_requested");
      expect(requestedForTarget.sessionId).toBe(created.sessionId);
      expect(requestedForTarget.targetPrincipalId).toBe("user:target:e2e");

      target.ws.send(JSON.stringify({
        type: "session_transfer_accept",
        sessionId: created.sessionId,
      }));

      const transferredTarget = await waitForEvent(target.messages, "session_transferred");
      const transferredOwner = await waitForEvent(owner.messages, "session_transferred");
      expect(transferredTarget.sessionId).toBe(created.sessionId);
      expect(transferredOwner.sessionId).toBe(created.sessionId);

      owner.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "old owner prompt should be blocked",
      }));
      const ownerPromptRejected = await waitForEvent(owner.messages, "error");
      expect(ownerPromptRejected.message).toMatch(/owned by another connection/i);

      target.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "new owner prompt should succeed",
      }));
      const targetTurnEnd = await waitForEvent(target.messages, "turn_end");
      expect(targetTurnEnd.sessionId).toBe(created.sessionId);

      owner.ws.close();
      target.ws.close();
      await waitForClose(owner.ws);
      await waitForClose(target.ws);
    });
  });

  describe("restart recovery", () => {
    it("allows transfer target to accept after gateway restart", async () => {
      const owner = await connectWs(port, TEST_TOKEN);
      const target = await connectWs(port, TEST_TOKEN);

      await sendAuthProof(owner.ws, owner.messages, "user:owner:restart");
      await sendAuthProof(target.ws, target.messages, "user:target:restart");

      owner.ws.send(JSON.stringify({ type: "session_new" }));
      const created = await waitForEvent(owner.messages, "session_created");

      owner.ws.send(JSON.stringify({
        type: "session_transfer_request",
        sessionId: created.sessionId,
        targetPrincipalId: "user:target:restart",
      }));
      const requested = await waitForEvent(target.messages, "session_transfer_requested");
      expect(requested.sessionId).toBe(created.sessionId);

      await restartServer();
      await waitForClose(owner.ws);
      await waitForClose(target.ws);

      const resumedTarget = await connectWs(port, TEST_TOKEN);
      await sendAuthProof(resumedTarget.ws, resumedTarget.messages, "user:target:restart");

      resumedTarget.ws.send(JSON.stringify({
        type: "session_transfer_accept",
        sessionId: created.sessionId,
      }));

      const transferred = await waitForEvent(resumedTarget.messages, "session_transferred");
      expect(transferred.sessionId).toBe(created.sessionId);

      resumedTarget.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "accepted after restart",
      }));
      const turnEnd = await waitForEvent(resumedTarget.messages, "turn_end");
      expect(turnEnd.sessionId).toBe(created.sessionId);

      resumedTarget.ws.close();
      await waitForClose(resumedTarget.ws);
    });

    it("replays parked owner session after restart and resumes on prompt", async () => {
      const owner = await connectWs(port, TEST_TOKEN);
      await sendAuthProof(owner.ws, owner.messages, "user:owner:resume");

      owner.ws.send(JSON.stringify({ type: "session_new" }));
      const created = await waitForEvent(owner.messages, "session_created");

      owner.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "remember restart resume",
      }));
      await waitForEvent(owner.messages, "turn_end");

      owner.ws.close();
      await waitForClose(owner.ws);
      await vi.waitFor(() => {
        expect(stateStore.getSession(created.sessionId)?.parkedReason).toBe("owner_disconnected");
      });

      await restartServer();

      const resumedOwner = await connectWs(port, TEST_TOKEN);
      await sendAuthProof(resumedOwner.ws, resumedOwner.messages, "user:owner:resume");

      resumedOwner.ws.send(JSON.stringify({
        type: "session_replay",
        sessionId: created.sessionId,
      }));
      const transcript = await waitForEvent(resumedOwner.messages, "transcript");
      expect(transcript.messages.some((message) => message.content.includes("remember restart resume"))).toBe(true);

      resumedOwner.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "resume after restart",
      }));
      const turnEnd = await waitForEvent(resumedOwner.messages, "turn_end");
      expect(turnEnd.sessionId).toBe(created.sessionId);
      expect(stateStore.getSession(created.sessionId)?.lifecycleState).toBe("live");

      resumedOwner.ws.close();
      await waitForClose(resumedOwner.ws);
    });

    it("allows takeover of runtime-timeout session after restart", async () => {
      const owner = await connectWs(port, TEST_TOKEN);
      await sendAuthProof(owner.ws, owner.messages, "user:owner:takeover");

      owner.ws.send(JSON.stringify({ type: "session_new" }));
      const created = await waitForEvent(owner.messages, "session_created");

      owner.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "timed out transcript",
      }));
      await waitForEvent(owner.messages, "turn_end");

      stateStore.applySessionLifecycleEvent(created.sessionId, {
        eventType: "RUNTIME_TIMEOUT",
        parkedReason: "runtime_timeout",
        reason: "e2e_runtime_timeout",
        actorPrincipalType: "user",
        actorPrincipalId: "user:owner:takeover",
        at: new Date().toISOString(),
      });

      await restartServer();
      await waitForClose(owner.ws);

      const taker = await connectWs(port, TEST_TOKEN);
      await sendAuthProof(taker.ws, taker.messages, "user:taker:takeover");

      taker.ws.send(JSON.stringify({
        type: "session_takeover",
        sessionId: created.sessionId,
      }));
      const transcript = await waitForEvent(taker.messages, "transcript");
      expect(transcript.messages.some((message) => message.content.includes("timed out transcript"))).toBe(true);

      taker.ws.send(JSON.stringify({
        type: "prompt",
        sessionId: created.sessionId,
        text: "taken over after restart",
      }));
      const turnEnd = await waitForEvent(taker.messages, "turn_end");
      expect(turnEnd.sessionId).toBe(created.sessionId);
      expect(stateStore.getSession(created.sessionId)?.lifecycleState).toBe("live");
      expect(stateStore.getSession(created.sessionId)?.principalId).toBe("user:taker:takeover");

      taker.ws.close();
      await waitForClose(taker.ws);
    });
  });

  describe("auth proof lifecycle", () => {
    it("rejects replayed auth nonce on the same connection", async () => {
      const conn = await connectWs(port, TEST_TOKEN);
      const challenge = await waitForEvent(conn.messages, "auth_challenge");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const principalId = "user:replay:e2e";
      const payload = `${challenge.challengeId}:${challenge.nonce}:user:${principalId}`;
      const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
      const exportedPublicKey = publicKey.export({
        type: "spki",
        format: "pem",
      }).toString();

      conn.ws.send(JSON.stringify({
        type: "auth_proof",
        principalType: "user",
        principalId,
        publicKey: exportedPublicKey,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        signature,
        algorithm: "ed25519",
      }));
      const first = await waitForEvent(conn.messages, "auth_result");
      expect(first.ok).toBe(true);

      conn.ws.send(JSON.stringify({
        type: "auth_proof",
        principalType: "user",
        principalId,
        publicKey: exportedPublicKey,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        signature,
        algorithm: "ed25519",
      }));
      const replay = await waitForEvent(conn.messages, "auth_result");
      expect(replay.ok).toBe(false);
      expect(replay.message).toMatch(/already used/i);

      conn.ws.close();
      await waitForClose(conn.ws);
    });
  });
});
