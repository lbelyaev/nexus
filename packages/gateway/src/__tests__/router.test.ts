import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStateStore, type StateStore } from "@nexus/state";
import type { PolicyConfig, GatewayEvent, ClientMessage } from "@nexus/types";
import type { MemoryProvider } from "@nexus/memory";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRouter, type Router, type EventEmitter, type ManagedAcpSession } from "../router.js";

const mockAcpSession = (): ManagedAcpSession => ({
  id: "gw-session-1",
  acpSessionId: "acp-session-1",
  runtimeId: "default",
  model: "claude",
  modelRouting: { sonnet: "claude", "gpt-5": "codex" },
  modelAliases: { fast: "gpt-5.2-codex-mini" },
  modelCatalog: { codex: ["gpt-5.2-codex", "gpt-5.3-codex"], claude: ["sonnet"] },
  runtimeDefaults: { codex: "gpt-5.2-codex", claude: "sonnet" },
  prompt: vi.fn().mockResolvedValue(undefined),
  respondToPermission: vi.fn().mockReturnValue(true),
  cancel: vi.fn(),
  onEvent: vi.fn(),
});

const collectEvents = (): { emit: EventEmitter; events: GatewayEvent[] } => {
  const events: GatewayEvent[] = [];
  const emit: EventEmitter = (event) => events.push(event);
  return { emit, events };
};

const createAuthProof = (params: {
  nonce: string;
  principalType?: "user" | "service_account";
  principalId: string;
}): Extract<ClientMessage, { type: "auth_proof" }> => {
  const principalType = params.principalType ?? "user";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    `${params.nonce}:${principalType}:${params.principalId}`,
    "utf8",
  );
  const signature = sign(null, payload, privateKey).toString("base64");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    type: "auth_proof",
    principalType,
    principalId: params.principalId,
    publicKey: publicKeyPem,
    nonce: params.nonce,
    signature,
    algorithm: "ed25519",
  };
};

