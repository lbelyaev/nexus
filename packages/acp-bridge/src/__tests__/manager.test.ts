import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Mock child_process before importing manager
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { spawnAgent } from "../manager.js";

const mockSpawn = vi.mocked(spawn);

const createMockProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    proc.emit("close", 0);
    return true;
  });
  return proc;
};

describe("spawnAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls spawn with the given command", () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as never);

    spawnAgent(["node", "agent.js", "--flag"]);

    expect(mockSpawn).toHaveBeenCalledWith("node", ["agent.js", "--flag"], expect.objectContaining({
      stdio: ["pipe", "pipe", "pipe"],
    }));
  });

  it("returns an AgentProcess with rpc client and process reference", () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as never);

    const agent = spawnAgent(["node", "agent.js"]);

    expect(agent.rpc).toBeDefined();
    expect(agent.rpc.sendRequest).toBeTypeOf("function");
    expect(agent.rpc.sendNotification).toBeTypeOf("function");
    expect(agent.process).toBe(mockProc);
  });

  it("killAgent sends SIGTERM to the process", async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as never);

    const agent = spawnAgent(["node", "agent.js"]);
    await agent.kill();

    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("isAlive returns true for running process, false after exit", () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc as never);

    const agent = spawnAgent(["node", "agent.js"]);

    expect(agent.isAlive()).toBe(true);

    // Simulate process exit
    mockProc.emit("close", 0);

    expect(agent.isAlive()).toBe(false);
  });
});
