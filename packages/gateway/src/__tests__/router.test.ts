import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStateStore, type StateStore } from "@nexus/state";
import type { PolicyConfig, GatewayEvent, ClientMessage } from "@nexus/types";
import type { MemoryProvider } from "@nexus/memory";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  createRouter,
  type Router,
  type EventEmitter,
  type ManagedAcpSession,
  type SessionPolicyContext,
} from "../router.js";

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

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createAuthProof = (params: {
  challengeId: string;
  nonce: string;
  principalType?: "user" | "service_account";
  principalId: string;
}): Extract<ClientMessage, { type: "auth_proof" }> => {
  const principalType = params.principalType ?? "user";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    `${params.challengeId}:${params.nonce}:${principalType}:${params.principalId}`,
    "utf8",
  );
  const signature = sign(null, payload, privateKey).toString("base64");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    type: "auth_proof",
    principalType,
    principalId: params.principalId,
    publicKey: publicKeyPem,
    challengeId: params.challengeId,
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
    createAcpSessionMock = vi.fn(async (_runtimeId, _model, _onEvent: EventEmitter, _policyContext) => acpSession);
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

    expect(createAcpSessionMock).toHaveBeenCalledWith("codex", "gpt-5", emit, {
      principalType: "user",
      principalId: "user:local",
      source: "interactive",
      workspaceId: "default",
    });
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

  it("session_new emits error when state persistence fails after ACP creation", async () => {
    const { emit, events } = collectEvents();
    const createSessionSpy = vi.spyOn(stateStore, "createSession").mockImplementation(() => {
      throw new Error("db write failed");
    });

    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "error")).toBe(true);
    });
    const errorEvent = events.find((event): event is Extract<GatewayEvent, { type: "error" }> => event.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain("db write failed");
    expect(events.some((event) => event.type === "session_created")).toBe(false);
    expect(acpSession.cancel).toHaveBeenCalledTimes(1);

    createSessionSpy.mockRestore();
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
    expect(createAcpSessionMock).toHaveBeenCalledWith(undefined, undefined, emit, {
      principalType: "service_account",
      principalId: "svc:nightly",
      source: "schedule",
      workspaceId: "default",
    });
  });

  it("rehydrates persisted sessions on prompt after runtime cache reset", async () => {
    stateStore.createSession({
      id: "gw-persisted-1",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:local",
      source: "interactive",
      runtimeId: "codex",
      acpSessionId: "acp-stale",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:01:00Z",
      tokenUsage: { input: 0, output: 0 },
      model: "gpt-5",
    });
    const promptSpy = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    acpSession = {
      ...acpSession,
      runtimeId: "codex",
      model: "gpt-5",
      prompt: promptSpy,
    };
    createAcpSessionMock = vi.fn(async () => acpSession);
    router = createRouter({
      createAcpSession: createAcpSessionMock,
      stateStore,
      policyConfig,
      memoryProvider,
      defaultWorkspaceId: "default",
    });

    const { emit, events } = collectEvents();
    router.handleMessage({ type: "prompt", sessionId: "gw-persisted-1", text: "resume turn" }, emit);

    await vi.waitFor(() => {
      expect(createAcpSessionMock).toHaveBeenCalledWith(
        "codex",
        "gpt-5",
        emit,
        {
          principalType: "user",
          principalId: "user:local",
          source: "interactive",
          workspaceId: "default",
        },
        { gatewaySessionId: "gw-persisted-1" },
      );
    });
    await vi.waitFor(() => {
      expect(promptSpy).toHaveBeenCalledWith("resume turn", []);
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_invalidated" && event.sessionId === "gw-persisted-1")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "turn_end" && event.sessionId === "gw-persisted-1")).toBe(true);
    });
  });

  it("rehydrates persisted sessions for usage queries", async () => {
    stateStore.createSession({
      id: "gw-persisted-usage",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:local",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-stale",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:01:00Z",
      tokenUsage: { input: 7, output: 3 },
      model: "sonnet",
    });

    const { emit, events } = collectEvents();
    router.handleMessage({
      type: "usage_query",
      sessionId: "gw-persisted-usage",
      action: "summary",
    }, emit);

    await vi.waitFor(() => {
      expect(createAcpSessionMock).toHaveBeenCalledWith(
        "claude",
        "sonnet",
        emit,
        {
          principalType: "user",
          principalId: "user:local",
          source: "interactive",
          workspaceId: "default",
        },
        { gatewaySessionId: "gw-persisted-usage" },
      );
    });
    await vi.waitFor(() => {
      const usageEvent = events.find(
        (event): event is Extract<GatewayEvent, { type: "usage_result"; action: "summary" }> =>
          event.type === "usage_result" && event.action === "summary",
      );
      expect(usageEvent).toBeDefined();
      expect(usageEvent?.summary.tokens.total).toBe(10);
    });
    expect(events.some((event) => event.type === "session_invalidated" && event.sessionId === "gw-persisted-usage")).toBe(true);
  });

  it("does not rehydrate closed sessions", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    events.length = 0;
    router.handleMessage({ type: "session_close", sessionId: created.sessionId }, emit);
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_closed")).toBe(true);
    });

    const callsBeforeResumeAttempt = createAcpSessionMock.mock.calls.length;
    events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "try to reopen closed",
    }, emit);

    await vi.waitFor(() => {
      const errorEvent = events.find((event) => event.type === "error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "error") {
        expect(errorEvent.message).toMatch(/closed and cannot be resumed/i);
      }
    });
    expect(createAcpSessionMock.mock.calls.length).toBe(callsBeforeResumeAttempt);
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
      challengeId: challenge.challengeId,
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

  it("auth_proof rebinds pre-auth local sessions owned by the same connection", async () => {
    const { emit, events } = collectEvents();
    router.registerConnection("conn-1", emit);
    const challenge = events.find((event) => event.type === "auth_challenge");
    if (!challenge || challenge.type !== "auth_challenge") {
      throw new Error("auth_challenge missing");
    }

    events.length = 0;
    router.handleMessage({ type: "session_new" }, emit, { connectionId: "conn-1" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");
    expect(created.principalId).toBe("user:local");

    events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:web:abc123",
    }), emit, { connectionId: "conn-1" });

    const authResult = events.find((event) => event.type === "auth_result");
    if (!authResult || authResult.type !== "auth_result") throw new Error("expected auth_result");
    expect(authResult.ok).toBe(true);

    const sessionRecord = stateStore.getSession(created.sessionId);
    expect(sessionRecord?.principalType).toBe("user");
    expect(sessionRecord?.principalId).toBe("user:web:abc123");
  });

  it("auth_proof rejects nonce replay", () => {
    const { emit, events } = collectEvents();
    router.registerConnection("conn-1", emit);
    const challenge = events.find((event) => event.type === "auth_challenge");
    if (!challenge || challenge.type !== "auth_challenge") {
      throw new Error("auth_challenge missing");
    }
    const proof = createAuthProof({
      challengeId: challenge.challengeId,
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

  it("auth_proof rejects mismatched challengeId", () => {
    const { emit, events } = collectEvents();
    router.registerConnection("conn-1", emit);
    const challenge = events.find((event) => event.type === "auth_challenge");
    if (!challenge || challenge.type !== "auth_challenge") {
      throw new Error("auth_challenge missing");
    }

    events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: "challenge-wrong",
      nonce: challenge.nonce,
      principalId: "user:alice",
    }), emit, { connectionId: "conn-1" });

    const result = events.find((event) => event.type === "auth_result");
    if (!result || result.type !== "auth_result") throw new Error("expected auth_result");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/challenge ID does not match/i);
  });

  it("auth_proof probe resends active challenge without emitting auth_result", () => {
    const { emit, events } = collectEvents();
    router.registerConnection("conn-1", emit);
    const initialChallenge = events.find((event) => event.type === "auth_challenge");
    if (!initialChallenge || initialChallenge.type !== "auth_challenge") {
      throw new Error("auth_challenge missing");
    }

    events.length = 0;
    router.handleMessage({
      type: "auth_proof",
      principalType: "user",
      principalId: "user:alice",
      publicKey: "probe",
      challengeId: "",
      nonce: "",
      signature: "",
      algorithm: "ed25519",
    }, emit, { connectionId: "conn-1" });

    const resentChallenge = events.find((event) => event.type === "auth_challenge");
    if (!resentChallenge || resentChallenge.type !== "auth_challenge") {
      throw new Error("expected resent auth_challenge");
    }
    expect(resentChallenge.challengeId).toBe(initialChallenge.challengeId);

    const result = events.find((event) => event.type === "auth_result");
    expect(result).toBeUndefined();
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

    expect(acpSession.prompt).toHaveBeenCalledWith("hello", []);

    // Wait for the promise to resolve and turn_end to be emitted
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });

    const turnEnd = events.find((e) => e.type === "turn_end");
    if (!turnEnd || turnEnd.type !== "turn_end") throw new Error("expected turn_end");
    expect(turnEnd.executionId).toBeDefined();
    expect(turnEnd.turnId).toBeDefined();
    expect(turnEnd.policySnapshotId).toBeDefined();
    const execution = turnEnd.executionId ? stateStore.getExecution(turnEnd.executionId) : null;
    expect(execution?.state).toBe("succeeded");
    expect(execution?.completedAt).toBeTruthy();
  });

  it("prompt forwards image inputs to session.prompt", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });
    const created = events.find((e) => e.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("session_created missing");

    events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "what is in this image?",
      images: [{ url: "https://example.com/sample.png", mediaType: "image/png" }],
    }, emit);

    expect(acpSession.prompt).toHaveBeenCalledWith(
      "what is in this image?",
      [{ url: "https://example.com/sample.png", mediaType: "image/png" }],
    );
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

  it("prompt propagates parentExecutionId correlation and persists execution parent link", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });
    const created = events.find((e) => e.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("session_created missing");

    stateStore.createExecution({
      id: "exec-parent-1",
      sessionId: created.sessionId,
      turnId: "turn-parent-1",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:local",
      source: "interactive",
      runtimeId: "default",
      model: "claude",
      policySnapshotId: "policy-parent",
      state: "running",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      startedAt: "2026-01-01T00:00:00Z",
    });

    events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "child execution",
      parentExecutionId: "exec-parent-1",
    }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
    });
    const turnEnd = events.find((e) => e.type === "turn_end");
    if (!turnEnd || turnEnd.type !== "turn_end") throw new Error("turn_end missing");
    expect(turnEnd.parentExecutionId).toBe("exec-parent-1");
    const execution = turnEnd.executionId ? stateStore.getExecution(turnEnd.executionId) : null;
    expect(execution?.parentExecutionId).toBe("exec-parent-1");
  });

  it("prompt rejects unknown parentExecutionId", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });
    const created = events.find((e) => e.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("session_created missing");

    events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "child execution",
      parentExecutionId: "exec-missing",
    }, emit);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].message).toMatch(/parentExecutionId/i);
    }
    expect(acpSession.prompt).not.toHaveBeenCalled();
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

  it("binds session event emitter once and reuses dispatcher across prompts", async () => {
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

    expect(acpSession.onEvent).toHaveBeenCalledTimes(1);
    expect(typeof (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("function");
  });

  it("keeps overlapping prompt turn routing and finalization independent", async () => {
    const firstPrompt = createDeferred<{ stopReason?: string; content?: unknown }>();
    const secondPrompt = createDeferred<{ stopReason?: string; content?: unknown }>();
    (acpSession.prompt as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const owner = collectEvents();
    router.handleMessage({ type: "session_new" }, owner.emit);
    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });
    const sessionCreated = owner.events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") {
      throw new Error("session_created event missing");
    }

    owner.events.length = 0;
    router.handleMessage(
      { type: "prompt", sessionId: sessionCreated.sessionId, text: "first prompt" },
      owner.emit,
    );
    router.handleMessage(
      { type: "prompt", sessionId: sessionCreated.sessionId, text: "second prompt" },
      owner.emit,
    );

    const eventHandler = (acpSession.onEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as EventEmitter;
    eventHandler({
      type: "text_delta",
      sessionId: sessionCreated.sessionId,
      delta: "first-stream",
    });
    eventHandler({
      type: "turn_end",
      sessionId: sessionCreated.sessionId,
      stopReason: "end_turn",
    });
    firstPrompt.resolve({ stopReason: "end_turn" });
    secondPrompt.resolve({
      stopReason: "end_turn",
      content: { type: "text", text: "second-final" },
    });

    await vi.waitFor(() => {
      expect(owner.events.filter((e) => e.type === "turn_end")).toHaveLength(2);
    });

    const turnEnds = owner.events.filter((e): e is Extract<GatewayEvent, { type: "turn_end" }> => e.type === "turn_end");
    const firstText = owner.events.find((e): e is Extract<GatewayEvent, { type: "text_delta" }> => (
      e.type === "text_delta" && e.delta === "first-stream"
    ));
    const secondText = owner.events.find((e): e is Extract<GatewayEvent, { type: "text_delta" }> => (
      e.type === "text_delta" && e.delta === "second-final"
    ));

    expect(firstText?.executionId).toBe(turnEnds[0]?.executionId);
    expect(secondText?.executionId).toBe(turnEnds[1]?.executionId);

    const executions = stateStore.listExecutions(sessionCreated.sessionId, 10);
    const succeeded = executions.filter((execution) => execution.state === "succeeded");
    expect(succeeded).toHaveLength(2);

    const closed = router.sweepIdleSessions(new Date(Date.now() + 31 * 60 * 1000));
    expect(closed).toContain(sessionCreated.sessionId);
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
      expect(events[0].hasMore).toBe(false);
    }
  });

  it("session_list returns only authenticated principal sessions", async () => {
    stateStore.createSession({
      id: "sess-owned",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:web:user-1",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-owned",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:01:00.000Z",
      tokenUsage: { input: 1, output: 2 },
      model: "claude",
    });
    stateStore.createSession({
      id: "sess-other",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:web:user-2",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-other",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:01:00.000Z",
      tokenUsage: { input: 1, output: 2 },
      model: "claude",
    });
    stateStore.createSession({
      id: "sess-local",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:local",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-local",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:01:00.000Z",
      tokenUsage: { input: 1, output: 2 },
      model: "claude",
    });

    const { emit, events } = collectEvents();
    router.registerConnection("conn-list", emit);
    router.handleMessage({
      type: "auth_proof",
      principalId: "user:web:user-1",
      publicKey: "",
      challengeId: "",
      nonce: "",
      signature: "",
      algorithm: "ed25519",
    }, emit, { connectionId: "conn-list" });

    const challenge = events.find((event): event is Extract<GatewayEvent, { type: "auth_challenge" }> => event.type === "auth_challenge");
    if (!challenge) throw new Error("expected auth_challenge");
    events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:web:user-1",
    }), emit, { connectionId: "conn-list" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "auth_result" && event.ok)).toBe(true);
    });

    events.length = 0;
    router.handleMessage({ type: "session_list" }, emit, { connectionId: "conn-list" });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_list");
    if (events[0].type !== "session_list") throw new Error("expected session_list");
    expect(events[0].sessions.map((session) => session.id)).toEqual(["sess-owned"]);
  });

  it("session_list supports principal pagination via limit and cursor", async () => {
    stateStore.createSession({
      id: "sess-owned-1",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:web:user-1",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-owned-1",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:03:00.000Z",
      tokenUsage: { input: 1, output: 1 },
      model: "claude",
    });
    stateStore.createSession({
      id: "sess-owned-2",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:web:user-1",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-owned-2",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:02:00.000Z",
      tokenUsage: { input: 1, output: 1 },
      model: "claude",
    });

    const { emit, events } = collectEvents();
    router.registerConnection("conn-list-page", emit);
    router.handleMessage({
      type: "auth_proof",
      principalId: "user:web:user-1",
      publicKey: "",
      challengeId: "",
      nonce: "",
      signature: "",
      algorithm: "ed25519",
    }, emit, { connectionId: "conn-list-page" });
    const challenge = events.find((event): event is Extract<GatewayEvent, { type: "auth_challenge" }> => event.type === "auth_challenge");
    if (!challenge) throw new Error("expected auth_challenge");
    events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:web:user-1",
    }), emit, { connectionId: "conn-list-page" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "auth_result" && event.ok)).toBe(true);
    });

    events.length = 0;
    router.handleMessage({ type: "session_list", limit: 1 }, emit, { connectionId: "conn-list-page" });
    expect(events).toHaveLength(1);
    const firstPage = events[0];
    if (firstPage.type !== "session_list") throw new Error("expected session_list");
    expect(firstPage.sessions.map((session) => session.id)).toEqual(["sess-owned-1"]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeDefined();
    if (!firstPage.nextCursor) throw new Error("expected nextCursor");

    events.length = 0;
    router.handleMessage({
      type: "session_list",
      limit: 1,
      cursor: firstPage.nextCursor,
    }, emit, { connectionId: "conn-list-page" });
    expect(events).toHaveLength(1);
    const secondPage = events[0];
    if (secondPage.type !== "session_list") throw new Error("expected session_list");
    expect(secondPage.sessions.map((session) => session.id)).toEqual(["sess-owned-2"]);
    expect(secondPage.hasMore).toBe(false);
  });

  it("session_lifecycle_query returns persisted lifecycle history for the owner", async () => {
    stateStore.createSession({
      id: "sess-history",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:web:user-1",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-history",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:01:00.000Z",
      tokenUsage: { input: 1, output: 2 },
      model: "claude",
    });
    stateStore.applySessionLifecycleEvent("sess-history", {
      eventType: "TRANSFER_REQUESTED",
      parkedReason: "transfer_pending",
      reason: "transfer_requested",
      actorPrincipalType: "user",
      actorPrincipalId: "user:web:user-1",
      at: "2026-03-01T00:02:00.000Z",
    });

    const { emit, events } = collectEvents();
    router.registerConnection("conn-history", emit);
    const challenge = events.find((event): event is Extract<GatewayEvent, { type: "auth_challenge" }> => event.type === "auth_challenge");
    if (!challenge) throw new Error("expected auth_challenge");

    events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:web:user-1",
    }), emit, { connectionId: "conn-history" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "auth_result" && event.ok)).toBe(true);
    });

    events.length = 0;
    router.handleMessage({ type: "session_lifecycle_query", sessionId: "sess-history", limit: 5 }, emit, {
      connectionId: "conn-history",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_lifecycle_result");
    if (events[0].type !== "session_lifecycle_result") throw new Error("expected session_lifecycle_result");
    expect(events[0].events.map((event) => event.eventType)).toEqual([
      "TRANSFER_REQUESTED",
      "SESSION_CREATED",
    ]);
  });

  it("session_lifecycle_query rejects non-owner principal", async () => {
    stateStore.createSession({
      id: "sess-history-denied",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:web:user-1",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-history-denied",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:01:00.000Z",
      tokenUsage: { input: 1, output: 2 },
      model: "claude",
    });

    const { emit, events } = collectEvents();
    router.registerConnection("conn-history-denied", emit);
    const challenge = events.find((event): event is Extract<GatewayEvent, { type: "auth_challenge" }> => event.type === "auth_challenge");
    if (!challenge) throw new Error("expected auth_challenge");

    events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:web:user-2",
    }), emit, { connectionId: "conn-history-denied" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "auth_result" && event.ok)).toBe(true);
    });

    events.length = 0;
    router.handleMessage({ type: "session_lifecycle_query", sessionId: "sess-history-denied" }, emit, {
      connectionId: "conn-history-denied",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type !== "error") throw new Error("expected error");
    expect(events[0].message).toMatch(/does not own this session/i);
  });

  it("session_rename persists displayName and emits session_updated", async () => {
    stateStore.createSession({
      id: "sess-rename",
      workspaceId: "default",
      principalType: "user",
      principalId: "user:web:user-1",
      source: "interactive",
      runtimeId: "claude",
      acpSessionId: "acp-rename",
      status: "active",
      createdAt: "2026-03-01T00:00:00.000Z",
      lastActivityAt: "2026-03-01T00:01:00.000Z",
      tokenUsage: { input: 1, output: 2 },
      model: "claude",
    });

    const { emit, events } = collectEvents();
    router.registerConnection("conn-rename", emit);
    const challenge = events.find((event): event is Extract<GatewayEvent, { type: "auth_challenge" }> => event.type === "auth_challenge");
    if (!challenge) throw new Error("expected auth_challenge");

    events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:web:user-1",
    }), emit, { connectionId: "conn-rename" });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "auth_result" && event.ok)).toBe(true);
    });

    events.length = 0;
    router.handleMessage({
      type: "session_rename",
      sessionId: "sess-rename",
      displayName: "Gateway rename path",
    }, emit, { connectionId: "conn-rename" });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_updated");
    if (events[0].type !== "session_updated") throw new Error("expected session_updated");
    expect(events[0].displayName).toBe("Gateway rename path");
    expect(stateStore.getSession("sess-rename")?.displayName).toBe("Gateway rename path");
  });

  it("prompt auto-derives a displayName on first user prompt", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "Investigate websocket drift in the parked transfer flow and summarize likely causes",
    }, emit);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_updated")).toBe(true);
    });
    const updated = events.find((event): event is Extract<GatewayEvent, { type: "session_updated" }> => event.type === "session_updated");
    expect(updated?.displayName).toBe("Investigate websocket drift in the parked tra...");
    expect(stateStore.getSession(created.sessionId)?.displayName).toBe("Investigate websocket drift in the parked tra...");
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

    expect(events.some((event) => (
      event.type === "session_lifecycle"
      && event.sessionId === sessionCreated.sessionId
      && event.eventType === "SESSION_CLOSED"
      && event.fromState === "live"
      && event.toState === "closed"
    ))).toBe(true);
    const closedEvent = events.find((event): event is Extract<GatewayEvent, { type: "session_closed" }> => event.type === "session_closed");
    expect(closedEvent).toEqual({
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

  it("session_transfer_request requires authenticated requester principal", async () => {
    const owner = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });

    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((e) => e.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    owner.events.length = 0;
    router.handleMessage({
      type: "session_transfer_request",
      sessionId: created.sessionId,
      targetPrincipalId: "user:bob",
      targetPrincipalType: "user",
    }, owner.emit, { connectionId: "conn-owner" });

    expect(owner.events).toHaveLength(1);
    expect(owner.events[0].type).toBe("error");
    if (owner.events[0].type === "error") {
      expect(owner.events[0].message).toMatch(/requires authenticated/i);
    }
  });

  it("session_transfer_request rejects requester principal that does not own session", async () => {
    const owner = collectEvents();
    const requester = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.registerConnection("conn-requester", requester.emit);
    const challenge = owner.events.find((event) => event.type === "auth_challenge");
    const requesterChallenge = requester.events.find((event) => event.type === "auth_challenge");
    if (!challenge || challenge.type !== "auth_challenge") throw new Error("auth_challenge missing");
    if (!requesterChallenge || requesterChallenge.type !== "auth_challenge") {
      throw new Error("requester auth_challenge missing");
    }

    owner.events.length = 0;
    requester.events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: requesterChallenge.challengeId,
      nonce: requesterChallenge.nonce,
      principalId: "user:mallory",
    }), requester.emit, { connectionId: "conn-requester" });
    expect(owner.events.some((event) => event.type === "auth_result")).toBe(true);
    expect(requester.events.some((event) => event.type === "auth_result")).toBe(true);

    owner.events.length = 0;
    requester.events.length = 0;
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((e) => e.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    requester.events.length = 0;
    router.handleMessage({
      type: "session_transfer_request",
      sessionId: created.sessionId,
      targetPrincipalId: "user:bob",
      targetPrincipalType: "user",
    }, requester.emit, { connectionId: "conn-requester" });

    expect(requester.events).toHaveLength(1);
    expect(requester.events[0].type).toBe("error");
    if (requester.events[0].type === "error") {
      expect(requester.events[0].message).toMatch(/owned by another connection|does not own this session/i);
    }
  });

  it("session_transfer_request rebinds local principal after reconnect ownership takeover", async () => {
    const owner = collectEvents();
    router.registerConnection("conn-owner-old", owner.emit);
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner-old" });
    await vi.waitFor(() => {
      expect(owner.events.some((e) => e.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((e) => e.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    router.unregisterConnection("conn-owner-old", owner.emit);
    owner.events.length = 0;

    router.registerConnection("conn-owner-new", owner.emit);
    const challenge = owner.events.find((event) => event.type === "auth_challenge");
    if (!challenge || challenge.type !== "auth_challenge") throw new Error("auth_challenge missing");

    owner.events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner-new" });
    expect(owner.events.some((event) => event.type === "auth_result")).toBe(true);

    owner.events.length = 0;
    router.handleMessage({
      type: "session_transfer_request",
      sessionId: created.sessionId,
      targetPrincipalId: "user:bob",
      targetPrincipalType: "user",
    }, owner.emit, { connectionId: "conn-owner-new" });

    const requested = owner.events.find((event) => event.type === "session_transfer_requested");
    expect(requested?.type).toBe("session_transfer_requested");

    const persisted = stateStore.getSession(created.sessionId);
    expect(persisted?.principalType).toBe("user");
    expect(persisted?.principalId).toBe("user:alice");
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
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: targetChallenge.challengeId,
      nonce: targetChallenge.nonce,
      principalId: "user:bob",
    }), target.emit, { connectionId: "conn-target" });

    owner.events.length = 0;
    target.events.length = 0;
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect(owner.events.some((event) => event.type === "session_created")).toBe(true);
    });
    const policyContext = createAcpSessionMock.mock.calls.at(-1)?.[3] as SessionPolicyContext | undefined;
    expect(policyContext).toBeDefined();
    expect(policyContext?.principalId).toBe("user:alice");
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
    expect(policyContext?.principalId).toBe("user:bob");
    expect(policyContext?.principalType).toBe("user");
    expect(policyContext?.source).toBe("interactive");

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

  it("session_transfer_dismiss unblocks owner and clears pending transfer", async () => {
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
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: targetChallenge.challengeId,
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
    expect(target.events.some((event) => event.type === "session_transfer_requested")).toBe(true);

    owner.events.length = 0;
    target.events.length = 0;
    router.handleMessage({
      type: "session_transfer_dismiss",
      sessionId: created.sessionId,
    }, target.emit, { connectionId: "conn-target" });

    const ownerDismiss = owner.events.find((event) => (
      event.type === "session_transfer_updated" && event.state === "dismissed"
    ));
    const targetDismiss = target.events.find((event) => (
      event.type === "session_transfer_updated" && event.state === "dismissed"
    ));
    expect(ownerDismiss).toBeDefined();
    expect(targetDismiss).toBeDefined();

    owner.events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "resume after dismiss",
    }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect((acpSession.prompt as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("resume after dismiss", []);
    });
  });

  it("requested transfer survives owner disconnect and can still be accepted", async () => {
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
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: targetChallenge.challengeId,
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

    expect(stateStore.getSessionTransfer(created.sessionId)?.state).toBe("requested");
    router.unregisterConnection("conn-owner", owner.emit);
    expect(stateStore.getSessionTransfer(created.sessionId)?.state).toBe("requested");

    target.events.length = 0;
    router.handleMessage({
      type: "session_transfer_accept",
      sessionId: created.sessionId,
    }, target.emit, { connectionId: "conn-target" });

    expect(target.events.some((event) => event.type === "session_transferred")).toBe(true);
    expect(stateStore.getSessionTransfer(created.sessionId)).toBeNull();
    expect(stateStore.getSession(created.sessionId)?.principalId).toBe("user:bob");
  });

  it("expired transfer remains parked until owner prompt resumes", async () => {
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
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: targetChallenge.challengeId,
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

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    router.handleMessage({
      type: "session_transfer_request",
      sessionId: created.sessionId,
      targetPrincipalId: "user:bob",
      targetPrincipalType: "user",
      expiresInMs: 5_000,
    }, owner.emit, { connectionId: "conn-owner" });

    target.events.length = 0;
    nowSpy.mockReturnValue(1_010_000);
    router.handleMessage({
      type: "session_transfer_accept",
      sessionId: created.sessionId,
    }, target.emit, { connectionId: "conn-target" });
    nowSpy.mockRestore();

    const expiredUpdate = target.events.find((event) => (
      event.type === "session_transfer_updated" && event.state === "expired"
    ));
    expect(expiredUpdate).toBeDefined();
    const expiredError = target.events.find((event) => event.type === "error");
    expect(expiredError).toBeDefined();
    if (expiredError?.type === "error") {
      expect(expiredError.message).toMatch(/remains parked/i);
    }

    owner.events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "resume parked session",
    }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect((acpSession.prompt as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("resume parked session", []);
    });
    expect(owner.events.some((event) => (
      event.type === "session_transfer_updated" && event.state === "cancelled"
    ))).toBe(true);
  });

  it("rehydrates persisted transfer and accepts it after router restart", async () => {
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
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: targetChallenge.challengeId,
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

    expect(stateStore.getSessionTransfer(created.sessionId)?.state).toBe("requested");

    const restartedSession = {
      ...mockAcpSession(),
      id: created.sessionId,
      acpSessionId: "acp-restored-transfer",
    };
    createAcpSessionMock = vi.fn(async () => restartedSession);
    router = createRouter({
      createAcpSession: createAcpSessionMock,
      stateStore,
      policyConfig,
      memoryProvider,
      defaultWorkspaceId: "default",
    });

    const targetAfterRestart = collectEvents();
    router.registerConnection("conn-target-restarted", targetAfterRestart.emit);
    const targetRestartChallenge = targetAfterRestart.events.find((event) => event.type === "auth_challenge");
    if (!targetRestartChallenge || targetRestartChallenge.type !== "auth_challenge") {
      throw new Error("restart target auth_challenge missing");
    }

    targetAfterRestart.events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: targetRestartChallenge.challengeId,
      nonce: targetRestartChallenge.nonce,
      principalId: "user:bob",
    }), targetAfterRestart.emit, { connectionId: "conn-target-restarted" });
    targetAfterRestart.events.length = 0;

    router.handleMessage({
      type: "session_transfer_accept",
      sessionId: created.sessionId,
    }, targetAfterRestart.emit, { connectionId: "conn-target-restarted" });

    await vi.waitFor(() => {
      expect(createAcpSessionMock).toHaveBeenCalledWith(
        "default",
        "claude",
        targetAfterRestart.emit,
        {
          principalType: "user",
          principalId: "user:alice",
          source: "interactive",
          workspaceId: "default",
        },
        { gatewaySessionId: created.sessionId },
      );
    });
    await vi.waitFor(() => {
      expect(targetAfterRestart.events.some((event) => event.type === "session_transferred")).toBe(true);
    });

    expect(targetAfterRestart.events.some((event) => event.type === "session_invalidated")).toBe(true);
    expect(stateStore.getSessionTransfer(created.sessionId)).toBeNull();
    expect(stateStore.getSession(created.sessionId)?.principalId).toBe("user:bob");
    expect(stateStore.getSession(created.sessionId)?.lifecycleState).toBe("live");
  });

  it("session_takeover replays parked session for a different authenticated principal and persists new ownership", async () => {
    const owner = collectEvents();
    const taker = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.registerConnection("conn-taker", taker.emit);

    const ownerChallenge = owner.events.find((event) => event.type === "auth_challenge");
    const takerChallenge = taker.events.find((event) => event.type === "auth_challenge");
    if (!ownerChallenge || ownerChallenge.type !== "auth_challenge") throw new Error("owner auth_challenge missing");
    if (!takerChallenge || takerChallenge.type !== "auth_challenge") throw new Error("taker auth_challenge missing");

    owner.events.length = 0;
    taker.events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: takerChallenge.challengeId,
      nonce: takerChallenge.nonce,
      principalId: "user:bob",
    }), taker.emit, { connectionId: "conn-taker" });

    owner.events.length = 0;
    taker.events.length = 0;
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect(owner.events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    router.unregisterConnection("conn-owner", owner.emit);
    const parked = stateStore.getSession(created.sessionId);
    expect(parked?.lifecycleState).toBe("parked");
    expect(parked?.parkedReason).toBe("owner_disconnected");

    taker.events.length = 0;
    router.handleMessage({
      type: "session_takeover",
      sessionId: created.sessionId,
    }, taker.emit, { connectionId: "conn-taker" });

    expect(taker.events.some((event) => event.type === "transcript" && event.sessionId === created.sessionId)).toBe(true);
    expect(taker.events.some((event) => (
      event.type === "session_lifecycle"
      && event.sessionId === created.sessionId
      && event.eventType === "TAKEOVER"
      && event.fromState === "parked"
      && event.toState === "live"
    ))).toBe(true);
    expect(stateStore.getSession(created.sessionId)?.principalId).toBe("user:bob");
    expect(stateStore.getSession(created.sessionId)?.lifecycleState).toBe("live");
  });

  it("session_takeover rejects non-parked sessions", async () => {
    const seed = collectEvents();
    router.handleMessage({
      type: "session_new",
      principalType: "user",
      principalId: "user:alice",
      source: "interactive",
    }, seed.emit);

    await vi.waitFor(() => {
      expect(seed.events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = seed.events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    const owner = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    const ownerChallenge = owner.events.find((event) => event.type === "auth_challenge");
    if (!ownerChallenge || ownerChallenge.type !== "auth_challenge") throw new Error("owner auth_challenge missing");

    owner.events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });

    owner.events.length = 0;
    router.handleMessage({
      type: "session_takeover",
      sessionId: created.sessionId,
    }, owner.emit, { connectionId: "conn-owner" });

    expect(owner.events).toEqual([
      {
        type: "error",
        sessionId: created.sessionId,
        message: "Session is not parked and cannot be taken over.",
      },
    ]);
  });

  it("rejects ownerless replay claims from different authenticated principal", async () => {
    const owner = collectEvents();
    const other = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.registerConnection("conn-other", other.emit);

    const ownerChallenge = owner.events.find((event) => event.type === "auth_challenge");
    const otherChallenge = other.events.find((event) => event.type === "auth_challenge");
    if (!ownerChallenge || ownerChallenge.type !== "auth_challenge") throw new Error("owner auth_challenge missing");
    if (!otherChallenge || otherChallenge.type !== "auth_challenge") throw new Error("other auth_challenge missing");

    owner.events.length = 0;
    other.events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });
    router.handleMessage(createAuthProof({
      challengeId: otherChallenge.challengeId,
      nonce: otherChallenge.nonce,
      principalId: "user:bob",
    }), other.emit, { connectionId: "conn-other" });

    owner.events.length = 0;
    other.events.length = 0;
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect(owner.events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    router.unregisterConnection("conn-owner", owner.emit);
    other.events.length = 0;
    router.handleMessage({
      type: "session_replay",
      sessionId: created.sessionId,
    }, other.emit, { connectionId: "conn-other" });

    const denied = other.events.find((event) => event.type === "error");
    expect(denied).toBeDefined();
    if (denied?.type === "error") {
      expect(denied.message).toMatch(/does not own this session/i);
    }
  });

  it("owner prompt resumes session parked by owner disconnect", async () => {
    const owner = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });

    await vi.waitFor(() => {
      expect(owner.events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    router.unregisterConnection("conn-owner", owner.emit);
    const parked = stateStore.getSession(created.sessionId);
    expect(parked?.lifecycleState).toBe("parked");
    expect(parked?.parkedReason).toBe("owner_disconnected");

    const resumed = collectEvents();
    router.registerConnection("conn-resumed", resumed.emit);
    resumed.events.length = 0;
    router.handleMessage({
      type: "prompt",
      sessionId: created.sessionId,
      text: "resume after disconnect",
    }, resumed.emit, { connectionId: "conn-resumed" });

    await vi.waitFor(() => {
      expect((acpSession.prompt as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("resume after disconnect", []);
    });
    const live = stateStore.getSession(created.sessionId);
    expect(live?.lifecycleState).toBe("live");
    expect(live?.parkedReason).toBeUndefined();
  });

  it("broadcasts session_transfer_requested to unverified channel multiplexer with matching owned principal session", async () => {
    let sessionCounter = 0;
    createAcpSessionMock.mockImplementation(async () => {
      sessionCounter += 1;
      return {
        ...mockAcpSession(),
        id: `gw-session-${sessionCounter}`,
        acpSessionId: `acp-session-${sessionCounter}`,
      };
    });

    const owner = collectEvents();
    const channel = collectEvents();
    router.registerConnection("conn-owner", owner.emit);
    router.registerConnection("conn-channel", channel.emit);

    const ownerChallenge = owner.events.find((event) => event.type === "auth_challenge");
    if (!ownerChallenge || ownerChallenge.type !== "auth_challenge") throw new Error("owner auth_challenge missing");

    owner.events.length = 0;
    channel.events.length = 0;
    router.handleMessage(createAuthProof({
      challengeId: ownerChallenge.challengeId,
      nonce: ownerChallenge.nonce,
      principalId: "user:alice",
    }), owner.emit, { connectionId: "conn-owner" });

    router.handleMessage({
      type: "session_new",
      principalType: "user",
      principalId: "user:bob",
      source: "api",
    }, channel.emit, { connectionId: "conn-channel" });
    await vi.waitFor(() => {
      expect(channel.events.some((event) => event.type === "session_created")).toBe(true);
    });

    owner.events.length = 0;
    channel.events.length = 0;
    router.handleMessage({ type: "session_new" }, owner.emit, { connectionId: "conn-owner" });
    await vi.waitFor(() => {
      expect(owner.events.some((event) => event.type === "session_created")).toBe(true);
    });
    const created = owner.events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");

    owner.events.length = 0;
    channel.events.length = 0;
    router.handleMessage({
      type: "session_transfer_request",
      sessionId: created.sessionId,
      targetPrincipalId: "user:bob",
      targetPrincipalType: "user",
    }, owner.emit, { connectionId: "conn-owner" });

    expect(owner.events.some((event) => event.type === "session_transfer_requested")).toBe(true);
    expect(channel.events.some((event) => event.type === "session_transfer_requested")).toBe(true);
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
    expect(owner.events[0]).toEqual({
      type: "error",
      sessionId: created.sessionId,
      message: "Runtime unavailable: default (runtime_unavailable)",
    });
    expect(owner.events.some((event) => (
      event.type === "session_lifecycle"
      && event.sessionId === created.sessionId
      && event.eventType === "SESSION_CLOSED"
      && event.toState === "closed"
    ))).toBe(true);
    expect(owner.events.some((event) => (
      event.type === "session_closed"
      && event.sessionId === created.sessionId
      && event.reason === "runtime_unavailable"
    ))).toBe(true);

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

  it("usage_query summary returns token, execution, and memory aggregates", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    const sessionRecord = stateStore.getSession(sessionId);
    if (!sessionRecord) throw new Error("expected session record");
    stateStore.updateSession(sessionId, { tokenUsage: { input: 11, output: 5 } });
    const now = new Date().toISOString();
    stateStore.createExecution({
      id: "exec-usage-1",
      sessionId,
      turnId: "turn-1",
      workspaceId: sessionRecord.workspaceId,
      principalType: sessionRecord.principalType,
      principalId: sessionRecord.principalId,
      source: sessionRecord.source,
      runtimeId: sessionRecord.runtimeId,
      model: sessionRecord.model,
      policySnapshotId: "ps-1",
      state: "queued",
      createdAt: now,
      updatedAt: now,
    });
    stateStore.createExecution({
      id: "exec-usage-2",
      sessionId,
      turnId: "turn-2",
      workspaceId: sessionRecord.workspaceId,
      principalType: sessionRecord.principalType,
      principalId: sessionRecord.principalId,
      source: sessionRecord.source,
      runtimeId: sessionRecord.runtimeId,
      model: sessionRecord.model,
      policySnapshotId: "ps-2",
      state: "running",
      createdAt: now,
      updatedAt: now,
    });

    events.length = 0;
    router.handleMessage({ type: "usage_query", sessionId, action: "summary" }, emit);

    expect(events).toHaveLength(1);
    const summaryEvent = events[0];
    if (summaryEvent.type !== "usage_result" || summaryEvent.action !== "summary") {
      throw new Error("expected usage_result summary");
    }
    expect(summaryEvent.summary.tokens).toEqual({ input: 11, output: 5, total: 16 });
    expect(summaryEvent.summary.executions.total).toBe(2);
    expect(summaryEvent.summary.executions.queued).toBe(1);
    expect(summaryEvent.summary.executions.running).toBe(1);
    expect(summaryEvent.summary.memory?.session.total).toBe(3);
    expect(summaryEvent.summary.memory?.workspace.total).toBe(3);
    expect(memoryProvider.getStats).toHaveBeenCalledWith({
      workspaceId: "default",
      sessionId,
      scope: "session",
    });
    expect(memoryProvider.getStats).toHaveBeenCalledWith({
      workspaceId: "default",
      sessionId,
      scope: "workspace",
    });
  });

  it("usage_query stats returns usage_result", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    events.length = 0;
    router.handleMessage({ type: "usage_query", sessionId, action: "stats", scope: "workspace" }, emit);

    expect(memoryProvider.getStats).toHaveBeenCalledWith({
      workspaceId: "default",
      sessionId,
      scope: "workspace",
    });
    expect(events).toHaveLength(1);
    const statsEvent = events[0];
    if (statsEvent.type !== "usage_result" || statsEvent.action !== "stats") {
      throw new Error("expected usage_result stats");
    }
    expect(statsEvent.scope).toBe("workspace");
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

  it("usage_query search validates query text", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionId = (events[0] as Extract<GatewayEvent, { type: "session_created" }>).sessionId;
    events.length = 0;
    router.handleMessage({ type: "usage_query", sessionId, action: "search", query: " " }, emit);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].message).toMatch(/query is required/i);
    }
  });

  it("usage_query summary reflects prompt token usage deltas", async () => {
    const promptMock = acpSession.prompt as ReturnType<typeof vi.fn>;
    promptMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      content: { type: "text", text: "assistant token payload" },
    });

    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session_created")).toBe(true);
    });

    const created = events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") throw new Error("expected session_created");
    const sessionId = created.sessionId;

    events.length = 0;
    router.handleMessage({ type: "prompt", sessionId, text: "count these tokens please" }, emit);

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "turn_end")).toBe(true);
    });

    events.length = 0;
    router.handleMessage({ type: "usage_query", sessionId, action: "summary" }, emit);
    const usageSummary = events.find((event) => event.type === "usage_result");
    if (!usageSummary || usageSummary.type !== "usage_result" || usageSummary.action !== "summary") {
      throw new Error("expected usage summary");
    }

    expect(usageSummary.summary.tokens.input).toBeGreaterThan(0);
    expect(usageSummary.summary.tokens.output).toBeGreaterThan(0);
    expect(usageSummary.summary.tokens.total).toBe(
      usageSummary.summary.tokens.input + usageSummary.summary.tokens.output,
    );
  });
});
