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
    expect(config.runtime.command).toEqual(["node", "agent.js"]);
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

    expect(() => loadConfig(configPath)).toThrow(/runtime\.command/);
  });
});
