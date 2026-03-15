import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, repoRoot } from "./config.js";
import {
  createRouter,
  type EventEmitter,
  type ManagedAcpSession,
  type Router,
  type SessionPolicyContext,
} from "./router.js";
import { createGatewayServer } from "./server.js";
import { createStateStore } from "@nexus/state";
import { loadPolicyFromString } from "@nexus/policy";
import { spawnAgent, createAcpSession } from "@nexus/acp-bridge";
import type { AgentProcess } from "@nexus/acp-bridge";
import { evaluatePolicy } from "@nexus/policy";
import { createSqliteMemoryProvider, type MemoryProvider } from "@nexus/memory";
import type { NexusConfig, PrincipalType, RuntimeHealthInfo, RuntimeHealthStatus, RuntimeProfile } from "@nexus/types";
import {
  createChannelManager,
  createDiscordAdapter,
  createTelegramAdapter,
  type ChannelAdapterRegistration,
  type ChannelAuthKeyStore,
  type StoredChannelAuthKeyPair,
} from "@nexus/channels";
import { createLogger } from "./logger.js";

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

interface RuntimeRestartState {
  attempts: number;
  timer: NodeJS.Timeout | null;
}

const DEFAULT_RUNTIME_RESTART_MAX_ATTEMPTS = 3;
const DEFAULT_RUNTIME_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_RUNTIME_RESTART_MAX_DELAY_MS = 30_000;

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
  const log = createLogger("gateway.start");
  const config = loadConfig(configPath);
  const runtimeRegistry = normalizeRuntimeRegistry(config);
  const runtimeAgents = new Map<string, { profile: RuntimeProfile; agent: AgentProcess }>();
  const runtimeHealth = new Map<string, RuntimeHealthInfo>();
  const runtimeRestartState = new Map<string, RuntimeRestartState>();
  const restartMaxAttempts = Math.max(
    0,
    config.runtimeRestartMaxAttempts ?? DEFAULT_RUNTIME_RESTART_MAX_ATTEMPTS,
  );
  const restartBaseDelayMs = Math.max(
    1,
    config.runtimeRestartBaseDelayMs ?? DEFAULT_RUNTIME_RESTART_BASE_DELAY_MS,
  );
  const restartMaxDelayMs = Math.max(
    restartBaseDelayMs,
    config.runtimeRestartMaxDelayMs ?? DEFAULT_RUNTIME_RESTART_MAX_DELAY_MS,
  );
  let shuttingDown = false;
  let routerRef: Router | null = null;
  let channelManager: ReturnType<typeof createChannelManager> | null = null;

  const setRuntimeHealth = (
    runtimeId: string,
    status: RuntimeHealthStatus,
    reason?: string,
  ): RuntimeHealthInfo => {
    const next: RuntimeHealthInfo = {
      runtimeId,
      status,
      updatedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
    runtimeHealth.set(runtimeId, next);
    if (routerRef) {
      routerRef.setRuntimeHealth(runtimeId, status, reason);
    }
    return next;
  };

  log.info("gateway_boot", {
    repoRoot,
    port: config.port,
    host: config.host,
    tokenPreview: `${config.auth.token.slice(0, 8)}...`,
    runtimeProfiles: Object.keys(runtimeRegistry.profiles),
    defaultRuntimeId: runtimeRegistry.defaultRuntimeId,
    workspaceDefaultId: config.workspaceDefaultId ?? "default",
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs ?? 30 * 60 * 1000,
    sessionSweepIntervalMs: config.sessionSweepIntervalMs ?? 30_000,
    runtimeRestartMaxAttempts: restartMaxAttempts,
    runtimeRestartBaseDelayMs: restartBaseDelayMs,
    runtimeRestartMaxDelayMs: restartMaxDelayMs,
  });
  if (Object.keys(runtimeRegistry.modelAliases).length > 0) {
    log.info("model_aliases_loaded", {
      aliases: Object.entries(runtimeRegistry.modelAliases).map(([k, v]) => `${k}=>${v}`).join(", "),
    });
  }
  if (Object.keys(runtimeRegistry.modelCatalog).length > 0) {
    const counts = Object.entries(runtimeRegistry.modelCatalog).map(([runtimeId, models]) => `${runtimeId}:${models.length}`).join(", ");
    log.info("model_catalog_loaded", { counts });
  }

  // State store — resolve dataDir relative to repo root
  const dataDir = resolve(repoRoot, config.dataDir ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolve(dataDir, "nexus.db");
  const channelAuthKeysPath = resolve(dataDir, "channel-auth-keys.json");
  const stateStore = createStateStore(dbPath);
  log.info("state_store_initialized", { dbPath });

  let channelAuthKeys: Record<string, StoredChannelAuthKeyPair> = {};
  if (existsSync(channelAuthKeysPath)) {
    try {
      const parsed = JSON.parse(readFileSync(channelAuthKeysPath, "utf-8")) as Record<string, StoredChannelAuthKeyPair>;
      channelAuthKeys = parsed;
    } catch (error) {
      log.warn("channel_auth_key_store_load_failed", {
        path: channelAuthKeysPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const channelAuthKeyStore: ChannelAuthKeyStore = {
    getChannelAuthKeyPair: (principalType: PrincipalType, principalId: string) => (
      channelAuthKeys[`${principalType}:${principalId}`] ?? null
    ),
    upsertChannelAuthKeyPair: (
      principalType: PrincipalType,
      principalId: string,
      pair: StoredChannelAuthKeyPair,
    ) => {
      channelAuthKeys[`${principalType}:${principalId}`] = pair;
      writeFileSync(channelAuthKeysPath, JSON.stringify(channelAuthKeys, null, 2));
    },
  };

  let memoryProvider: MemoryProvider | undefined;
  const memoryConfig = config.memory;
  const memoryEnabled = memoryConfig?.enabled ?? true;
  if (memoryEnabled) {
    memoryProvider = createSqliteMemoryProvider(stateStore, {
      contextBudgetTokens: memoryConfig?.contextBudgetTokens,
      hotMessageCount: memoryConfig?.hotMessageCount,
      warmSummaryCount: memoryConfig?.warmSummaryCount,
      coldFactCount: memoryConfig?.coldFactCount,
      workspaceSummaryCount: memoryConfig?.workspaceSummaryCount,
      workspaceFactCount: memoryConfig?.workspaceFactCount,
      maxFactsPerTurn: memoryConfig?.maxFactsPerTurn,
      maxFactLength: memoryConfig?.maxFactLength,
      summaryWindowMessages: memoryConfig?.summaryWindowMessages,
    });
    log.info("memory_provider_initialized", {
      provider: memoryConfig?.provider ?? "sqlite",
      enabled: true,
    });
  } else {
    log.info("memory_provider_disabled");
  }

  // Policy — resolve relative to repo root
  let policyConfig;
  try {
    const policyPath = resolve(repoRoot, "config/policy.default.json");
    const policyJson = readFileSync(policyPath, "utf-8");
    policyConfig = loadPolicyFromString(policyJson);
    log.info("policy_loaded", { ruleCount: policyConfig.rules.length });
  } catch {
    policyConfig = { rules: [] };
    log.warn("policy_file_missing_using_permissive_defaults");
  }

  const getRestartState = (runtimeProfileId: string): RuntimeRestartState => {
    const existing = runtimeRestartState.get(runtimeProfileId);
    if (existing) return existing;
    const created: RuntimeRestartState = { attempts: 0, timer: null };
    runtimeRestartState.set(runtimeProfileId, created);
    return created;
  };

  const clearRestartTimer = (runtimeProfileId: string): void => {
    const state = runtimeRestartState.get(runtimeProfileId);
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  };

  const clearAllRestartTimers = (): void => {
    for (const runtimeProfileId of runtimeRestartState.keys()) {
      clearRestartTimer(runtimeProfileId);
    }
  };

  const restartDelayMsForAttempt = (attempt: number): number =>
    Math.min(restartMaxDelayMs, restartBaseDelayMs * Math.max(1, 2 ** (attempt - 1)));

  const closeRuntimeSessions = (
    runtimeProfileId: string,
    reason: string,
    logMessage: string,
  ): void => {
    const closedSessionIds = routerRef?.closeSessionsByRuntime(runtimeProfileId, reason) ?? [];
    if (closedSessionIds.length === 0) return;
    log.warn(logMessage, {
      runtimeProfileId,
      reason,
      closedCount: closedSessionIds.length,
      sessionIds: closedSessionIds,
    });
  };

  const scheduleRuntimeRestart = (runtimeProfileId: string, reason: string): void => {
    if (shuttingDown) return;
    const profile = runtimeRegistry.profiles[runtimeProfileId];
    if (!profile) {
      setRuntimeHealth(runtimeProfileId, "unavailable", "runtime_profile_missing");
      return;
    }

    const state = getRestartState(runtimeProfileId);
    if (state.timer) return;
    state.attempts += 1;
    const attempt = state.attempts;
    if (attempt > restartMaxAttempts) {
      setRuntimeHealth(runtimeProfileId, "unavailable", "restart_exhausted");
      log.error("runtime_restart_exhausted", {
        runtimeProfileId,
        maxAttempts: restartMaxAttempts,
        trigger: reason,
      });
      closeRuntimeSessions(runtimeProfileId, "runtime_unavailable", "runtime_restart_sessions_closed");
      return;
    }

    const delayMs = restartDelayMsForAttempt(attempt);
    setRuntimeHealth(runtimeProfileId, "degraded", `restart_scheduled:${attempt}`);
    log.warn("runtime_restart_scheduled", {
      runtimeProfileId,
      attempt,
      maxAttempts: restartMaxAttempts,
      delayMs,
      trigger: reason,
    });
    state.timer = setTimeout(() => {
      state.timer = null;
      void restartRuntime(runtimeProfileId, attempt);
    }, delayMs);
    state.timer.unref?.();
  };

  const startRuntime = async (
    runtimeProfileId: string,
    profile: RuntimeProfile,
    options?: { reason?: string; attempt?: number },
  ): Promise<void> => {
    const reason = options?.reason ?? "boot";
    const inferred = inferRuntimeId(profile.command);
    const authSource = inferAuthSource(runtimeProfileId, profile.command, profile.env);
    setRuntimeHealth(runtimeProfileId, "starting", reason);
    log.info("runtime_spawning", {
      runtimeProfileId,
      inferred,
      command: profile.command.join(" "),
      reason,
      attempt: options?.attempt ?? 0,
    });
    if (profile.defaultModel) {
      const resolvedDefaultModel = resolveModelAlias(profile.defaultModel, runtimeRegistry.modelAliases);
      const aliasNote = resolvedDefaultModel.requested === resolvedDefaultModel.resolved
        ? ""
        : ` (alias -> ${resolvedDefaultModel.resolved})`;
      log.info("runtime_default_model", {
        runtimeProfileId,
        defaultModel: `${resolvedDefaultModel.requested}${aliasNote}`,
      });
    }
    if (inferred === "codex") {
      log.info("runtime_auth_source", {
        runtimeProfileId,
        authSource,
      });
    }

    const agent = spawnAgent(profile.command, {
      cwd: profile.cwd,
      env: profile.env,
      timeout: 300_000, // 5 min — tool-using prompts can be slow
    });
    runtimeAgents.set(runtimeProfileId, { profile, agent });
    let allowRestartOnExit = true;

    agent.onExit((code) => {
      runtimeAgents.delete(runtimeProfileId);
      if (shuttingDown || !allowRestartOnExit) return;
      const exitReason = `process_exit:${code ?? "null"}`;
      log.error("runtime_exited", { runtimeProfileId, code });
      closeRuntimeSessions(runtimeProfileId, "runtime_restarting", "runtime_exit_sessions_closed");
      scheduleRuntimeRestart(runtimeProfileId, exitReason);
    });

    log.info("runtime_initializing", { runtimeProfileId });
    try {
      const initResult = await agent.rpc.sendRequest("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const state = getRestartState(runtimeProfileId);
      state.attempts = 0;
      setRuntimeHealth(runtimeProfileId, "healthy");
      log.info("runtime_initialized", { runtimeProfileId, initResult });
    } catch (error) {
      allowRestartOnExit = false;
      runtimeAgents.delete(runtimeProfileId);
      try {
        await agent.kill();
      } catch (killError) {
        log.warn("runtime_kill_after_initialize_failure_failed", {
          runtimeProfileId,
          error: killError instanceof Error ? killError.message : String(killError),
        });
      }
      throw error;
    }
  };

  const restartRuntime = async (runtimeProfileId: string, attempt: number): Promise<void> => {
    if (shuttingDown) return;
    const profile = runtimeRegistry.profiles[runtimeProfileId];
    if (!profile) {
      setRuntimeHealth(runtimeProfileId, "unavailable", "runtime_profile_missing");
      return;
    }
    try {
      await startRuntime(runtimeProfileId, profile, {
        reason: `restart_attempt:${attempt}`,
        attempt,
      });
      log.info("runtime_restart_succeeded", { runtimeProfileId, attempt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("runtime_restart_failed", {
        runtimeProfileId,
        attempt,
        error: message,
      });
      scheduleRuntimeRestart(runtimeProfileId, `initialize_failed:${message}`);
    }
  };

  const killRuntimeAgents = async (): Promise<void> => {
    clearAllRestartTimers();
    for (const [runtimeProfileId, runtime] of runtimeAgents) {
      try {
        await runtime.agent.kill();
      } catch (error) {
        log.warn("runtime_kill_failed", {
          runtimeProfileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    runtimeAgents.clear();
  };

  const createChannelRegistrations = (): ChannelAdapterRegistration[] => {
    const channels = config.channels ?? {};
    const registrations: ChannelAdapterRegistration[] = [];

    for (const [channelId, channel] of Object.entries(channels)) {
      if (channel.enabled === false) {
        log.info("channel_adapter_disabled", { channelId, kind: channel.kind });
        continue;
      }

      if (channel.kind === "telegram") {
        registrations.push({
          adapter: createTelegramAdapter({
            id: channelId,
            botToken: channel.botToken,
            apiBaseUrl: channel.apiBaseUrl,
            pollTimeoutSeconds: channel.pollTimeoutSeconds,
            pollIntervalMs: channel.pollIntervalMs,
            allowedChatIds: channel.allowedChatIds,
          }),
          route: {
            runtimeId: channel.runtimeId,
            model: channel.model,
            workspaceId: channel.workspaceId,
            source: "api",
            principalType: "user",
            typingIndicator: channel.typingIndicator,
            streamingMode: channel.streamingMode,
            steeringMode: channel.steeringMode,
          },
        });
        continue;
      }

      if (channel.kind === "discord") {
        registrations.push({
          adapter: createDiscordAdapter({
            id: channelId,
            botToken: channel.botToken,
            applicationId: channel.applicationId,
            guildId: channel.guildId,
            allowedUserIds: channel.allowedUserIds,
          }),
          route: {
            runtimeId: channel.runtimeId,
            model: channel.model,
            workspaceId: channel.workspaceId,
            source: "api",
            principalType: "user",
            typingIndicator: channel.typingIndicator,
            streamingMode: channel.streamingMode,
            steeringMode: channel.steeringMode,
          },
        });
      }
    }

    return registrations;
  };

  // Spawn and initialize one ACP process per runtime profile.
  try {
    for (const [runtimeProfileId, profile] of Object.entries(runtimeRegistry.profiles)) {
      await startRuntime(runtimeProfileId, profile, { reason: "boot" });
    }
  } catch (error) {
    shuttingDown = true;
    await killRuntimeAgents();
    stateStore.close();
    throw error;
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
      policyContext?: SessionPolicyContext,
      options?: { gatewaySessionId?: string },
    ): Promise<ManagedAcpSession> => {
      const runtimeId = resolveRuntimeId(requestedRuntimeId, requestedModel);
      const runtime = runtimeAgents.get(runtimeId);
      if (!runtime) {
        setRuntimeHealth(runtimeId, "unavailable", "missing_runtime_agent");
        throw new Error(`Runtime not available: ${runtimeId}`);
      }

      const gatewaySessionId = options?.gatewaySessionId
        ?? `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const modelSelection = resolveSessionModel(runtimeId, requestedModel);
      const ambiguousModel = normalizeModelKey(modelSelection.requested);
      const hasExplicitAlias = ambiguousModel in runtimeRegistry.modelAliases;
      if (
        AMBIGUOUS_MODEL_ALIASES.has(ambiguousModel)
        && !hasExplicitAlias
        && modelSelection.requested === modelSelection.resolved
      ) {
        log.warn("ambiguous_model_alias", {
          runtimeId,
          requestedModel: modelSelection.requested,
          suggestion: "Set config.modelAliases to a pinned model ID for reproducibility.",
        });
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
        setRuntimeHealth(runtimeId, "degraded", "session_new_model_rejected_retry");
        log.warn("runtime_rejected_session_new_model_retrying_without_model", {
          runtimeId,
          requestedModel: modelSelection.requested,
          resolvedModel: modelSelection.resolved,
          error: message,
        });
        try {
          result = await runtime.agent.rpc.sendRequest("session/new", baseSessionParams) as { sessionId: string; model?: string };
        } catch (retryError) {
          setRuntimeHealth(runtimeId, "unavailable", "session_new_failed");
          throw retryError;
        }
      }
      setRuntimeHealth(runtimeId, "healthy");

      const acpSessionId = result.sessionId;
      const runtimeReportedModel = typeof result.model === "string" ? result.model : undefined;
      const model = runtimeReportedModel ?? (modelParamAccepted ? modelSelection.resolved : "runtime-default");
      const resolutionNote = modelSelection.requested === modelSelection.resolved
        ? ""
        : `, resolvedModel=${modelSelection.resolved}`;
      const runtimeNote = runtimeReportedModel ? `, runtimeModel=${runtimeReportedModel}` : ", runtimeModel=not-reported";
      const modelParamNote = modelParamAccepted ? ", modelParam=accepted-or-ignored" : ", modelParam=rejected";
      log.info("acp_session_created", {
        acpSessionId,
        gatewaySessionId,
        runtimeId,
        requestedModel: modelSelection.requested,
        resolutionNote,
        runtimeNote,
        modelParamNote,
      });

      const session = createAcpSession(runtime.agent.rpc, acpSessionId, gatewaySessionId, {
        policyEvaluator: (tool, params) => evaluatePolicy(policyConfig, tool, params, policyContext),
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
    memoryProvider,
    defaultWorkspaceId: config.workspaceDefaultId ?? "default",
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs ?? 30 * 60 * 1000,
    initialRuntimeHealth: Object.fromEntries(runtimeHealth),
  });
  routerRef = router;

  // Server
  const server = createGatewayServer({
    port: config.port,
    host: config.host,
    token: config.auth.token,
    router,
    healthProvider: () => ({
      runtimes: router.getRuntimeHealth(),
      activeSessions: stateStore.listSessions().filter((s) => s.status === "active").length,
    }),
    wsPingIntervalMs: config.wsPingIntervalMs ?? 20_000,
    wsPongGraceMs: config.wsPongGraceMs ?? 10_000,
  });

  const sessionSweepIntervalMs = config.sessionSweepIntervalMs ?? 30_000;
  const sweepTimer = setInterval(() => {
    const closed = router.sweepIdleSessions();
    if (closed.length > 0) {
      log.info("idle_session_sweep", {
        closedCount: closed.length,
        sessionIds: closed,
      });
    }
  }, Math.max(1_000, sessionSweepIntervalMs));
  sweepTimer.unref?.();

  const { port } = await server.start();
  log.info("gateway_listening", { host: config.host, port });
  const connectUrl = `ws://${config.host}:${port}/ws?token=${config.auth.token}`;
  log.info("connect_via", { url: connectUrl });
  // Keep a human-friendly line for terminal workflows and docs that parse this exact prefix.
  console.log(`[nexus] Connect via: ${connectUrl}`);

  const channelRegistrations = createChannelRegistrations();
  if (channelRegistrations.length > 0) {
    const gatewayWsUrl = `ws://${config.host}:${port}/ws`;
    channelManager = createChannelManager({
      gatewayUrl: gatewayWsUrl,
      token: config.auth.token,
      autoResumeOnUnboundPrompt: true,
      adapters: channelRegistrations,
      authKeyStore: channelAuthKeyStore,
      bindingStore: {
        getChannelBinding: (adapterId, conversationId) => stateStore.getChannelBinding(adapterId, conversationId),
        upsertChannelBinding: (binding) => stateStore.upsertChannelBinding(binding),
        deleteChannelBinding: (adapterId, conversationId) => stateStore.deleteChannelBinding(adapterId, conversationId),
      },
      logger: {
        debug: (message, fields) => log.debug(message, fields),
        info: (message, fields) => log.info(message, fields),
        warn: (message, fields) => log.warn(message, fields),
        error: (message, fields) => log.error(message, fields),
      },
    });
    try {
      await channelManager.start();
      log.info("channel_manager_started", {
        adapterCount: channelRegistrations.length,
        adapterIds: channelRegistrations.map((registration) => registration.adapter.id),
      });
    } catch (error) {
      log.error("channel_manager_start_failed", {
        adapterCount: channelRegistrations.length,
        adapterIds: channelRegistrations.map((registration) => registration.adapter.id),
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await channelManager.stop();
      } catch (stopError) {
        log.warn("channel_manager_stop_after_failed_start_failed", {
          error: stopError instanceof Error ? stopError.message : String(stopError),
        });
      }
      channelManager = null;
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    shuttingDown = true;
    log.info("gateway_shutdown_start");
    clearInterval(sweepTimer);
    if (channelManager) {
      await channelManager.stop();
      channelManager = null;
    }
    await server.stop();
    for (const runtimeProfileId of runtimeAgents.keys()) {
      log.info("runtime_stopping", { runtimeProfileId });
    }
    await killRuntimeAgents();
    stateStore.close();
    log.info("gateway_shutdown_complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, runtimeAgents, stateStore, config };
};
