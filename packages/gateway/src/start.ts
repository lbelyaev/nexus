import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, repoRoot } from "./config.js";
import { createRouter, type EventEmitter, type ManagedAcpSession } from "./router.js";
import { createGatewayServer } from "./server.js";
import { createStateStore } from "@nexus/state";
import { loadPolicyFromString } from "@nexus/policy";
import { spawnAgent, createAcpSession } from "@nexus/acp-bridge";
import type { AgentProcess } from "@nexus/acp-bridge";
import { evaluatePolicy } from "@nexus/policy";
import type { NexusConfig, RuntimeProfile } from "@nexus/types";

const inferRuntimeId = (command: string[]): string => {
  const joined = command.join(" ").toLowerCase();
  if (joined.includes("codex-acp")) return "codex";
  if (joined.includes("claude") || joined.includes("cc-acp")) return "claude";
  return "custom";
};

const normalizeModelKey = (model: string): string => model.trim().toLowerCase();

interface RuntimeRegistry {
  profiles: Record<string, RuntimeProfile>;
  defaultRuntimeId: string;
  modelRouting: Record<string, string>;
  modelAliases: Record<string, string>;
  modelCatalog: Record<string, string[]>;
  runtimeDefaults: Record<string, string>;
}

const normalizeRuntimeRegistry = (config: NexusConfig): RuntimeRegistry => {
  const modelRouting: Record<string, string> = {};
  for (const [model, runtimeId] of Object.entries(config.modelRouting ?? {})) {
    modelRouting[normalizeModelKey(model)] = runtimeId;
  }
  const modelAliases: Record<string, string> = {};
  for (const [alias, modelId] of Object.entries(config.modelAliases ?? {})) {
    modelAliases[normalizeModelKey(alias)] = modelId.trim();
  }
  const modelCatalog: Record<string, string[]> = {};
  for (const [runtimeId, models] of Object.entries(config.modelCatalog ?? {})) {
    modelCatalog[runtimeId] = models.map((m) => m.trim()).filter((m) => m.length > 0);
  }
  const runtimeDefaults: Record<string, string> = {};

  if (config.runtimes && Object.keys(config.runtimes).length > 0) {
    for (const [runtimeId, profile] of Object.entries(config.runtimes)) {
      runtimeDefaults[runtimeId] = profile.defaultModel ?? inferRuntimeId(profile.command);
    }
    const defaultRuntimeId = config.defaultRuntimeId ?? Object.keys(config.runtimes)[0]!;
    return {
      profiles: config.runtimes,
      defaultRuntimeId,
      modelRouting,
      modelAliases,
      modelCatalog,
      runtimeDefaults,
    };
  }

  if (config.runtime) {
    runtimeDefaults.default = config.runtime.defaultModel ?? inferRuntimeId(config.runtime.command);
    return {
      profiles: { default: config.runtime },
      defaultRuntimeId: "default",
      modelRouting,
      modelAliases,
      modelCatalog,
      runtimeDefaults,
    };
  }

  throw new Error("No runtime profiles configured");
};

const inferAuthSource = (
  runtimeProfileId: string,
  command: string[],
  runtimeEnv?: Record<string, string>,
): string => {
  const runtimeId = inferRuntimeId(command);
  if (runtimeId !== "codex") return "n/a";

  const mergedEnv = {
    ...process.env,
    ...(runtimeEnv ?? {}),
  };

  if (mergedEnv.CODEX_API_KEY) return "CODEX_API_KEY";
  if (mergedEnv.OPENAI_API_KEY) return "OPENAI_API_KEY";
  return `ChatGPT login / persisted local credentials (${runtimeProfileId})`;
};

const AMBIGUOUS_MODEL_ALIASES = new Set<string>([
  "claude",
  "sonnet",
  "haiku",
  "opus",
  "gpt",
  "gpt5",
  "gpt-5",
  "codex",
]);

const resolveModelAlias = (
  model: string,
  aliases: Record<string, string>,
): { requested: string; resolved: string } => {
  const requested = model.trim();
  const resolved = aliases[normalizeModelKey(requested)] ?? requested;
  return { requested, resolved };
};