describe("createRouter", () => {
  let stateStore: StateStore;
  let router: Router;
  let acpSession: ManagedAcpSession;
  let createAcpSessionMock: ReturnType<typeof vi.fn>;
  let memoryProvider: MemoryProvider;
  const policyConfig: PolicyConfig = {
    rules: [{ tool: "*", action: "allow" }],
  };

  beforeEach(() => {
    stateStore = createStateStore(":memory:");
    acpSession = mockAcpSession();
    memoryProvider = {
      id: "test-memory",
      getStats: vi.fn(() => ({
        facts: 2,
        summaries: 1,
        total: 3,
        transcriptMessages: 4,
        memoryTokens: 30,
        transcriptTokens: 50,
      })),
      getRecent: vi.fn(() => []),
      getContext: vi.fn(() => ({
        sessionId: "gw-session-1",
        budgetTokens: 1000,
        totalTokens: 0,
        hot: [],
        warm: [],
        cold: [],
        rendered: "",
      })),
      search: vi.fn(() => []),
      recordTurn: vi.fn(),
      clear: vi.fn(() => 0),
    };
    createAcpSessionMock = vi.fn(async (_runtimeId, _model, _onEvent: EventEmitter) => acpSession);
    router = createRouter({
      createAcpSession: createAcpSessionMock,
      stateStore,
      policyConfig,
      memoryProvider,
      defaultWorkspaceId: "default",
    });
  });

  afterEach(() => {
    stateStore.close();
  });

  it("session_new creates session in state store and emits session_created event", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    // createAcpSession is async, wait for it
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    const event = events[0];
    expect(event.type).toBe("session_created");
    if (event.type === "session_created") {
      expect(event.sessionId).toBeDefined();
      expect(typeof event.sessionId).toBe("string");
      expect(event.model).toBe("claude");
      expect(event.runtimeId).toBe("default");
      expect(event.workspaceId).toBe("default");
      expect(event.principalType).toBe("user");
      expect(event.principalId).toBe("user:local");
      expect(event.source).toBe("interactive");
      expect(event.modelRouting?.sonnet).toBe("claude");
      expect(event.modelAliases?.fast).toBe("gpt-5.2-codex-mini");
      expect(event.modelCatalog?.codex).toContain("gpt-5.3-codex");
      expect(event.runtimeDefaults?.claude).toBe("sonnet");

      const stored = stateStore.getSession(event.sessionId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe("active");
    }
  });

  it("session_new forwards requested runtimeId and model", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new", runtimeId: "codex", model: "gpt-5" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    expect(createAcpSessionMock).toHaveBeenCalledWith("codex", "gpt-5", emit);
  });

  it("session_new uses provided workspaceId", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new", workspaceId: "acme" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    const event = events[0];
    if (event.type !== "session_created") throw new Error("expected session_created");
    expect(event.workspaceId).toBe("acme");

    const stored = stateStore.getSession(event.sessionId);
    expect(stored?.workspaceId).toBe("acme");
  });

  it("session_new uses provided principal and source", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({
      type: "session_new",
      principalType: "service_account",
      principalId: "svc:nightly",
      source: "schedule",
    }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    const event = events[0];
    if (event.type !== "session_created") throw new Error("expected session_created");
    expect(event.principalType).toBe("service_account");
    expect(event.principalId).toBe("svc:nightly");
    expect(event.source).toBe("schedule");
  });

  it("auth_proof binds a verified principal that session_new reuses", async () => {
    const { emit, events } = collectEvents();
    router.registerConnection("conn-1", emit);
    const challenge = events.find((event) => event.type === "auth_challenge");
    if (!challenge || challenge.type !== "auth_challenge") {
      throw new Error("auth_challenge missing");
    }

    events.length = 0;
    const proof = createAuthProof({
      nonce: challenge.nonce,
      principalId: "user:alice",
    });
    router.handleMessage(proof, emit, { connectionId: "conn-1" });
    expect(events.some((event) => event.type === "auth_result")).toBe(true);
    const authResult = events.find((event) => event.type === "auth_result");
    if (!authResult || authResult.type !== "auth_result") throw new Error("expected auth_result");
    expect(authResult.ok).toBe(true);
    expect(authResult.principalId).toBe("user:alice");

    events.length = 0;
    router.handleMessage({ type: "session_new" }, emit, { connectionId: "conn-1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");
    expect(created.principalId).toBe("user:alice");
    expect(created.principalType).toBe("user");
  });

  it("auth_proof rejects nonce replay", () => {
    const { emit, events } = collectEvents();
    router.registerConnection("conn-1", emit);
    const challenge = events.find((event) => event.type === "auth_challenge");
    if (!challenge || challenge.type !== "auth_challenge") {
      throw new Error("auth_challenge missing");
    }
    const proof = createAuthProof({
      nonce: challenge.nonce,
      principalId: "user:alice",
    });

    events.length = 0;
    router.handleMessage(proof, emit, { connectionId: "conn-1" });
    const first = events.find((event) => event.type === "auth_result");
    if (!first || first.type !== "auth_result") throw new Error("expected auth_result");
    expect(first.ok).toBe(true);

    events.length = 0;
    router.handleMessage(proof, emit, { connectionId: "conn-1" });
    const second = events.find((event) => event.type === "auth_result");
    if (!second || second.type !== "auth_result") throw new Error("expected auth_result");
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already used/i);
  });

  it("prompt emits error event if sessionId not found", () => {
    const { emit, events } = collectEvents();
    router.handleMessage(
      { type: "prompt", sessionId: "nonexistent", text: "hello" },
      emit,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].sessionId).toBe("nonexistent");
      expect(events[0].message).toMatch(/not found/i);
    }
  });

  it("prompt calls session.prompt and emits turn_end on resolve", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;

    events.length = 0;
    router.handleMessage(
      { type: "prompt", sessionId, text: "hello" },
      emit,
    );

    expect(acpSession.prompt).toHaveBeenCalledWith("hello");

    // Wait for the promise to resolve and turn_end to be emitted
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });

    const turnEnd = events.find((e) => e.type === "turn_end");
    if (!turnEnd || turnEnd.type !== "turn_end") throw new Error("expected turn_end");
    expect(turnEnd.executionId).toBeDefined();
    expect(turnEnd.turnId).toBeDefined();
    expect(turnEnd.policySnapshotId).toBeDefined();
  });

  it("prompt deduplicates by idempotencyKey", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });
    const sessionCreated = events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") throw new Error("session_created missing");

    events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: sessionCreated.sessionId,
      text: "hello",
      idempotencyKey: "dup-1",
    }, emit);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });
    const callCountAfterFirst = (acpSession.prompt as ReturnType<typeof vi.fn>).mock.calls.length;

    events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: sessionCreated.sessionId,
      text: "hello",
      idempotencyKey: "dup-1",
    }, emit);

    expect((acpSession.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountAfterFirst);
    expect(events.some((e) => e.type === "turn_end")).toBe(true);
    const duplicateTurnEnd = events.find((e) => e.type === "turn_end");
    if (!duplicateTurnEnd || duplicateTurnEnd.type !== "turn_end") throw new Error("turn_end missing");
    expect(duplicateTurnEnd.stopReason).toBe("idempotent_duplicate");
  });

  it("prompt emits text_delta when prompt result has a single content block object", async () => {
    (acpSession.prompt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stopReason: "end_turn",
      content: { type: "text", text: "Final response text" },
    });

    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionCreated = events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") {
      throw new Error("session_created event missing");
    }

    events.length = 0;
    router.handleMessage(
      { type: "prompt", sessionId: sessionCreated.sessionId, text: "hello" },
      emit,
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });

    const textEvent = events.find((e) => e.type === "text_delta");
    expect(textEvent).toBeDefined();
    if (textEvent?.type === "text_delta") {
      expect(textEvent.delta).toBe("Final response text");
    }
  });

  it("prompt rebinds session event emitter on each prompt for owner connection", async () => {
    const owner = collectEvents();
    router.handleMessage({ type: "session_new" }, owner.emit);

    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionCreated = owner.events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") {
      throw new Error("session_created event missing");
    }

    router.handleMessage(
      { type: "prompt", sessionId: sessionCreated.sessionId, text: "hello" },
      owner.emit,
    );
    router.handleMessage(
      { type: "prompt", sessionId: sessionCreated.sessionId, text: "again" },
      owner.emit,
    );

    expect(acpSession.onEvent).toHaveBeenCalledTimes(2);
    expect(typeof (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("function");
    expect(typeof (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe("function");
  });

  it("session_list emits session_list event from state store", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    events.length = 0;
    router.handleMessage({ type: "session_list" }, emit);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_list");
    if (events[0].type === "session_list") {
      expect(events[0].sessions).toHaveLength(1);
      expect(events[0].sessions[0].status).toBe("active");
    }
  });

  it("cancel calls acpSession.cancel()", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;

    router.handleMessage({ type: "cancel", sessionId }, emit);

    expect(acpSession.cancel).toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_created");
  });

  it("session_close closes session and emits session_closed", async () => {
    const { emit, events } = collectEvents();
    router.registerConnection("conn-1", emit);
    router.handleMessage({ type: "session_new" }, emit, { connectionId: "conn-1" });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionCreated = events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") throw new Error("expected session_created");
    events.length = 0;

    router.handleMessage(
      { type: "session_close", sessionId: sessionCreated.sessionId },
      emit,
      { connectionId: "conn-1" },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "session_closed",
      sessionId: sessionCreated.sessionId,
      reason: "client_close",
    });
  });

  it("releases ownership on disconnect and allows takeover on reconnect", async () => {
    const owner = collectEvents();
    const other = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.registerConnection("conn-other", other.emit);
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });

    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });
    const sessionCreated = owner.events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") throw new Error("expected session_created");

    other.events.length = 0;
    router.handleMessage(
      { type: "session_replay", sessionId: sessionCreated.sessionId },
      other.emit,
      { connectionId: "conn-other" },
    );
    expect(other.events).toHaveLength(1);
    expect(other.events[0].type).toBe("error");

    other.events.length = 0;
    router.unregisterConnection("conn-owner", owner.emit);
    router.handleMessage(
      { type: "session_replay", sessionId: sessionCreated.sessionId },
      other.emit,
      { connectionId: "conn-other" },
    );
    expect(other.events).toHaveLength(1);
    expect(other.events[0].type).toBe("transcript");
  });

  it("supports explicit session transfer between authenticated principals", async () => {
    const owner = collectEvents();
    const target = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.registerConnection("conn-target", target.emit);

    const ownerChallenge = owner.events.find((event) => event.type === "auth_challenge");
    const targetChallenge = target.events.find((event) => event.type === "auth_challenge");
    if (!ownerChallenge || ownerChallenge.type !== "auth_challenge") throw new Error("owner auth_challenge missing");
    if (!targetChallenge || targetChallenge.type !== "auth_challenge") throw new Error("target auth_challenge missing");

    owner.events.length = 0;
    target.events.length = 0;
    router.handleMessage(createAuthProof({
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      nonce: targetChallenge.nonce,
      principalId: "user:bob",
    }), target.emit, { connectionId: "conn-target" });

    owner.events.length = 0;
    target.events.length = 0;
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect(owner.events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    owner.events.length = 0;
    target.events.length = 0;
    router.handleMessage({
      type: "session_transfer_request",
      sessionId: created.sessionId,
      targetPrincipalId: "user:bob",
      targetPrincipalType: "user",
    }, owner.emit, { connectionId: "conn-owner" });

    expect(owner.events.some((event) => event.type === "session_transfer_requested")).toBe(true);
    expect(target.events.some((event) => event.type === "session_transfer_requested")).toBe(true);

    owner.events.length = 0;
    target.events.length = 0;
    router.handleMessage({
      type: "session_transfer_accept",
      sessionId: created.sessionId,
    }, target.emit, { connectionId: "conn-target" });

    expect(target.events.some((event) => event.type === "session_transferred")).toBe(true);
    expect(owner.events.some((event) => event.type === "session_transferred")).toBe(true);

    owner.events.length = 0;
    target.events.length = 0;
    router.handleMessage({ type: "session_replay", sessionId: created.sessionId }, owner.emit, { connectionId: "conn-owner" });
    expect(owner.events).toHaveLength(1);
    expect(owner.events[0].type).toBe("error");
    if (owner.events[0].type === "error") {
      expect(owner.events[0].message).toMatch(/owned by another connection/i);
    }

    router.handleMessage({ type: "session_replay", sessionId: created.sessionId }, target.emit, { connectionId: "conn-target" });
    expect(target.events.some((event) => event.type === "transcript")).toBe(true);
  });

  it("sweepIdleSessions closes stale sessions", async () => {
    const { emit, events } = collectEvents();
    router = createRouter({
      createAcpSession: createAcpSessionMock,
      stateStore,
      policyConfig,
      memoryProvider,
      defaultWorkspaceId: "default",
      sessionIdleTimeoutMs: 1_000,
    });
    router.registerConnection("conn-1", emit);
    router.handleMessage({ type: "session_new" }, emit, { connectionId: "conn-1" });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });
    const sessionCreated = events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") throw new Error("expected session_created");

    const closed = router.sweepIdleSessions(new Date(Date.now() + 10_000));
    expect(closed).toContain(sessionCreated.sessionId);
  });

  it("broadcasts runtime health updates to connected clients", () => {
    const a = collectEvents();
    const b = collectEvents();
    router.registerConnection("conn-a", a.emit);
    router.registerConnection("conn-b", b.emit);

    const updated = router.setRuntimeHealth("codex", "degraded", "rpc_timeout");
    expect(updated.runtimeId).toBe("codex");
    expect(updated.status).toBe("degraded");

    expect(a.events.some((e) => e.type === "runtime_health")).toBe(true);
    expect(b.events.some((e) => e.type === "runtime_health")).toBe(true);
  });

  it("closeSessionsByRuntime closes matching sessions and notifies owner", async () => {
    const owner = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });

    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((e) => e.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");
    owner.events.length = 0;

    const closed = router.closeSessionsByRuntime("default", "runtime_unavailable");
    expect(closed).toEqual([created.sessionId]);
    expect(owner.events).toEqual([
      {
        type: "error",
        sessionId: created.sessionId,
        message: "Runtime unavailable: default (runtime_unavailable)",
      },
      {
        type: "session_closed",
        sessionId: created.sessionId,
        reason: "runtime_unavailable",
      },
    ]);

    const stored = stateStore.getSession(created.sessionId);
    expect(stored?.status).toBe("idle");
  });

  it("approval_response forwards to session.respondToPermission", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    router.handleMessage(
      { type: "prompt", sessionId, text: "needs approval" },
      emit,
    );
    const eventHandler = (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as EventEmitter;
    eventHandler({
      type: "approval_request",
      sessionId,
      requestId: "req-1",
      tool: "Bash",
      description: "run command",
    });

    router.handleMessage(
      { type: "approval_response", requestId: "req-1", allow: true },
      emit,
    );

    expect(acpSession.respondToPermission).toHaveBeenCalledWith("req-1", "allow_once");
  });

  it("approval_response forwards explicit optionId when provided", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    router.handleMessage(
      { type: "prompt", sessionId, text: "needs approval" },
      emit,
    );
    const eventHandler = (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as EventEmitter;
    eventHandler({
      type: "approval_request",
      sessionId,
      requestId: "req-2",
      tool: "Bash",
      description: "run command",
    });

    router.handleMessage(
      {
        type: "approval_response",
        requestId: "req-2",
        optionId: "allow_always",
      },
      emit,
    );

    expect(acpSession.respondToPermission).toHaveBeenCalledWith("req-2", "allow_always");
  });

  it("approval_response ignores unknown request ids without emitting error", () => {
    const { emit, events } = collectEvents();

    router.handleMessage(
      { type: "approval_response", requestId: "missing-req", allow: true },
      emit,
    );

    expect(acpSession.respondToPermission).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  });

  it("approval_response ignores stale pending requests without emitting error", async () => {
    (acpSession.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    (acpSession.respondToPermission as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    router.handleMessage(
      { type: "prompt", sessionId, text: "needs approval" },
      emit,
    );
    const eventHandler = (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as EventEmitter;
    eventHandler({
      type: "approval_request",
      sessionId,
      requestId: "stale-req",
      tool: "Bash",
      description: "run command",
    });

    events.length = 0;
    router.handleMessage(
      {
        type: "approval_response",
        requestId: "stale-req",
        optionId: "allow_once",
      },
      emit,
    );

    expect(acpSession.respondToPermission).toHaveBeenCalledWith("stale-req", "allow_once");
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  });

  it("prompt records user message to transcript", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;

    router.handleMessage(
      { type: "prompt", sessionId, text: "hello world" },
      emit,
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });

    const transcript = stateStore.getTranscript(sessionId);
    expect(transcript.length).toBeGreaterThanOrEqual(1);
    expect(transcript[0].role).toBe("user");
    expect(transcript[0].content).toBe("hello world");
    expect(transcript[0].tokenEstimate).toBeGreaterThan(0);
  });

  it("prompt records assistant text from prompt response to transcript", async () => {
    (acpSession.prompt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stopReason: "end_turn",
      content: { type: "text", text: "Assistant reply" },
    });

    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;

    events.length = 0;
    router.handleMessage(
      { type: "prompt", sessionId, text: "hello" },
      emit,
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });

    const transcript = stateStore.getTranscript(sessionId);
    const assistantMsg = transcript.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("Assistant reply");
  });

  it("session_replay returns transcript for the requested session", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;

    // Send a prompt to populate transcript
    router.handleMessage(
      { type: "prompt", sessionId, text: "test message" },
      emit,
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });

    events.length = 0;
    router.handleMessage(
      { type: "session_replay", sessionId },
      emit,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("transcript");
    if (events[0].type === "transcript") {
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[0].messages.length).toBeGreaterThanOrEqual(1);
      expect(events[0].messages[0].role).toBe("user");
      expect(events[0].messages[0].content).toBe("test message");
    }
  });

  it("session_replay returns empty transcript for unknown session", () => {
    const { emit, events } = collectEvents();
    router.handleMessage(
      { type: "session_replay", sessionId: "nonexistent" },
      emit,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("transcript");
    if (events[0].type === "transcript") {
      expect(events[0].messages).toEqual([]);
    }
  });

  it("session_replay rejects requests from non-owner connection", async () => {
    const owner = collectEvents();
    router.handleMessage({ type: "session_new" }, owner.emit);

    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (owner.events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;

    const other = collectEvents();
    router.handleMessage(
      { type: "session_replay", sessionId },
      other.emit,
    );

    expect(other.events).toHaveLength(1);
    expect(other.events[0].type).toBe("error");
    if (other.events[0].type === "error") {
      expect(other.events[0].sessionId).toBe(sessionId);
      expect(other.events[0].message).toMatch(/owned by another connection/i);
    }
  });

  it("prompt injects memory context when provider returns rendered context", async () => {
    (memoryProvider.getContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      sessionId: "gw-session-1",
      budgetTokens: 1000,
      totalTokens: 24,
      hot: [],
      warm: [],
      cold: [],
      rendered: "# Memory Context\n- prior fact\n# End Memory Context",
    });

    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    router.handleMessage({ type: "prompt", sessionId, text: "current question" }, emit);

    expect(acpSession.prompt).toHaveBeenCalledTimes(1);
    expect((acpSession.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("# Memory Context");
    expect((acpSession.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("# User Prompt");
    expect(memoryProvider.getContext).toHaveBeenCalledWith({
      workspaceId: "default",
      sessionId,
      prompt: "current question",
      scope: "hybrid",
    });
  });

  it("records turn memory after turn_end", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    router.handleMessage({ type: "prompt", sessionId, text: "remember this" }, emit);

    const handler = (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as EventEmitter;
    handler({
      type: "text_delta",
      sessionId,
      delta: "assistant answer",
    });
    handler({
      type: "turn_end",
      sessionId,
      stopReason: "end_turn",
    });

    await vi.waitFor(() => {
      expect(memoryProvider.recordTurn).toHaveBeenCalled();
    });

    expect(memoryProvider.recordTurn).toHaveBeenCalledWith({
      workspaceId: "default",
      sessionId,
      userText: "remember this",
      assistantText: "assistant answer",
    });
  });

  it("memory_query stats returns memory_result", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    events.length = 0;
    router.handleMessage({ type: "memory_query", sessionId, action: "stats" }, emit);

    expect(memoryProvider.getStats).toHaveBeenCalledWith({
      workspaceId: "default",
      sessionId,
      scope: "session",
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("memory_result");
    if (events[0].type === "memory_result") {
      expect(events[0].action).toBe("stats");
      expect(events[0].scope).toBe("session");
    }
  });

  it("memory_query search validates query text", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    events.length = 0;
    router.handleMessage({ type: "memory_query", sessionId, action: "search", query: " " }, emit);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].message).toMatch(/query is required/i);
    }
  });
});
