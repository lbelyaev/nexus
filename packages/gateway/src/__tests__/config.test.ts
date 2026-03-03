import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `nexus-config-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads valid JSON config and returns typed NexusConfig", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 9999,
        host: "0.0.0.0",
        auth: { token: "abc123" },
        runtime: { command: ["node", "agent.js"] },
        dataDir: "/tmp/data",
      }),
    );

    const config = loadConfig(configPath);
    expect(config.port).toBe(9999);
    expect(config.host).toBe("0.0.0.0");
    expect(config.auth.token).toBe("abc123");
    expect(config.runtime?.command).toEqual(["node", "agent.js"]);
    expect(config.dataDir).toBe("/tmp/data");
  });

  it("merges with defaults (port 18800, host 127.0.0.1)", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "cc-acp"] },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.port).toBe(18800);
    expect(config.host).toBe("127.0.0.1");
    expect(config.dataDir).toBe("./data");
  });

  it("generates a new auth token if token is empty string", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "" },
        runtime: { command: ["npx", "cc-acp"] },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.auth.token).toHaveLength(32);
    expect(config.auth.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("throws on missing runtime.command", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "tok" },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/runtime|runtimes/);
  });

  it("supports runtime registry with defaultRuntimeId", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        defaultRuntimeId: "codex",
        runtimes: {
          claude: { command: ["npx", "@zed-industries/claude-agent-acp"] },
          codex: { command: ["npx", "@zed-industries/codex-acp"] },
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.runtimes?.claude?.command).toEqual(["npx", "@zed-industries/claude-agent-acp"]);
    expect(config.runtimes?.codex?.command).toEqual(["npx", "@zed-industries/codex-acp"]);
    expect(config.defaultRuntimeId).toBe("codex");
  });

  it("rejects invalid defaultRuntimeId for registry", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        defaultRuntimeId: "missing",
        runtimes: {
          claude: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/defaultRuntimeId/);
  });

  it("supports modelRouting targeting runtime ids", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtimes: {
          claude: { command: ["npx", "@zed-industries/claude-agent-acp"] },
          codex: { command: ["npx", "@zed-industries/codex-acp"] },
        },
        modelRouting: {
          sonnet: "claude",
          "gpt-5": "codex",
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.modelRouting?.sonnet).toBe("claude");
    expect(config.modelRouting?.["gpt-5"]).toBe("codex");
  });

  it("supports modelAliases for explicit model pinning", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/codex-acp"], defaultModel: "gpt-5" },
        modelAliases: {
          "gpt-5": "gpt-5-2026-02-15",
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.modelAliases?.["gpt-5"]).toBe("gpt-5-2026-02-15");
  });

  it("rejects invalid modelAliases entries", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/codex-acp"] },
        modelAliases: {
          "": "gpt-5-2026-02-15",
        },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/modelAliases/);
  });

  it("supports modelCatalog per runtime", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtimes: {
          claude: { command: ["npx", "@zed-industries/claude-agent-acp"] },
          codex: { command: ["npx", "@zed-industries/codex-acp"] },
        },
        modelCatalog: {
          claude: ["claude-opus-4-1-20250805", "claude-sonnet-4-20250514"],
          codex: ["gpt-5.2-codex", "gpt-5.3-codex"],
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.modelCatalog?.claude).toContain("claude-opus-4-1-20250805");
    expect(config.modelCatalog?.codex).toContain("gpt-5.3-codex");
  });

  it("rejects modelCatalog pointing to unknown runtime", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtimes: {
          claude: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        },
        modelCatalog: {
          codex: ["gpt-5.2-codex"],
        },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/modelCatalog/);
  });

  it("supports memory config", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        memory: {
          enabled: true,
          provider: "sqlite",
          contextBudgetTokens: 900,
          hotMessageCount: 6,
          workspaceSummaryCount: 3,
          workspaceFactCount: 10,
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.memory?.enabled).toBe(true);
    expect(config.memory?.provider).toBe("sqlite");
    expect(config.memory?.contextBudgetTokens).toBe(900);
    expect(config.memory?.hotMessageCount).toBe(6);
    expect(config.memory?.workspaceSummaryCount).toBe(3);
    expect(config.memory?.workspaceFactCount).toBe(10);
  });

  it("rejects invalid memory numeric settings", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        memory: {
          contextBudgetTokens: 0,
        },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/memory.contextBudgetTokens/);
  });

  it("supports workspaceDefaultId", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        workspaceDefaultId: "acme-core",
      }),
    );

    const config = loadConfig(configPath);
    expect(config.workspaceDefaultId).toBe("acme-core");
  });

  it("rejects empty workspaceDefaultId", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        workspaceDefaultId: " ",
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/workspaceDefaultId/);
  });

  it("supports lifecycle and heartbeat settings", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        sessionIdleTimeoutMs: 600000,
        sessionSweepIntervalMs: 30000,
        wsPingIntervalMs: 20000,
        wsPongGraceMs: 10000,
      }),
    );

    const config = loadConfig(configPath);
    expect(config.sessionIdleTimeoutMs).toBe(600000);
    expect(config.sessionSweepIntervalMs).toBe(30000);
    expect(config.wsPingIntervalMs).toBe(20000);
    expect(config.wsPongGraceMs).toBe(10000);
  });

  it("rejects invalid lifecycle and heartbeat settings", () => {
    const configPath = join(tmpDir, "nexus.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "mytoken" },
        runtime: { command: ["npx", "@zed-industries/claude-agent-acp"] },
        sessionIdleTimeoutMs: -1,
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/sessionIdleTimeoutMs/);
  });
});
