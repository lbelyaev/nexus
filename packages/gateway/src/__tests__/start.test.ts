import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NexusConfig } from "@nexus/types";
import type { AgentProcess } from "@nexus/acp-bridge";
import type { Router } from "../router.js";
import { startGateway } from "../start.js";
import { loadConfig } from "../config.js";
import { createRouter } from "../router.js";
import { createGatewayServer } from "../server.js";
import { createStateStore } from "@nexus/state";
import { spawnAgent } from "@nexus/acp-bridge";

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(),
  repoRoot: "/tmp/nexus-test",
}));

vi.mock("../router.js", () => ({
  createRouter: vi.fn(),
}));

vi.mock("../server.js", () => ({
  createGatewayServer: vi.fn(),
}));

vi.mock("@nexus/state", () => ({
  createStateStore: vi.fn(),
}));

vi.mock("@nexus/acp-bridge", () => ({
  spawnAgent: vi.fn(),
  createAcpSession: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface MockAgentHandle {
  agent: AgentProcess;
  emitExit: (code: number | null) => void;
  sendRequest: ReturnType<typeof vi.fn>;
}

const createRuntimeConfig = (overrides?: Partial<NexusConfig>): NexusConfig => ({
  port: 18800,
  host: "127.0.0.1",
  auth: { token: "test-token" },
  runtime: { command: ["node", "agent.js"] },
  dataDir: "./data",
  memory: { enabled: false },
  ...overrides,
});

const createMockAgent = (options?: { initializeError?: string }): MockAgentHandle => {
  let exitHandler: ((code: number | null) => void) | null = null;
  const sendRequest = vi.fn(async (method: string) => {
    if (method === "initialize") {
      if (options?.initializeError) {
        throw new Error(options.initializeError);
      }
      return { ok: true };
    }
    if (method === "session/new") {
      return { sessionId: "acp-session-1", model: "claude" };
    }
    return {};
  });
  const agent: AgentProcess = {
    rpc: {
      sendRequest,
      sendNotification: vi.fn(),
      sendResponse: vi.fn(),
      sendErrorResponse: vi.fn(),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      destroy: vi.fn(),
    },
    process: {} as AgentProcess["process"],
    isAlive: vi.fn(() => true),
    kill: vi.fn(async () => {}),
    onExit: vi.fn((handler: (code: number | null) => void) => {
      exitHandler = handler;
    }),
  };

  return {
    agent,
    sendRequest,
    emitExit: (code: number | null) => {
      exitHandler?.(code);
    },
  };
};

const createRouterMock = (): Router => ({
  handleMessage: vi.fn(),
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
  setRuntimeHealth: vi.fn((runtimeId, status, reason) => ({
    runtimeId,
    status,
    updatedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  })),
  getRuntimeHealth: vi.fn(() => []),
  closeSessionsByRuntime: vi.fn(() => ["gw-session-1"]),
  sweepIdleSessions: vi.fn(() => []),
});

describe("startGateway runtime restart policy", () => {
  const loadConfigMock = vi.mocked(loadConfig);
  const createRouterMockFn = vi.mocked(createRouter);
  const createGatewayServerMock = vi.mocked(createGatewayServer);
  const createStateStoreMock = vi.mocked(createStateStore);
  const spawnAgentMock = vi.mocked(spawnAgent);
  let sigintListenersBefore: Function[] = [];
  let sigtermListenersBefore: Function[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sigintListenersBefore = process.listeners("SIGINT");
    sigtermListenersBefore = process.listeners("SIGTERM");

    createStateStoreMock.mockReturnValue({
      listSessions: vi.fn(() => []),
      close: vi.fn(),
      getChannelBinding: vi.fn(),
      upsertChannelBinding: vi.fn(),
      deleteChannelBinding: vi.fn(),
    } as unknown as ReturnType<typeof createStateStore>);

    createGatewayServerMock.mockReturnValue({
      start: vi.fn(async () => ({ port: 18800 })),
      stop: vi.fn(async () => {}),
    } as ReturnType<typeof createGatewayServer>);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const listener of process.listeners("SIGINT")) {
      if (!sigintListenersBefore.includes(listener)) {
        process.off("SIGINT", listener as (...args: unknown[]) => void);
      }
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!sigtermListenersBefore.includes(listener)) {
        process.off("SIGTERM", listener as (...args: unknown[]) => void);
      }
    }
  });

  it("auto-restarts runtime after transient process exit", async () => {
    const router = createRouterMock();
    createRouterMockFn.mockReturnValue(router);
    loadConfigMock.mockReturnValue(createRuntimeConfig({
      runtimeRestartMaxAttempts: 2,
      runtimeRestartBaseDelayMs: 10,
      runtimeRestartMaxDelayMs: 10,
    }));

    const firstAgent = createMockAgent();
    const secondAgent = createMockAgent();
    const agents = [firstAgent, secondAgent];
    spawnAgentMock.mockImplementation(() => {
      const next = agents.shift();
      if (!next) {
        throw new Error("No mock runtime agent available");
      }
      return next.agent;
    });

    const gateway = await startGateway("/tmp/nexus.json");
    expect(spawnAgentMock).toHaveBeenCalledTimes(1);

    firstAgent.emitExit(137);
    expect(router.closeSessionsByRuntime).toHaveBeenCalledWith("default", "runtime_restarting");

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(spawnAgentMock).toHaveBeenCalledTimes(2);
    expect(secondAgent.sendRequest).toHaveBeenCalledWith("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const statuses = vi.mocked(router.setRuntimeHealth).mock.calls.map((call) => call[1]);
    expect(statuses).toContain("degraded");
    expect(statuses).toContain("starting");
    expect(statuses).toContain("healthy");

    await gateway.server.stop();
    gateway.stateStore.close();
  });

  it("marks runtime unavailable after restart attempts are exhausted", async () => {
    const router = createRouterMock();
    createRouterMockFn.mockReturnValue(router);
    loadConfigMock.mockReturnValue(createRuntimeConfig({
      runtimeRestartMaxAttempts: 1,
      runtimeRestartBaseDelayMs: 5,
      runtimeRestartMaxDelayMs: 5,
    }));

    const firstAgent = createMockAgent();
    const failingRestartAgent = createMockAgent({ initializeError: "boom" });
    const agents = [firstAgent, failingRestartAgent];
    spawnAgentMock.mockImplementation(() => {
      const next = agents.shift();
      if (!next) {
        throw new Error("No mock runtime agent available");
      }
      return next.agent;
    });

    const gateway = await startGateway("/tmp/nexus.json");
    firstAgent.emitExit(1);
    await vi.advanceTimersByTimeAsync(5);
    await Promise.resolve();

    expect(spawnAgentMock).toHaveBeenCalledTimes(2);
    expect(router.closeSessionsByRuntime).toHaveBeenCalledWith("default", "runtime_restarting");
    expect(router.closeSessionsByRuntime).toHaveBeenCalledWith("default", "runtime_unavailable");
    expect(vi.mocked(router.setRuntimeHealth)).toHaveBeenCalledWith(
      "default",
      "unavailable",
      "restart_exhausted",
    );

    await gateway.server.stop();
    gateway.stateStore.close();
  });
});