export const startGateway = async (configPath?: string) => {
  const config = loadConfig(configPath);
  const runtimeRegistry = normalizeRuntimeRegistry(config);
  const runtimeAgents = new Map<string, { profile: RuntimeProfile; agent: AgentProcess }>();

  console.log(`[nexus] Repo root: ${repoRoot}`);
  console.log(`[nexus] Config loaded: port=${config.port}, host=${config.host}`);
  console.log(`[nexus] Auth token: ${config.auth.token.slice(0, 8)}...`);
  console.log(`[nexus] Runtime profiles: ${Object.keys(runtimeRegistry.profiles).join(", ")} (default=${runtimeRegistry.defaultRuntimeId})`);
  if (Object.keys(runtimeRegistry.modelAliases).length > 0) {
    console.log(`[nexus] Model aliases: ${Object.entries(runtimeRegistry.modelAliases).map(([k, v]) => `${k}=>${v}`).join(", ")}`);
  }
  if (Object.keys(runtimeRegistry.modelCatalog).length > 0) {
    const counts = Object.entries(runtimeRegistry.modelCatalog).map(([runtimeId, models]) => `${runtimeId}:${models.length}`).join(", ");
    console.log(`[nexus] Model catalog loaded: ${counts}`);
  }

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

  // Spawn and initialize one ACP process per runtime profile.
  for (const [runtimeProfileId, profile] of Object.entries(runtimeRegistry.profiles)) {
    const inferred = inferRuntimeId(profile.command);
    const authSource = inferAuthSource(runtimeProfileId, profile.command, profile.env);
    console.log(`[nexus] Spawning runtime "${runtimeProfileId}" (${inferred}): ${profile.command.join(" ")}`);
    if (profile.defaultModel) {
      const resolvedDefaultModel = resolveModelAlias(profile.defaultModel, runtimeRegistry.modelAliases);
      const aliasNote = resolvedDefaultModel.requested === resolvedDefaultModel.resolved
        ? ""
        : ` (alias -> ${resolvedDefaultModel.resolved})`;
      console.log(`[nexus] Runtime "${runtimeProfileId}" default model: ${resolvedDefaultModel.requested}${aliasNote}`);
    }
    if (inferred === "codex") {
      console.log(`[nexus] Runtime "${runtimeProfileId}" auth source: ${authSource}`);
    }

    const agent = spawnAgent(profile.command, {
      cwd: profile.cwd,
      env: profile.env,
      timeout: 300_000, // 5 min — tool-using prompts can be slow
    });

    agent.onExit((code) => {
      console.error(`[nexus] Runtime "${runtimeProfileId}" exited with code ${code}`);
    });

    console.log(`[nexus] Initializing runtime "${runtimeProfileId}" via ACP...`);
    const initResult = await agent.rpc.sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    console.log(`[nexus] Runtime "${runtimeProfileId}" initialized:`, initResult);

    runtimeAgents.set(runtimeProfileId, { profile, agent });
  }

  const resolveRuntimeId = (
    requestedRuntimeId?: string,
    requestedModel?: string,
  ): string => {
    if (requestedRuntimeId) {
      if (!runtimeAgents.has(requestedRuntimeId)) {
        throw new Error(`Unknown runtimeId: ${requestedRuntimeId}`);
      }
      return requestedRuntimeId;
    }

    if (requestedModel) {
      const mappedRuntimeId = runtimeRegistry.modelRouting[normalizeModelKey(requestedModel)];
      if (mappedRuntimeId) {
        if (!runtimeAgents.has(mappedRuntimeId)) {
          throw new Error(`Model "${requestedModel}" maps to unknown runtime "${mappedRuntimeId}"`);
        }
        return mappedRuntimeId;
      }
    }

    return runtimeRegistry.defaultRuntimeId;
  };

  const resolveSessionModel = (
    runtimeId: string,
    requestedModel?: string,
  ): { requested: string; resolved: string } => {
    if (requestedModel) {
      return resolveModelAlias(requestedModel, runtimeRegistry.modelAliases);
    }
    const profile = runtimeAgents.get(runtimeId)?.profile;
    const fallback = profile?.defaultModel ?? inferRuntimeId(profile?.command ?? []);
    return resolveModelAlias(fallback, runtimeRegistry.modelAliases);
  };

  // Router — createAcpSession factory that creates ACP session and wires events
  const router = createRouter({
    createAcpSession: async (
      requestedRuntimeId: string | undefined,
      requestedModel: string | undefined,
      onEvent: EventEmitter,
    ): Promise<ManagedAcpSession> => {
      const runtimeId = resolveRuntimeId(requestedRuntimeId, requestedModel);
      const runtime = runtimeAgents.get(runtimeId);
      if (!runtime) {
        throw new Error(`Runtime not available: ${runtimeId}`);
      }

      const gatewaySessionId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const modelSelection = resolveSessionModel(runtimeId, requestedModel);
      const ambiguousModel = normalizeModelKey(modelSelection.requested);
      const hasExplicitAlias = ambiguousModel in runtimeRegistry.modelAliases;
      if (
        AMBIGUOUS_MODEL_ALIASES.has(ambiguousModel)
        && !hasExplicitAlias
        && modelSelection.requested === modelSelection.resolved
      ) {
        console.warn(
          `[nexus] Ambiguous model alias "${modelSelection.requested}" for runtime "${runtimeId}". `
          + "Consider setting config.modelAliases to a pinned model ID for reproducibility.",
        );
      }

      // Ask the agent to create a session — it returns the actual sessionId
      const baseSessionParams = {
        cwd: process.cwd(),
        mcpServers: [],
      };
      let modelParamAccepted = true;
      let result: { sessionId: string; model?: string };
      try {
        result = await runtime.agent.rpc.sendRequest("session/new", {
          ...baseSessionParams,
          model: modelSelection.resolved,
        }) as { sessionId: string; model?: string };
      } catch (error) {
        modelParamAccepted = false;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[nexus] Runtime "${runtimeId}" rejected session/new with model="${modelSelection.resolved}" `
          + `(requested="${modelSelection.requested}"). Retrying without model. Error: ${message}`,
        );
        result = await runtime.agent.rpc.sendRequest("session/new", baseSessionParams) as { sessionId: string; model?: string };
      }

      const acpSessionId = result.sessionId;
      const runtimeReportedModel = typeof result.model === "string" ? result.model : undefined;
      const model = runtimeReportedModel ?? (modelParamAccepted ? modelSelection.resolved : "runtime-default");
      const resolutionNote = modelSelection.requested === modelSelection.resolved
        ? ""
        : `, resolvedModel=${modelSelection.resolved}`;
      const runtimeNote = runtimeReportedModel ? `, runtimeModel=${runtimeReportedModel}` : ", runtimeModel=not-reported";
      const modelParamNote = modelParamAccepted ? ", modelParam=accepted-or-ignored" : ", modelParam=rejected";
      console.log(
        `[nexus] ACP session created: ${acpSessionId} `
        + `(gateway: ${gatewaySessionId}, runtime: ${runtimeId}, requestedModel=${modelSelection.requested}${resolutionNote}${runtimeNote}${modelParamNote})`,
      );

      const session = createAcpSession(runtime.agent.rpc, acpSessionId, gatewaySessionId, {
        policyEvaluator: (tool, params) => evaluatePolicy(policyConfig, tool, params),
      });
      session.onEvent(onEvent);

      return {
        ...session,
        runtimeId,
        model,
        modelRouting: runtimeRegistry.modelRouting,
        modelAliases: runtimeRegistry.modelAliases,
        modelCatalog: runtimeRegistry.modelCatalog,
        runtimeDefaults: runtimeRegistry.runtimeDefaults,
      };
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
    for (const [runtimeProfileId, runtime] of runtimeAgents) {
      console.log(`[nexus] Stopping runtime "${runtimeProfileId}"...`);
      await runtime.agent.kill();
    }
    stateStore.close();
    console.log(`[nexus] Goodbye.`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, runtimeAgents, stateStore, config };
};
