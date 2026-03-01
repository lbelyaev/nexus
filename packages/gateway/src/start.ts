import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, repoRoot } from "./config.js";
import { createRouter, type EventEmitter } from "./router.js";
import { createGatewayServer } from "./server.js";
import { createStateStore } from "@nexus/state";
import { loadPolicyFromString } from "@nexus/policy";
import { spawnAgent, createAcpSession } from "@nexus/acp-bridge";
import type { AcpSession } from "@nexus/acp-bridge";
import { evaluatePolicy } from "@nexus/policy";

export const startGateway = async (configPath?: string) => {
  const config = loadConfig(configPath);

  console.log(`[nexus] Repo root: ${repoRoot}`);
  console.log(`[nexus] Config loaded: port=${config.port}, host=${config.host}`);
  console.log(`[nexus] Auth token: ${config.auth.token.slice(0, 8)}...`);
  console.log(`[nexus] Runtime command: ${config.runtime.command.join(" ")}`);

  // State store — resolve dataDir relative to repo root
  const dataDir = resolve(repoRoot, config.dataDir ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolve(dataDir, "nexus.db");
  const stateStore = createStateStore(dbPath);
  console.log(`[nexus] State store initialized at ${dbPath}`);

  // Policy — resolve relative to repo root
  let policyConfig;
  try {
    const policyPath = resolve(repoRoot, "config/policy.default.json");
    const policyJson = readFileSync(policyPath, "utf-8");
    policyConfig = loadPolicyFromString(policyJson);
    console.log(`[nexus] Policy loaded: ${policyConfig.rules.length} rules`);
  } catch {
    policyConfig = { rules: [] };
    console.log(`[nexus] No policy file found, using permissive defaults`);
  }

  // Spawn the ACP agent
  console.log(`[nexus] Spawning agent: ${config.runtime.command.join(" ")}`);
  const agent = spawnAgent(config.runtime.command, {
    cwd: config.runtime.cwd,
    env: config.runtime.env,
    timeout: 300_000, // 5 min — tool-using prompts can be slow
  });

  agent.onExit((code) => {
    console.error(`[nexus] Agent process exited with code ${code}`);
  });

  // Initialize ACP (protocol version is an integer per ACP spec)
  console.log(`[nexus] Sending ACP initialize...`);
  const initResult = await agent.rpc.sendRequest("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  console.log(`[nexus] ACP initialized:`, initResult);

  // Router — createAcpSession factory that creates ACP session and wires events
  const router = createRouter({
    createAcpSession: async (onEvent: EventEmitter): Promise<AcpSession> => {
      const gatewaySessionId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Ask the agent to create a session — it returns the actual sessionId
      const result = await agent.rpc.sendRequest("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      }) as { sessionId: string };

      const acpSessionId = result.sessionId;
      console.log(`[nexus] ACP session created: ${acpSessionId} (gateway: ${gatewaySessionId})`);

      const session = createAcpSession(agent.rpc, acpSessionId, gatewaySessionId, {
        policyEvaluator: (tool, params) => evaluatePolicy(policyConfig, tool, params),
      });
      session.onEvent(onEvent);

      return session;
    },
    stateStore,
    policyConfig,
  });

  // Server
  const server = createGatewayServer({
    port: config.port,
    host: config.host,
    token: config.auth.token,
    router,
  });

  const { port } = await server.start();
  console.log(`[nexus] Gateway listening on ${config.host}:${port}`);
  console.log(`[nexus] Connect via: ws://${config.host}:${port}/ws?token=${config.auth.token}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`\n[nexus] Shutting down...`);
    await server.stop();
    await agent.kill();
    stateStore.close();
    console.log(`[nexus] Goodbye.`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, agent, stateStore, config };
};
