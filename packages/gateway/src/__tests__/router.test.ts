import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStateStore, type StateStore } from "@nexus/state";
import type { PolicyConfig, GatewayEvent, ClientMessage } from "@nexus/types";
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

describe("createRouter", () => {
  let stateStore: StateStore;
  let router: Router;
  let acpSession: ManagedAcpSession;
  let createAcpSessionMock: ReturnType<typeof vi.fn>;
  const policyConfig: PolicyConfig = {
    rules: [{ tool: "*", action: "allow" }],
  };

  beforeEach(() => {
    stateStore = createStateStore(":memory:");
    acpSession = mockAcpSession();
    createAcpSessionMock = vi.fn(async (_runtimeId, _model, _onEvent: EventEmitter) => acpSession);
    router = createRouter({
      createAcpSession: createAcpSessionMock,
      stateStore,
      policyConfig,
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

  it("prompt rebinds session event emitter to current client emit callback", async () => {
    const first = collectEvents();
    router.handleMessage({ type: "session_new" }, first.emit);

    await vi.waitFor(() => {
      expect(first.events.some((e) => e.type === "session_created")).toBe(true);
    });

    const sessionCreated = first.events.find((e) => e.type === "session_created");
    if (!sessionCreated || sessionCreated.type !== "session_created") {
      throw new Error("session_created event missing");
    }

    const second = collectEvents();
    router.handleMessage(
      { type: "prompt", sessionId: sessionCreated.sessionId, text: "hello" },
      second.emit,
    );

    expect(acpSession.onEvent).toHaveBeenCalledWith(second.emit);
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

  it("approval_response forwards to session.respondToPermission", async () => {
    const { emit, events } = collectEvents();
    router.handleMessage({ type: "session_new" }, emit);

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
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
});
