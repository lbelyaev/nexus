import type {
  ChannelBindingRecord,
  GatewayEvent,
  PrincipalType,
  PromptSource,
  SessionInfo,
  SessionLifecycleEventRecord,
} from "@nexus/types";
import { canAutoResumeSession } from "@nexus/types";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createGatewayClient, type GatewayClient } from "./gatewayClient.js";
import type {
  ChannelAdapter,
  ChannelAdapterRegistration,
  ChannelInboundMessage,
  ChannelQuickAction,
  ChannelRouteConfig,
  ChannelSteeringMode,
  ChannelStreamingMode,
  LoggerLike,
} from "./types.js";

export interface ChannelManagerOptions {
  gatewayUrl: string;
  token: string;
  adapters: ChannelAdapterRegistration[];
  reconnectDelayMs?: number;
  autoResumeOnUnboundPrompt?: boolean;
  logger?: LoggerLike;
  bindingStore?: {
    getChannelBinding: (adapterId: string, conversationId: string) => ChannelBindingRecord | null;
    upsertChannelBinding: (binding: ChannelBindingRecord) => void;
    deleteChannelBinding: (adapterId: string, conversationId: string) => void;
  };
}

export interface ChannelManager {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface ConversationBinding {
  sessionId: string;
  adapterId: string;
  conversationId: string;
  principalType: PrincipalType;
  principalId: string;
  runtimeId?: string;
  model?: string;
  workspaceId?: string;
  typingIndicator: boolean;
  streamingMode: ChannelStreamingMode;
  steeringMode: ChannelSteeringMode;
  createdAt: string;
  updatedAt: string;
}

interface PendingSessionCreate {
  conversationKey: string;
  resolve: (sessionId: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
  sessionId: string;
  requestId: string;
  tool: string;
  adapterId: string;
  conversationId: string;
  allowOptionId?: string;
  rejectOptionId?: string;
}

interface PendingPrompt {
  message: ChannelInboundMessage;
  retryCount: number;
}

interface SessionMetadata {
  runtimeId?: string;
  model?: string;
  workspaceId?: string;
}

interface PendingSessionListDisplayRequest {
  kind: "display";
  adapterId: string;
  conversationId: string;
  principalType: PrincipalType;
  principalId: string;
  limit: number;
  cursor?: string;
  activeSessionId?: string;
}

interface PendingSessionListProbeRequest {
  kind: "probe";
  principalType: PrincipalType;
  principalId: string;
  resolve: (sessions: SessionInfo[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type PendingSessionListRequest = PendingSessionListDisplayRequest | PendingSessionListProbeRequest;

interface SessionListPageState {
  principalType: PrincipalType;
  principalId: string;
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

interface PendingSessionLifecycleRequest {
  adapterId: string;
  conversationId: string;
  sessionId: string;
}

interface PendingSessionResume {
  adapterId: string;
  conversationId: string;
  principalType: PrincipalType;
  principalId: string;
  previousSessionId?: string;
  silent?: boolean;
  resolve?: (sessionId: string) => void;
  reject?: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

type SessionTransferRequestedEvent = Extract<GatewayEvent, { type: "session_transfer_requested" }>;
type SessionTransferUpdatedEvent = Extract<GatewayEvent, { type: "session_transfer_updated" }>;
interface PendingTransfer {
  sessionId: string;
  fromPrincipalType: PrincipalType;
  fromPrincipalId: string;
  targetPrincipalType: PrincipalType;
  targetPrincipalId: string;
  expiresAt: string;
}
type AuthChallengeEvent = Extract<GatewayEvent, { type: "auth_challenge" }>;
type AuthResultEvent = Extract<GatewayEvent, { type: "auth_result" }>;
type UsageResultEvent = Extract<GatewayEvent, { type: "usage_result" }>;
type MemoryResultEvent = Extract<GatewayEvent, { type: "memory_result" }>;
type SessionListEvent = Extract<GatewayEvent, { type: "session_list" }>;
type SessionLifecycleResultEvent = Extract<GatewayEvent, { type: "session_lifecycle_result" }>;

interface AuthKeyPair {
  publicKey: string;
  privateKey: KeyObject;
}

interface AuthChallengeWaiter {
  resolve: (challenge: AuthChallengeEvent) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AuthResultWaiter {
  resolve: (result: AuthResultEvent) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const createFallbackLogger = (): LoggerLike => ({
  debug: (message, fields) => {
    if (fields) {
      console.debug(`[channels] ${message}`, fields);
      return;
    }
    console.debug(`[channels] ${message}`);
  },
  info: (message, fields) => {
    if (fields) {
      console.info(`[channels] ${message}`, fields);
      return;
    }
    console.info(`[channels] ${message}`);
  },
  warn: (message, fields) => {
    if (fields) {
      console.warn(`[channels] ${message}`, fields);
      return;
    }
    console.warn(`[channels] ${message}`);
  },
  error: (message, fields) => {
    if (fields) {
      console.error(`[channels] ${message}`, fields);
      return;
    }
    console.error(`[channels] ${message}`);
  },
});

const normalizePrincipalIdInput = (
  principalId: string,
  principalType: PrincipalType,
): string => {
  const duplicatedPrefix = `${principalType}:${principalType}:`;
  if (principalId.startsWith(duplicatedPrefix)) {
    return `${principalType}:${principalId.slice(duplicatedPrefix.length)}`;
  }
  return principalId;
};

const formatPrincipalDisplay = (
  principalType: PrincipalType,
  principalId: string,
): string => (
  principalId.startsWith(`${principalType}:`)
    ? principalId
    : `${principalType}:${principalId}`
);

const formatChannelError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const toPendingTransfer = (
  event: SessionTransferRequestedEvent | SessionTransferUpdatedEvent,
): PendingTransfer | null => {
  if (event.type === "session_transfer_updated" && event.state !== "requested") {
    return null;
  }
  if (event.expiresAt === undefined) {
    return null;
  }
  return {
    sessionId: event.sessionId,
    fromPrincipalType: event.fromPrincipalType,
    fromPrincipalId: event.fromPrincipalId,
    targetPrincipalType: event.targetPrincipalType,
    targetPrincipalId: event.targetPrincipalId,
    expiresAt: event.expiresAt,
  };
};

const isGatewayDisconnectedMessage = (message: string): boolean =>
  message.includes("Gateway websocket is not connected");

const isGatewayDisconnectedError = (error: unknown): boolean =>
  isGatewayDisconnectedMessage(formatChannelError(error));

const isSessionNotFoundMessage = (message: string): boolean =>
  message.startsWith("Session not found:");
const isSessionClosedMessage = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.startsWith("session is closed")
    || normalized.includes("closed and cannot be resumed")
  );
};
const isPromptTimeoutMessage = (message: string): boolean =>
  message.includes('RPC request "session/prompt"') && message.includes("timed out");
const formatUserFacingError = (message: string): string => {
  if (isPromptTimeoutMessage(message)) {
    return "Response timed out. You can retry, use /cancel, or send a new message to steer.";
  }
  return `Error: ${message}`;
};

const parseUsageScope = (
  value: string | undefined,
): "session" | "workspace" | "hybrid" | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "session" || normalized === "workspace" || normalized === "hybrid") {
    return normalized;
  }
  return undefined;
};

const formatUsageStatsLine = (
  scope: "session" | "workspace",
  stats: {
    facts: number;
    summaries: number;
    total: number;
    transcriptMessages: number;
    memoryTokens: number;
    transcriptTokens: number;
  },
): string => [
  `Usage stats (${scope}):`,
  `memory=facts:${stats.facts}, summaries:${stats.summaries}, total:${stats.total}, tokens:${stats.memoryTokens}`,
  `transcript=messages:${stats.transcriptMessages}, tokens:${stats.transcriptTokens}`,
].join("\n");

const formatUsageResult = (
  event: UsageResultEvent | MemoryResultEvent,
): string => {
  switch (event.action) {
    case "summary":
      return [
        "Usage summary:",
        `tokens=input:${event.summary.tokens.input}, output:${event.summary.tokens.output}, total:${event.summary.tokens.total}`,
        `executions=total:${event.summary.executions.total}, queued:${event.summary.executions.queued}, running:${event.summary.executions.running}, succeeded:${event.summary.executions.succeeded}, failed:${event.summary.executions.failed}, cancelled:${event.summary.executions.cancelled}, timed_out:${event.summary.executions.timedOut}`,
        ...(event.summary.memory
          ? [
              `memory.session=total:${event.summary.memory.session.total}, tokens:${event.summary.memory.session.memoryTokens}`,
              `memory.workspace=total:${event.summary.memory.workspace.total}, tokens:${event.summary.memory.workspace.memoryTokens}`,
            ]
          : []),
      ].join("\n");
    case "stats":
      return formatUsageStatsLine(event.scope, event.stats);
    case "recent":
      if (event.items.length === 0) {
        return `No recent memory items (scope=${event.scope}, limit=${event.limit}).`;
      }
      return [
        `Recent memory (${event.items.length}/${event.limit}, scope=${event.scope}):`,
        ...event.items.map((item) => `- [${item.kind}] c=${item.confidence.toFixed(2)} ${item.content}`),
      ].join("\n");
    case "search":
      if (event.items.length === 0) {
        return `No memory matches for "${event.query}" (scope=${event.scope}).`;
      }
      return [
        `Memory search "${event.query}" (${event.items.length}/${event.limit}, scope=${event.scope}):`,
        ...event.items.map((item) => `- [${item.kind}] c=${item.confidence.toFixed(2)} ${item.content}`),
      ].join("\n");
    case "context":
      return [
        `Memory context (scope=${event.scope}) for "${event.prompt}":`,
        `tokens=${event.context.totalTokens}/${event.context.budgetTokens}, hot=${event.context.hot.length}, warm=${event.context.warm.length}, cold=${event.context.cold.length}`,
      ].join("\n");
    case "clear":
      return `Cleared ${event.deleted} memory item(s) from ${event.scope}.`;
  }
};

const DEFAULT_TYPING_INDICATOR = true;
const DEFAULT_STREAMING_MODE: ChannelStreamingMode = "off";
const DEFAULT_STEERING_MODE: ChannelSteeringMode = "off";
const STREAM_EDIT_FLUSH_MS = 350;
const TYPING_PULSE_MS = 4_000;
const AUTH_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_LIST_LIMIT = 10;
const AUTO_RESUME_SESSION_LIST_LIMIT = 10;
const AUTO_RESUME_LIST_TIMEOUT_MS = 1_500;
const AUTO_RESUME_REPLAY_TIMEOUT_MS = 4_000;

const compactApprovalTool = (tool: string): string => {
  const cleaned = tool.replace(/\s+/g, " ").trim();
  if (!cleaned) return "tool";

  const match = cleaned.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+(.+)$/);
  if (!match) {
    return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
  }

  const [, name, target] = match;
  if (target.includes("/") || target.includes("\\")) {
    const leaf = target.split(/[\\/]/).filter(Boolean).at(-1);
    if (leaf) return `${name} ${leaf}`;
  }
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
};

const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const formatSessionList = (
  sessions: SessionInfo[],
  limit: number,
  activeSessionId?: string,
  hasMore = false,
): string => {
  const formatLifecycle = (session: SessionInfo): string => {
    const state = session.lifecycleState ?? (session.status === "active" ? "live" : "parked");
    if (state !== "parked") return state;
    return `${state}(${session.parkedReason ?? "manual"})`;
  };

  const formatNextAction = (session: SessionInfo): string => {
    if (session.id === activeSessionId) {
      return "current";
    }
    const state = session.lifecycleState ?? (session.status === "active" ? "live" : "parked");
    if (state === "closed") {
      return `/session history ${session.id}`;
    }
    if (state === "parked" && (session.parkedReason ?? "manual") === "transfer_pending") {
      return "transfer pending";
    }
    return `/session resume ${session.id}`;
  };

  if (sessions.length === 0) {
    return "No sessions found for this principal.";
  }
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const shown = sessions.slice(0, boundedLimit);
  return [
    `Sessions (${shown.length}/${sessions.length}):`,
    ...shown.map((session) => (
      `- ${session.id}${session.id === activeSessionId ? " (current)" : ""} lifecycle=${formatLifecycle(session)} workspace=${session.workspaceId ?? "default"} model=${session.model} last=${session.lastActivityAt} next=${formatNextAction(session)}`
    )),
    ...(hasMore ? ["More sessions available. Use /session list next."] : []),
    "Use /session resume <sessionId> to attach a listed session.",
    "Use /session delete [sessionId] to close a session explicitly.",
  ].join("\n");
};

const formatSessionLifecycleHistory = (
  sessionId: string,
  events: SessionLifecycleEventRecord[],
): string => {
  if (events.length === 0) {
    return `No lifecycle history found for session ${sessionId}.`;
  }
  return [
    `Session history for ${sessionId} (${events.length} event${events.length === 1 ? "" : "s"}):`,
    ...events.map((event) => [
      `- ${event.createdAt} ${event.eventType} ${event.fromState}->${event.toState}`,
      event.parkedReason ? `parked=${event.parkedReason}` : null,
      event.actorPrincipalId
        ? `actor=${formatPrincipalDisplay(event.actorPrincipalType ?? "user", event.actorPrincipalId)}`
        : null,
      event.reason ? `reason=${event.reason}` : null,
    ].filter((part): part is string => Boolean(part)).join(" ")),
  ].join("\n");
};

const formatSessionBoundary = (title: string, lines: string[]): string => [
  `----- ${title} -----`,
  ...lines,
  "--------------------",
].join("\n");

export const createChannelManager = (options: ChannelManagerOptions): ChannelManager => {
  const {
    gatewayUrl,
    token,
    adapters,
    reconnectDelayMs = 1_500,
    autoResumeOnUnboundPrompt = false,
    logger = createFallbackLogger(),
    bindingStore,
  } = options;

  const adapterById = new Map<string, ChannelAdapter>();
  const routeByAdapter = new Map<string, ChannelRouteConfig>();
  for (const registration of adapters) {
    adapterById.set(registration.adapter.id, registration.adapter);
    routeByAdapter.set(registration.adapter.id, registration.route ?? {});
  }

  const conversationBindings = new Map<string, ConversationBinding>();
  const sessionToConversation = new Map<string, string>();
  const sessionMetadataById = new Map<string, SessionMetadata>();
  const streamBuffers = new Map<string, string>();
  const streamFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const streamFlushInFlight = new Map<string, Promise<void>>();
  const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  const queuedPromptsByConversation = new Map<string, ChannelInboundMessage[]>();
  const reconnectNoticeByConversation = new Set<string>();
  const pendingPrompts = new Map<string, PendingPrompt>();
  const pendingApprovalsById = new Map<string, PendingApproval>();
  const pendingTransfersBySession = new Map<string, PendingTransfer>();
  const transferCommandRoutes = new Map<string, { adapterId: string; conversationId: string }>();
  const pendingSessionListRequests: PendingSessionListRequest[] = [];
  const pendingSessionLifecycleRequests: PendingSessionLifecycleRequest[] = [];
  const sessionListStateByConversation = new Map<string, SessionListPageState>();
  const pendingSessionResumeBySession = new Map<string, PendingSessionResume>();
  const sessionInfoById = new Map<string, SessionInfo>();
  const runningTurns = new Set<string>();
  const cancelRequested = new Set<string>();
  const queuedSteers = new Map<string, ChannelInboundMessage>();
  const authKeyPairs = new Map<string, AuthKeyPair>();
  const authResultQueue: AuthResultEvent[] = [];
  const authChallengeWaiters = new Set<AuthChallengeWaiter>();
  const authResultWaiters = new Set<AuthResultWaiter>();

  let running = false;
  let startedAdapters = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSessionCreate: PendingSessionCreate | null = null;
  let creationLock: Promise<void> = Promise.resolve();
  let authLock: Promise<void> = Promise.resolve();
  let latestAuthChallenge: AuthChallengeEvent | null = null;
  let activeAuthPrincipal: { principalType: PrincipalType; principalId: string } | null = null;

  const gatewayClient: GatewayClient = createGatewayClient(gatewayUrl, token);

  const conversationKeyOf = (adapterId: string, conversationId: string): string => `${adapterId}:${conversationId}`;

  const persistConversationBinding = (binding: ConversationBinding): void => {
    if (!bindingStore) return;
    const updatedAt = new Date().toISOString();
    binding.updatedAt = updatedAt;
    try {
      bindingStore.upsertChannelBinding({
        adapterId: binding.adapterId,
        conversationId: binding.conversationId,
        sessionId: binding.sessionId,
        principalType: binding.principalType,
        principalId: binding.principalId,
        ...(binding.runtimeId ? { runtimeId: binding.runtimeId } : {}),
        ...(binding.model ? { model: binding.model } : {}),
        ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
        typingIndicator: binding.typingIndicator,
        streamingMode: binding.streamingMode,
        steeringMode: binding.steeringMode,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
    } catch (error) {
      logger.warn("channel_binding_persist_failed", {
        adapterId: binding.adapterId,
        conversationId: binding.conversationId,
        sessionId: binding.sessionId,
        error: formatChannelError(error),
      });
    }
  };

  const loadPersistedBinding = (message: ChannelInboundMessage): ConversationBinding | null => {
    if (!bindingStore) return null;
    try {
      const persisted = bindingStore.getChannelBinding(message.adapterId, message.conversationId);
      if (!persisted) return null;
      const binding: ConversationBinding = {
        sessionId: persisted.sessionId,
        adapterId: persisted.adapterId,
        conversationId: persisted.conversationId,
        principalType: persisted.principalType,
        principalId: persisted.principalId,
        runtimeId: persisted.runtimeId,
        model: persisted.model,
        workspaceId: persisted.workspaceId,
        typingIndicator: persisted.typingIndicator,
        streamingMode: persisted.streamingMode,
        steeringMode: persisted.steeringMode,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
      };
      const key = conversationKeyOf(message.adapterId, message.conversationId);
      conversationBindings.set(key, binding);
      sessionToConversation.set(binding.sessionId, key);
      if (binding.runtimeId || binding.model || binding.workspaceId) {
        sessionMetadataById.set(binding.sessionId, {
          runtimeId: binding.runtimeId,
          model: binding.model,
          workspaceId: binding.workspaceId,
        });
      }
      logger.info("channel_session_binding_restored", {
        adapterId: binding.adapterId,
        conversationId: binding.conversationId,
        sessionId: binding.sessionId,
      });
      return binding;
    } catch (error) {
      logger.warn("channel_binding_restore_failed", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        error: formatChannelError(error),
      });
      return null;
    }
  };

  const enqueueAuth = async (task: () => Promise<void>): Promise<void> => {
    const prior = authLock;
    let release: () => void = () => {};
    authLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      await task();
    } finally {
      release();
    }
  };

  const resolveInboundPrincipal = (
    message: ChannelInboundMessage,
  ): {
    route: ChannelRouteConfig;
    principalType: PrincipalType;
    principalId: string;
    source: PromptSource;
  } => {
    const route = routeByAdapter.get(message.adapterId) ?? {};
    const principalType: PrincipalType = route.principalType ?? "user";
    const senderId = message.senderId.trim();
    if (!senderId) {
      throw new Error("senderId is required for channel messages.");
    }
    const rawPrincipalId = `${principalType}:${message.adapterId}:${senderId}`;
    const principalId = normalizePrincipalIdInput(rawPrincipalId, principalType);
    const source: PromptSource = route.source ?? "api";
    return {
      route,
      principalType,
      principalId,
      source,
    };
  };

  const resolveAuthKeyPair = (principalType: PrincipalType, principalId: string): AuthKeyPair => {
    const key = `${principalType}:${principalId}`;
    const existing = authKeyPairs.get(key);
    if (existing) return existing;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const generated: AuthKeyPair = {
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey,
    };
    authKeyPairs.set(key, generated);
    return generated;
  };

  const resolveAuthChallengeWaiters = (challenge: AuthChallengeEvent): void => {
    for (const waiter of authChallengeWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(challenge);
      authChallengeWaiters.delete(waiter);
    }
  };

  const rejectAuthChallengeWaiters = (error: Error): void => {
    for (const waiter of authChallengeWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      authChallengeWaiters.delete(waiter);
    }
  };

  const pushAuthResult = (result: AuthResultEvent): void => {
    const waiter = authResultWaiters.values().next().value as AuthResultWaiter | undefined;
    if (waiter) {
      clearTimeout(waiter.timeout);
      authResultWaiters.delete(waiter);
      waiter.resolve(result);
      return;
    }
    authResultQueue.push(result);
  };

  const rejectAuthResultWaiters = (error: Error): void => {
    for (const waiter of authResultWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      authResultWaiters.delete(waiter);
    }
    authResultQueue.length = 0;
  };

  const waitForAuthChallenge = (timeoutMs = AUTH_WAIT_TIMEOUT_MS): Promise<AuthChallengeEvent> => {
    if (latestAuthChallenge) {
      const expiresAtMs = Date.parse(latestAuthChallenge.expiresAt);
      if (!Number.isNaN(expiresAtMs) && expiresAtMs > Date.now()) {
        return Promise.resolve(latestAuthChallenge);
      }
      latestAuthChallenge = null;
    }

    return new Promise<AuthChallengeEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        authChallengeWaiters.delete(waiter);
        reject(new Error("Timed out waiting for auth challenge."));
      }, timeoutMs);
      const waiter: AuthChallengeWaiter = { resolve, reject, timeout };
      authChallengeWaiters.add(waiter);
    });
  };

  const waitForAuthResult = (timeoutMs = AUTH_WAIT_TIMEOUT_MS): Promise<AuthResultEvent> => {
    const queued = authResultQueue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise<AuthResultEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        authResultWaiters.delete(waiter);
        reject(new Error("Timed out waiting for auth result."));
      }, timeoutMs);
      const waiter: AuthResultWaiter = { resolve, reject, timeout };
      authResultWaiters.add(waiter);
    });
  };

  const getLatestAuthChallenge = (): AuthChallengeEvent | null => latestAuthChallenge;

  const ensureConnectionPrincipal = async (
    principalType: PrincipalType,
    principalId: string,
  ): Promise<void> => {
    await enqueueAuth(async () => {
      if (
        activeAuthPrincipal
        && activeAuthPrincipal.principalType === principalType
        && activeAuthPrincipal.principalId === principalId
      ) {
        return;
      }

      const keyPair = resolveAuthKeyPair(principalType, principalId);

      const sendChallengeProbe = (): void => {
        gatewayClient.send({
          type: "auth_proof",
          principalType,
          principalId,
          publicKey: keyPair.publicKey,
          challengeId: "",
          nonce: "",
          signature: "",
          algorithm: "ed25519",
        });
      };

      const clearQueuedAuthResults = (): void => {
        authResultQueue.length = 0;
      };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const challengeForAttempt = getLatestAuthChallenge();
        const latestChallengeExpiresAt = challengeForAttempt?.expiresAt;
        const hasValidChallenge = latestChallengeExpiresAt !== undefined
          && Date.parse(latestChallengeExpiresAt) > Date.now();
        if (!hasValidChallenge) {
          sendChallengeProbe();
        }

        let challenge: AuthChallengeEvent;
        try {
          challenge = await waitForAuthChallenge();
        } catch (error) {
          if (attempt >= 2) {
            throw error;
          }
          logger.warn("channel_auth_challenge_wait_retry", {
            principalType,
            principalId,
            attempt: attempt + 1,
            error: formatChannelError(error),
          });
          continue;
        }

        const payload = `${challenge.challengeId}:${challenge.nonce}:${principalType}:${principalId}`;
        const signature = sign(null, Buffer.from(payload, "utf8"), keyPair.privateKey).toString("base64");
        // Drop stale auth_result events (typically probe-side failures) before sending signed proof.
        clearQueuedAuthResults();
        gatewayClient.send({
          type: "auth_proof",
          principalType,
          principalId,
          publicKey: keyPair.publicKey,
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          signature,
          algorithm: "ed25519",
        });
        latestAuthChallenge = null;
        const authAttemptDeadline = Date.now() + AUTH_WAIT_TIMEOUT_MS;
        let shouldRetryChallenge = false;
        while (Date.now() < authAttemptDeadline) {
          const remaining = Math.max(100, authAttemptDeadline - Date.now());
          let result: AuthResultEvent;
          try {
            result = await waitForAuthResult(remaining);
          } catch {
            shouldRetryChallenge = true;
            break;
          }
          if (
            result.principalType !== undefined
            && result.principalType !== principalType
          ) {
            continue;
          }
          if (
            result.principalId !== undefined
            && result.principalId !== principalId
          ) {
            continue;
          }
          if (result.ok) {
            activeAuthPrincipal = { principalType, principalId };
            return;
          }
          const reason = result.message ?? "Unknown authentication failure.";
          if (reason.includes("Auth challenge is missing or expired")) {
            // Retry this attempt; challenge may have rotated.
            const freshChallenge = getLatestAuthChallenge();
            const freshChallengeExpiresAt = freshChallenge?.expiresAt;
            const hasFreshChallenge = freshChallengeExpiresAt !== undefined
              && Date.parse(freshChallengeExpiresAt) > Date.now();
            if (
              hasFreshChallenge
              && freshChallenge
              && (
                freshChallenge.challengeId !== challenge.challengeId
                || freshChallenge.nonce !== challenge.nonce
              )
            ) {
              shouldRetryChallenge = true;
              break;
            }
            shouldRetryChallenge = true;
            break;
          }
          if (reason.includes("Auth challenge required; resent active challenge")) {
            const freshChallenge = getLatestAuthChallenge();
            const freshChallengeExpiresAt = freshChallenge?.expiresAt;
            const hasFreshChallenge = freshChallengeExpiresAt !== undefined
              && Date.parse(freshChallengeExpiresAt) > Date.now();
            if (
              hasFreshChallenge
              && freshChallenge
              && (
                freshChallenge.challengeId !== challenge.challengeId
                || freshChallenge.nonce !== challenge.nonce
              )
            ) {
              shouldRetryChallenge = true;
              break;
            }
            shouldRetryChallenge = true;
            break;
          }
          if (
            reason.includes("does not match active challenge")
            || reason.includes("Auth challenge expired")
            || reason.includes("Auth nonce does not match active challenge")
          ) {
            shouldRetryChallenge = true;
            break;
          }
          throw new Error(`Auth failed for ${principalType}:${principalId}: ${reason}`);
        }
        if (shouldRetryChallenge) {
          continue;
        }
      }

      throw new Error(`Auth failed for ${principalType}:${principalId}: retry budget exhausted.`);
    });
  };

  const sendToConversation = async (
    adapterId: string,
    conversationId: string,
    text: string,
    quickActions?: ChannelQuickAction[],
  ): Promise<void> => {
    const adapter = adapterById.get(adapterId);
    if (!adapter) {
      logger.warn("channel_send_missing_adapter", { adapterId, conversationId });
      return;
    }
    await adapter.sendMessage({ conversationId, text, quickActions });
  };

  const parseConversationKey = (key: string): { adapterId: string; conversationId: string } | null => {
    const splitAt = key.indexOf(":");
    if (splitAt <= 0) return null;
    return {
      adapterId: key.slice(0, splitAt),
      conversationId: key.slice(splitAt + 1),
    };
  };

  const queuePromptWhileDisconnected = async (message: ChannelInboundMessage): Promise<void> => {
    const key = conversationKeyOf(message.adapterId, message.conversationId);
    const existing = queuedPromptsByConversation.get(key);
    if (existing) {
      existing.push(message);
    } else {
      queuedPromptsByConversation.set(key, [message]);
    }
    if (reconnectNoticeByConversation.has(key)) return;
    reconnectNoticeByConversation.add(key);
    await sendToConversation(
      message.adapterId,
      message.conversationId,
      "Nexus is reconnecting. I will send your message when the connection is back.",
    );
  };

  const listPendingApprovalsForSession = (sessionId: string): PendingApproval[] => (
    Array.from(pendingApprovalsById.values()).filter((approval) => approval.sessionId === sessionId)
  );

  const clearPendingSessionResume = (sessionId: string, error?: Error): PendingSessionResume | undefined => {
    const pending = pendingSessionResumeBySession.get(sessionId);
    if (!pending) return undefined;
    pendingSessionResumeBySession.delete(sessionId);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (error) {
      pending.reject?.(error);
    }
    return pending;
  };

  const sendApprovalPrompt = async (pending: PendingApproval, totalPendingForSession: number): Promise<void> => {
    const adapter = adapterById.get(pending.adapterId);
    const supportsQuickActions = adapter?.supportsQuickActions === true;
    const quickActions: ChannelQuickAction[] | undefined = supportsQuickActions
      ? [
          { label: "Approve", command: `/approve ${pending.requestId}` },
          { label: "Approve All", command: "/approve all" },
          { label: "Deny", command: `/deny ${pending.requestId}` },
        ]
      : undefined;
    const toolLabel = compactApprovalTool(pending.tool);
    const text = supportsQuickActions
      ? `Approval required: ${toolLabel}${totalPendingForSession > 1 ? ` (${totalPendingForSession} pending)` : ""}`
      : [
          `Approval required for ${toolLabel}`,
          `requestId=${pending.requestId}`,
          ...(totalPendingForSession > 1 ? [`pending=${totalPendingForSession}`] : []),
          `Use /approve ${pending.requestId}, /approve all, or /deny ${pending.requestId}`,
        ].join("\n");
    await sendToConversation(
      pending.adapterId,
      pending.conversationId,
      text,
      quickActions,
    );
  };

  const maybeSendNextApprovalPrompt = async (sessionId: string): Promise<void> => {
    const pendingForSession = listPendingApprovalsForSession(sessionId);
    if (pendingForSession.length === 0) return;
    await sendApprovalPrompt(pendingForSession[0], pendingForSession.length);
  };

  const resolveBindingBySession = (sessionId: string): ConversationBinding | undefined => {
    const conversationKey = sessionToConversation.get(sessionId);
    if (!conversationKey) return undefined;
    return conversationBindings.get(conversationKey);
  };

  const rebindConversationToSession = (
    adapterId: string,
    conversationId: string,
    sessionId: string,
    principalType: PrincipalType,
    principalId: string,
    metadata?: SessionMetadata,
  ): ConversationBinding => {
    const route = routeByAdapter.get(adapterId) ?? {};
    const key = conversationKeyOf(adapterId, conversationId);
    const existing = conversationBindings.get(key);

    const replacedSessionId = existing?.sessionId;
    if (
      replacedSessionId
      && replacedSessionId !== sessionId
      && sessionToConversation.get(replacedSessionId) === key
    ) {
      sessionToConversation.delete(replacedSessionId);
    }

    const previousConversationKey = sessionToConversation.get(sessionId);
    if (previousConversationKey && previousConversationKey !== key) {
      const previousBinding = conversationBindings.get(previousConversationKey);
      if (previousBinding?.sessionId === sessionId) {
        conversationBindings.delete(previousConversationKey);
      }
    }

    const binding: ConversationBinding = {
      sessionId,
      adapterId,
      conversationId,
      principalType,
      principalId,
      runtimeId: metadata?.runtimeId ?? existing?.runtimeId ?? route.runtimeId ?? "default",
      model: metadata?.model ?? existing?.model ?? route.model,
      workspaceId: metadata?.workspaceId ?? existing?.workspaceId ?? route.workspaceId ?? "default",
      typingIndicator: existing?.typingIndicator ?? route.typingIndicator ?? DEFAULT_TYPING_INDICATOR,
      streamingMode: existing?.streamingMode ?? route.streamingMode ?? DEFAULT_STREAMING_MODE,
      steeringMode: existing?.steeringMode ?? route.steeringMode ?? DEFAULT_STEERING_MODE,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    conversationBindings.set(key, binding);
    sessionToConversation.set(sessionId, key);
    persistConversationBinding(binding);
    return binding;
  };

  const sendTypingState = async (sessionId: string, active: boolean): Promise<void> => {
    const binding = resolveBindingBySession(sessionId);
    if (!binding || !binding.typingIndicator) return;
    const adapter = adapterById.get(binding.adapterId);
    if (!adapter?.setTyping) return;
    await adapter.setTyping({
      conversationId: binding.conversationId,
      active,
    });
  };

  const startTyping = (sessionId: string): void => {
    if (typingTimers.has(sessionId)) return;
    void sendTypingState(sessionId, true).catch((error) => {
      logger.warn("channel_typing_set_failed", {
        sessionId,
        active: true,
        error: formatChannelError(error),
      });
    });
    const timer = setInterval(() => {
      void sendTypingState(sessionId, true).catch((error) => {
        logger.warn("channel_typing_pulse_failed", {
          sessionId,
          error: formatChannelError(error),
        });
      });
    }, TYPING_PULSE_MS);
    timer.unref?.();
    typingTimers.set(sessionId, timer);
  };

  const stopTyping = (sessionId: string): void => {
    const timer = typingTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      typingTimers.delete(sessionId);
    }
    void sendTypingState(sessionId, false).catch((error) => {
      logger.warn("channel_typing_set_failed", {
        sessionId,
        active: false,
        error: formatChannelError(error),
      });
    });
  };

  const clearStreamFlushTimer = (sessionId: string): void => {
    const timer = streamFlushTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    streamFlushTimers.delete(sessionId);
  };

  const clearSessionState = (sessionId: string): void => {
    sessionMetadataById.delete(sessionId);
    sessionInfoById.delete(sessionId);
    clearPendingSessionResume(sessionId, new Error(`Session state cleared: ${sessionId}`));
    pendingTransfersBySession.delete(sessionId);
    transferCommandRoutes.delete(sessionId);
    streamBuffers.delete(sessionId);
    clearStreamFlushTimer(sessionId);
    streamFlushInFlight.delete(sessionId);
    stopTyping(sessionId);
    pendingPrompts.delete(sessionId);
    runningTurns.delete(sessionId);
    cancelRequested.delete(sessionId);
    queuedSteers.delete(sessionId);
    for (const [requestId, approval] of pendingApprovalsById) {
      if (approval.sessionId === sessionId) pendingApprovalsById.delete(requestId);
    }
    const conversationKey = sessionToConversation.get(sessionId);
    if (!conversationKey) return;
    sessionToConversation.delete(sessionId);
    const binding = conversationBindings.get(conversationKey);
    if (binding?.sessionId === sessionId) {
      conversationBindings.delete(conversationKey);
      try {
        bindingStore?.deleteChannelBinding(binding.adapterId, binding.conversationId);
      } catch (error) {
        logger.warn("channel_binding_delete_failed", {
          adapterId: binding.adapterId,
          conversationId: binding.conversationId,
          sessionId,
          error: formatChannelError(error),
        });
      }
    }
  };

  const waitForSessionCreated = (conversationKey: string): Promise<string> => {
    const promise = new Promise<string>((resolve, reject) => {
      if (pendingSessionCreate) {
        const previous = pendingSessionCreate;
        pendingSessionCreate = null;
        clearTimeout(previous.timeout);
        previous.reject(new Error(`Superseded pending session creation (${previous.conversationKey})`));
      }

      const timeout = setTimeout(() => {
        if (pendingSessionCreate?.conversationKey === conversationKey) {
          pendingSessionCreate = null;
        }
        reject(new Error(`Timed out waiting for session_created (${conversationKey})`));
      }, 20_000);

      pendingSessionCreate = {
        conversationKey,
        resolve: (sessionId) => {
          clearTimeout(timeout);
          resolve(sessionId);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      };
    });

    // Avoid fatal unhandled rejections if caller aborts before awaiting.
    void promise.catch(() => undefined);
    return promise;
  };

  const enqueueSessionCreation = async (task: () => Promise<void>): Promise<void> => {
    const prior = creationLock;
    let release: () => void = () => {};
    creationLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      await task();
    } finally {
      release();
    }
  };

  const requestSessionListProbe = async (
    principalType: PrincipalType,
    principalId: string,
  ): Promise<SessionInfo[]> => {
    await ensureConnectionPrincipal(principalType, principalId);
    return await new Promise<SessionInfo[]>((resolve, reject) => {
      let request: PendingSessionListProbeRequest | null = null;
      const timeout = setTimeout(() => {
        const index = request ? pendingSessionListRequests.indexOf(request) : -1;
        if (index >= 0) {
          pendingSessionListRequests.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for session list probe (${principalType}:${principalId}).`));
      }, AUTO_RESUME_LIST_TIMEOUT_MS);
      request = {
        kind: "probe",
        principalType,
        principalId,
        resolve: (sessions) => {
          clearTimeout(timeout);
          resolve(sessions);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      };
      pendingSessionListRequests.push(request);
      try {
        gatewayClient.send({
          type: "session_list",
          limit: AUTO_RESUME_SESSION_LIST_LIMIT,
        });
      } catch (error) {
        const index = request ? pendingSessionListRequests.indexOf(request) : -1;
        if (index >= 0) {
          pendingSessionListRequests.splice(index, 1);
        }
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const selectAutoResumeCandidate = (
    sessions: SessionInfo[],
    conversationKey: string,
  ): SessionInfo | null => {
    for (const session of sessions) {
      if (!canAutoResumeSession(session.lifecycleState, session.parkedReason)) continue;
      const boundConversationKey = sessionToConversation.get(session.id);
      if (boundConversationKey && boundConversationKey !== conversationKey) continue;
      return session;
    }
    return null;
  };

  const tryAutoResumeSession = async (
    message: ChannelInboundMessage,
    resolvedPrincipal: ReturnType<typeof resolveInboundPrincipal>,
  ): Promise<string | null> => {
    if (!autoResumeOnUnboundPrompt) return null;
    const key = conversationKeyOf(message.adapterId, message.conversationId);
    const { principalType, principalId } = resolvedPrincipal;

    let sessions: SessionInfo[] = [];
    try {
      sessions = await requestSessionListProbe(principalType, principalId);
    } catch (error) {
      if (isGatewayDisconnectedError(error)) throw error;
      logger.warn("channel_auto_resume_probe_failed", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        principalType,
        principalId,
        error: formatChannelError(error),
      });
      return null;
    }

    const candidate = selectAutoResumeCandidate(sessions, key);
    if (!candidate) return null;
    if (pendingSessionResumeBySession.has(candidate.id)) return null;

    const resumedSessionId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearPendingSessionResume(candidate.id, new Error(`Timed out auto-resuming session ${candidate.id}.`));
      }, AUTO_RESUME_REPLAY_TIMEOUT_MS);
      pendingSessionResumeBySession.set(candidate.id, {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        principalType,
        principalId,
        silent: true,
        resolve,
        reject,
        timeout,
      });
      try {
        gatewayClient.send({
          type: "session_replay",
          sessionId: candidate.id,
        });
      } catch (error) {
        clearPendingSessionResume(candidate.id, error instanceof Error ? error : new Error(String(error)));
      }
    }).catch((error: unknown) => {
      if (isGatewayDisconnectedError(error)) throw error;
      logger.warn("channel_auto_resume_replay_failed", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        principalType,
        principalId,
        sessionId: candidate.id,
        error: formatChannelError(error),
      });
      return "";
    });

    if (!resumedSessionId) return null;
    logger.info("channel_session_auto_resumed", {
      adapterId: message.adapterId,
      conversationId: message.conversationId,
      sessionId: resumedSessionId,
      principalType,
      principalId,
    });
    return resumedSessionId;
  };

  const ensureSession = async (
    message: ChannelInboundMessage,
    resolvedPrincipal = resolveInboundPrincipal(message),
    options?: {
      allowAutoResume?: boolean;
    },
  ): Promise<string> => {
    const key = conversationKeyOf(message.adapterId, message.conversationId);
    const existing = conversationBindings.get(key);
    if (existing) return existing.sessionId;
    const persisted = loadPersistedBinding(message);
    if (persisted) return persisted.sessionId;
    if (options?.allowAutoResume !== false) {
      const resumedSessionId = await tryAutoResumeSession(message, resolvedPrincipal);
      if (resumedSessionId) {
        return resumedSessionId;
      }
    }

    let createdSessionId = "";
    await enqueueSessionCreation(async () => {
      const { route, principalType, principalId, source } = resolvedPrincipal;
      const typingIndicator = route.typingIndicator ?? DEFAULT_TYPING_INDICATOR;
      const streamingMode = route.streamingMode ?? DEFAULT_STREAMING_MODE;
      const steeringMode = route.steeringMode ?? DEFAULT_STEERING_MODE;

      const awaiting = waitForSessionCreated(key);
      try {
        gatewayClient.send({
          type: "session_new",
          runtimeId: route.runtimeId,
          model: route.model,
          workspaceId: route.workspaceId,
          principalType,
          principalId,
          source,
        });
      } catch (error) {
        if (pendingSessionCreate?.conversationKey === key) {
          const pending = pendingSessionCreate;
          pendingSessionCreate = null;
          clearTimeout(pending.timeout);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      }

      createdSessionId = await awaiting;
      const sessionMetadata = sessionMetadataById.get(createdSessionId);
      const binding = rebindConversationToSession(
        message.adapterId,
        message.conversationId,
        createdSessionId,
        principalType,
        principalId,
        sessionMetadata,
      );

      logger.info("channel_session_bound", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        sessionId: createdSessionId,
        principalId,
        runtimeId: binding.runtimeId,
        model: binding.model ?? "runtime-default",
        workspaceId: binding.workspaceId ?? "default",
        streamingMode,
        typingIndicator,
        steeringMode,
      });
    });

    const resolved = conversationBindings.get(key);
    if (!resolved) {
      throw new Error(`Failed to create session for ${key}`);
    }

    await sendToConversation(
      resolved.adapterId,
      resolved.conversationId,
      formatSessionBoundary("Session started", [
        `session=${resolved.sessionId}`,
        `runtime=${resolved.runtimeId ?? "default"}`,
        `model=${resolved.model ?? "runtime-default"}`,
        `workspace=${resolved.workspaceId ?? "default"}`,
      ]),
    );

    return resolved.sessionId;
  };

  const sendPromptForSession = async (
    sessionId: string,
    message: ChannelInboundMessage,
    retryCount: number = 0,
  ): Promise<void> => {
    pendingPrompts.set(sessionId, { message, retryCount });
    startTyping(sessionId);
    try {
      gatewayClient.send({
        type: "prompt",
        sessionId,
        text: message.text,
        images: message.images,
      });
      runningTurns.add(sessionId);
      cancelRequested.delete(sessionId);
    } catch (error) {
      pendingPrompts.delete(sessionId);
      stopTyping(sessionId);
      throw error;
    }
  };

  const sendPrompt = async (message: ChannelInboundMessage, retryCount: number = 0): Promise<void> => {
    const sessionId = await ensureSession(message);
    await sendPromptForSession(sessionId, message, retryCount);
  };

  const queueSteer = async (sessionId: string, message: ChannelInboundMessage): Promise<void> => {
    const binding = resolveBindingBySession(sessionId);
    if (!binding) {
      await sendPromptForSession(sessionId, message, 0);
      return;
    }
    queuedSteers.set(sessionId, message);

    if (!cancelRequested.has(sessionId)) {
      try {
        gatewayClient.send({ type: "cancel", sessionId });
        cancelRequested.add(sessionId);
      } catch (error) {
        queuedSteers.delete(sessionId);
        throw error;
      }
      await sendToConversation(binding.adapterId, binding.conversationId, "Steering queued. Cancelling current turn...");
      return;
    }

    await sendToConversation(binding.adapterId, binding.conversationId, "Steering updated. Waiting for turn to stop...");
  };

  const sendPromptOrSteer = async (message: ChannelInboundMessage): Promise<void> => {
    const sessionId = await ensureSession(message);
    const binding = resolveBindingBySession(sessionId);
    if (binding?.steeringMode === "on" && runningTurns.has(sessionId)) {
      await queueSteer(sessionId, message);
      return;
    }
    await sendPromptForSession(sessionId, message, 0);
  };

  const flushQueuedPrompts = async (): Promise<void> => {
    if (!gatewayClient.isOpen()) return;
    const queuedEntries = Array.from(queuedPromptsByConversation.entries());
    if (queuedEntries.length === 0) {
      reconnectNoticeByConversation.clear();
      return;
    }
    queuedPromptsByConversation.clear();

    for (const [conversationKey, queued] of queuedEntries) {
      const parsed = parseConversationKey(conversationKey);
      if (!parsed || queued.length === 0) continue;
      const { adapterId, conversationId } = parsed;

      if (reconnectNoticeByConversation.has(conversationKey)) {
        await sendToConversation(
          adapterId,
          conversationId,
          queued.length === 1
            ? "Reconnected. Sending your queued message..."
            : `Reconnected. Sending ${queued.length} queued messages...`,
        );
      }
      reconnectNoticeByConversation.delete(conversationKey);

      for (let index = 0; index < queued.length; index += 1) {
        const message = queued[index];
        try {
          await sendPromptOrSteer(message);
        } catch (error) {
          if (isGatewayDisconnectedError(error)) {
            const remaining = queued.slice(index);
            const prior = queuedPromptsByConversation.get(conversationKey) ?? [];
            queuedPromptsByConversation.set(conversationKey, [...remaining, ...prior]);
            if (!reconnectNoticeByConversation.has(conversationKey)) {
              reconnectNoticeByConversation.add(conversationKey);
              await sendToConversation(
                adapterId,
                conversationId,
                "Still reconnecting. I will keep trying automatically.",
              );
            }
            return;
          }
          await sendToConversation(adapterId, conversationId, formatUserFacingError(formatChannelError(error)));
        }
      }
    }
  };

  const sendHelp = async (adapterId: string, conversationId: string): Promise<void> => {
    await sendToConversation(
      adapterId,
      conversationId,
      [
        "Nexus channel commands:",
        "/help",
        "/status",
        "/session [list|history|resume|transfer|close|delete]",
        "/usage [summary|stats|recent|search|context|clear]",
        "/new",
        "/cancel",
        "/approve <requestId|all>",
        "/deny <requestId>",
      ].join("\n"),
    );
  };

  const handleSessionTransferCommand = async (
    message: ChannelInboundMessage,
    binding: ConversationBinding | undefined,
    resolvedPrincipal: ReturnType<typeof resolveInboundPrincipal>,
    transferParts: string[],
    options?: {
      deprecatedAlias?: boolean;
    },
  ): Promise<boolean> => {
    const sub = transferParts[0]?.trim().toLowerCase();
    const pendingTransfers = Array.from(pendingTransfersBySession.values()).filter((transfer) => (
      transfer.targetPrincipalType === resolvedPrincipal.principalType
      && transfer.targetPrincipalId === resolvedPrincipal.principalId
    ));
    const currentTransfer = pendingTransfers[0];
    const usagePrefix = "/session transfer";

    if (options?.deprecatedAlias) {
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        "Deprecated: use /session transfer ... (legacy /transfer still works for now).",
      );
    }

    if (!sub || sub === "pending") {
      if (pendingTransfers.length === 0) {
        await sendToConversation(message.adapterId, message.conversationId, "No pending transfer requests.");
        return true;
      }
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        [
          `Pending transfers (${pendingTransfers.length}):`,
          ...pendingTransfers.map((transfer) => (
            `- session=${transfer.sessionId} from=${formatPrincipalDisplay(transfer.fromPrincipalType, transfer.fromPrincipalId)} expires=${transfer.expiresAt}`
          )),
        ].join("\n"),
      );
      return true;
    }

    if (sub === "request") {
      if (!binding) {
        await sendToConversation(message.adapterId, message.conversationId, "No active session.");
        return true;
      }
      const targetPrincipalRaw = transferParts[1]?.trim();
      const targetPrincipalTypeRaw = transferParts[2]?.trim().toLowerCase();
      const targetPrincipalType: PrincipalType = targetPrincipalTypeRaw === "service_account" ? "service_account" : "user";
      const expiresInMsRaw = transferParts[3]?.trim();
      let expiresInMs: number | undefined;
      if (!targetPrincipalRaw) {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Usage: ${usagePrefix} request <targetPrincipalId> [user|service_account] [expiresMs]`,
        );
        return true;
      }
      if (expiresInMsRaw) {
        const parsed = Number.parseInt(expiresInMsRaw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          await sendToConversation(
            message.adapterId,
            message.conversationId,
            `Usage: ${usagePrefix} request <targetPrincipalId> [user|service_account] [expiresMs]`,
          );
          return true;
        }
        expiresInMs = parsed;
      }

      const targetPrincipalId = normalizePrincipalIdInput(targetPrincipalRaw, targetPrincipalType);
      await ensureConnectionPrincipal(resolvedPrincipal.principalType, resolvedPrincipal.principalId);
      gatewayClient.send({
        type: "session_transfer_request",
        sessionId: binding.sessionId,
        targetPrincipalType,
        targetPrincipalId,
        ...(expiresInMs !== undefined ? { expiresInMs } : {}),
      });
      transferCommandRoutes.set(binding.sessionId, {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
      });
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        `Transfer requested for session ${binding.sessionId} -> ${formatPrincipalDisplay(targetPrincipalType, targetPrincipalId)}${expiresInMs !== undefined ? ` (ttl=${expiresInMs}ms)` : ""}`,
      );
      return true;
    }

    if (sub === "accept") {
      const sessionId = transferParts[1]?.trim() || currentTransfer?.sessionId;
      if (!sessionId) {
        await sendToConversation(message.adapterId, message.conversationId, `Usage: ${usagePrefix} accept [sessionId]`);
        return true;
      }
      const pending = pendingTransfersBySession.get(sessionId);
      if (
        pending
        && (
          pending.targetPrincipalType !== resolvedPrincipal.principalType
          || pending.targetPrincipalId !== resolvedPrincipal.principalId
        )
      ) {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Transfer ${sessionId} is targeted to ${formatPrincipalDisplay(pending.targetPrincipalType, pending.targetPrincipalId)}.`,
        );
        return true;
      }

      await ensureConnectionPrincipal(resolvedPrincipal.principalType, resolvedPrincipal.principalId);
      gatewayClient.send({
        type: "session_transfer_accept",
        sessionId,
      });
      transferCommandRoutes.set(sessionId, {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
      });
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        `Accepting transfer for session ${sessionId}...`,
      );
      return true;
    }

    if (sub === "dismiss" || sub === "ignore") {
      const sessionId = transferParts[1]?.trim() || currentTransfer?.sessionId;
      if (!sessionId) {
        await sendToConversation(message.adapterId, message.conversationId, `Usage: ${usagePrefix} dismiss [sessionId]`);
        return true;
      }
      const pending = pendingTransfersBySession.get(sessionId);
      if (
        pending
        && (
          pending.targetPrincipalType !== resolvedPrincipal.principalType
          || pending.targetPrincipalId !== resolvedPrincipal.principalId
        )
      ) {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Transfer ${sessionId} is targeted to ${formatPrincipalDisplay(pending.targetPrincipalType, pending.targetPrincipalId)}.`,
        );
        return true;
      }
      await ensureConnectionPrincipal(resolvedPrincipal.principalType, resolvedPrincipal.principalId);
      gatewayClient.send({
        type: "session_transfer_dismiss",
        sessionId,
      });
      transferCommandRoutes.set(sessionId, {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
      });
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        `Dismissing transfer for session ${sessionId}...`,
      );
      return true;
    }

    await sendToConversation(
      message.adapterId,
      message.conversationId,
      `Usage: ${usagePrefix} pending | request <targetPrincipalId> [user|service_account] [expiresMs] | accept [sessionId] | dismiss [sessionId]`,
    );
    return true;
  };

  const handleCommand = async (
    message: ChannelInboundMessage,
    resolvedPrincipal = resolveInboundPrincipal(message),
  ): Promise<boolean> => {
    const text = message.text.trim();
    if (!text.startsWith("/")) return false;

    const [commandRaw, ...parts] = text.slice(1).split(/\s+/);
    const command = commandRaw?.toLowerCase() ?? "";
    const key = conversationKeyOf(message.adapterId, message.conversationId);
    const binding = conversationBindings.get(key);

    if (command === "help" || command === "commands") {
      await sendHelp(message.adapterId, message.conversationId);
      return true;
    }

    if (command === "new") {
      if (binding) {
        clearSessionState(binding.sessionId);
      }
      await ensureSession(message, resolvedPrincipal, { allowAutoResume: false });
      return true;
    }

    if (command === "status") {
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        binding
          ? [
              `Session: ${binding.sessionId}`,
              `Principal: ${binding.principalId}`,
              `Source: api`,
              `Runtime: ${binding.runtimeId ?? "default"}`,
              `Model: ${binding.model ?? "runtime-default"}`,
              `Workspace: ${binding.workspaceId ?? "default"}`,
              `Steering: ${binding.steeringMode}`,
              `Running: ${runningTurns.has(binding.sessionId) ? "yes" : "no"}`,
              `Pending transfers: ${Array.from(pendingTransfersBySession.values()).filter((transfer) => (
                transfer.targetPrincipalType === resolvedPrincipal.principalType
                && transfer.targetPrincipalId === resolvedPrincipal.principalId
              )).length}`,
            ].join("\n")
          : "No active session for this conversation. Send any prompt to create one.",
      );
      return true;
    }

    if (command === "session") {
      const sub = parts[0]?.trim().toLowerCase();
      if (!sub || sub === "help") {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          [
            "Usage: /session <command>",
            "/session list [limit|next [limit]]",
            "/session history [sessionId] [limit]",
            "/session resume <sessionId>",
            "/session takeover <sessionId>",
            "/session transfer pending|request|accept|dismiss",
            "/session close [sessionId]",
            "/session delete [sessionId]",
          ].join("\n"),
        );
        return true;
      }

      if (sub === "list") {
        const rawArg = parts[1]?.trim().toLowerCase();
        const isNext = rawArg === "next";
        const limitArg = isNext ? parts[2] : parts[1];
        const requestedLimit = parsePositiveInteger(limitArg);
        if (limitArg && requestedLimit === undefined) {
          await sendToConversation(message.adapterId, message.conversationId, "Usage: /session list [limit|next [limit]]");
          return true;
        }
        const sessionListState = sessionListStateByConversation.get(key);
        const limit = requestedLimit ?? sessionListState?.limit ?? DEFAULT_SESSION_LIST_LIMIT;
        const cursor = isNext ? sessionListState?.nextCursor : undefined;
        const isSamePrincipal = !sessionListState || (
          sessionListState.principalType === resolvedPrincipal.principalType
          && sessionListState.principalId === resolvedPrincipal.principalId
        );
        if (isNext && !isSamePrincipal) {
          await sendToConversation(message.adapterId, message.conversationId, "Principal changed. Run /session list first.");
          return true;
        }
        if (isNext && (!sessionListState?.hasMore || !cursor)) {
          await sendToConversation(message.adapterId, message.conversationId, "No additional sessions in the current list window.");
          return true;
        }
        await ensureConnectionPrincipal(resolvedPrincipal.principalType, resolvedPrincipal.principalId);
        pendingSessionListRequests.push({
          kind: "display",
          adapterId: message.adapterId,
          conversationId: message.conversationId,
          principalType: resolvedPrincipal.principalType,
          principalId: resolvedPrincipal.principalId,
          limit,
          ...(cursor ? { cursor } : {}),
          activeSessionId: binding?.sessionId,
        });
        gatewayClient.send({
          type: "session_list",
          limit,
          ...(cursor ? { cursor } : {}),
        });
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          isNext ? "Fetching next sessions page..." : "Fetching sessions...",
        );
        return true;
      }

      if (sub === "history") {
        const rawTarget = parts[1]?.trim();
        const implicitLimit = parsePositiveInteger(rawTarget);
        const sessionId = implicitLimit !== undefined
          ? binding?.sessionId
          : rawTarget || binding?.sessionId;
        const limitArg = implicitLimit !== undefined ? rawTarget : parts[2];
        const parsedLimit = parsePositiveInteger(limitArg);
        if ((limitArg && parsedLimit === undefined) || !sessionId) {
          await sendToConversation(
            message.adapterId,
            message.conversationId,
            "Usage: /session history [sessionId] [limit]",
          );
          return true;
        }
        await ensureConnectionPrincipal(resolvedPrincipal.principalType, resolvedPrincipal.principalId);
        pendingSessionLifecycleRequests.push({
          adapterId: message.adapterId,
          conversationId: message.conversationId,
          sessionId,
        });
        gatewayClient.send({
          type: "session_lifecycle_query",
          sessionId,
          ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        });
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Fetching session history for ${sessionId}...`,
        );
        return true;
      }

      if (sub === "resume" || sub === "takeover") {
        const sessionId = parts[1]?.trim();
        if (!sessionId) {
          await sendToConversation(
            message.adapterId,
            message.conversationId,
            `Usage: /session ${sub} <sessionId>`,
          );
          return true;
        }
        await ensureConnectionPrincipal(resolvedPrincipal.principalType, resolvedPrincipal.principalId);
        pendingSessionResumeBySession.set(sessionId, {
          adapterId: message.adapterId,
          conversationId: message.conversationId,
          principalType: resolvedPrincipal.principalType,
          principalId: resolvedPrincipal.principalId,
          previousSessionId: binding?.sessionId,
        });
        gatewayClient.send({ type: sub === "takeover" ? "session_takeover" : "session_replay", sessionId });
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `${sub === "takeover" ? "Taking over" : "Resuming"} session ${sessionId}...`,
        );
        return true;
      }

      if (sub === "transfer") {
        return handleSessionTransferCommand(message, binding, resolvedPrincipal, parts.slice(1));
      }

      if (sub === "close" || sub === "delete") {
        const sessionId = parts[1]?.trim() || binding?.sessionId;
        if (!sessionId) {
          await sendToConversation(message.adapterId, message.conversationId, `Usage: /session ${sub} [sessionId]`);
          return true;
        }
        if (sub === "delete") {
          await sendToConversation(
            message.adapterId,
            message.conversationId,
            "Hard delete is not supported yet; closing session instead.",
          );
        }
        gatewayClient.send({ type: "session_close", sessionId });
        await sendToConversation(message.adapterId, message.conversationId, `Closing session ${sessionId}...`);
        return true;
      }

        await sendToConversation(
          message.adapterId,
          message.conversationId,
          "Usage: /session [list|history|resume|takeover|transfer|close|delete]",
        );
        return true;
      }

    if (command === "transfer") {
      return handleSessionTransferCommand(message, binding, resolvedPrincipal, parts, {
        deprecatedAlias: true,
      });
    }

    if (command === "usage") {
      if (!binding) {
        await sendToConversation(message.adapterId, message.conversationId, "No active session for usage commands.");
        return true;
      }
      const sub = parts[0]?.trim().toLowerCase();
      if (!sub || sub === "summary") {
        gatewayClient.send({ type: "usage_query", sessionId: binding.sessionId, action: "summary" });
        return true;
      }

      if (sub === "stats") {
        const scope = parseUsageScope(parts[1]);
        if (parts[1] && (!scope || scope === "hybrid")) {
          await sendToConversation(message.adapterId, message.conversationId, "Usage: /usage stats [session|workspace]");
          return true;
        }
        gatewayClient.send({
          type: "usage_query",
          sessionId: binding.sessionId,
          action: "stats",
          ...(scope ? { scope } : {}),
        });
        return true;
      }

      if (sub === "recent") {
        let parsedLimit: number | undefined;
        let scopeRaw: string | undefined;
        const firstArg = parts[1];
        const firstScope = parseUsageScope(firstArg);
        if (firstArg && firstScope) {
          scopeRaw = firstArg;
        } else if (firstArg) {
          parsedLimit = Number.parseInt(firstArg, 10);
          if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
            await sendToConversation(message.adapterId, message.conversationId, "Usage: /usage recent [n] [session|workspace]");
            return true;
          }
          scopeRaw = parts[2];
        }
        const scope = parseUsageScope(scopeRaw);
        if (scopeRaw && (!scope || scope === "hybrid")) {
          await sendToConversation(message.adapterId, message.conversationId, "Usage: /usage recent [n] [session|workspace]");
          return true;
        }
        gatewayClient.send({
          type: "usage_query",
          sessionId: binding.sessionId,
          action: "recent",
          ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
          ...(scope ? { scope } : {}),
        });
        return true;
      }

      if (sub === "search") {
        const maybeScope = parseUsageScope(parts.slice(-1)[0]);
        if (maybeScope === "hybrid") {
          await sendToConversation(message.adapterId, message.conversationId, "Usage: /usage search <query> [session|workspace]");
          return true;
        }
        const consumedScope = maybeScope ? parts.slice(-1)[0] : undefined;
        const queryParts = consumedScope ? parts.slice(1, -1) : parts.slice(1);
        const query = queryParts.join(" ").trim();
        if (!query) {
          await sendToConversation(message.adapterId, message.conversationId, "Usage: /usage search <query> [session|workspace]");
          return true;
        }
        gatewayClient.send({
          type: "usage_query",
          sessionId: binding.sessionId,
          action: "search",
          query,
          ...(maybeScope ? { scope: maybeScope } : {}),
        });
        return true;
      }

      if (sub === "context") {
        const maybeScope = parseUsageScope(parts.slice(-1)[0]);
        const promptParts = maybeScope ? parts.slice(1, -1) : parts.slice(1);
        const prompt = promptParts.join(" ").trim();
        gatewayClient.send({
          type: "usage_query",
          sessionId: binding.sessionId,
          action: "context",
          ...(prompt ? { prompt } : {}),
          ...(maybeScope ? { scope: maybeScope } : {}),
        });
        return true;
      }

      if (sub === "clear") {
        const scope = parseUsageScope(parts[1]);
        if (parts[1] && (!scope || scope === "hybrid")) {
          await sendToConversation(message.adapterId, message.conversationId, "Usage: /usage clear [session|workspace]");
          return true;
        }
        gatewayClient.send({
          type: "usage_query",
          sessionId: binding.sessionId,
          action: "clear",
          ...(scope ? { scope } : {}),
        });
        return true;
      }

      await sendToConversation(
        message.adapterId,
        message.conversationId,
        "Usage: /usage [summary|stats|recent|search|context|clear] ...",
      );
      return true;
    }

    if (command === "cancel") {
      if (!binding) {
        await sendToConversation(message.adapterId, message.conversationId, "No active session to cancel.");
        return true;
      }
      gatewayClient.send({ type: "cancel", sessionId: binding.sessionId });
      cancelRequested.add(binding.sessionId);
      await sendToConversation(message.adapterId, message.conversationId, "Cancelled current turn.");
      return true;
    }

    if (command === "approve") {
      if (!binding) {
        await sendToConversation(message.adapterId, message.conversationId, "No active session.");
        return true;
      }
      const arg = parts[0]?.trim().toLowerCase();
      const approvalsForSession = listPendingApprovalsForSession(binding.sessionId);
      if (arg === "all") {
        for (const approval of approvalsForSession) {
          if (approval.allowOptionId) {
            gatewayClient.send({
              type: "approval_response",
              requestId: approval.requestId,
              optionId: approval.allowOptionId,
            });
          } else {
            gatewayClient.send({ type: "approval_response", requestId: approval.requestId, allow: true });
          }
          pendingApprovalsById.delete(approval.requestId);
        }
        await sendToConversation(message.adapterId, message.conversationId, `Approved ${approvalsForSession.length} request(s).`);
        return true;
      }
      const requestId = parts[0]?.trim();
      if (!requestId) {
        await sendToConversation(message.adapterId, message.conversationId, "Usage: /approve <requestId|all>");
        return true;
      }
      const pending = pendingApprovalsById.get(requestId);
      if (!pending) {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `No pending approval request: ${requestId}`,
        );
        return true;
      }
      if (pending.sessionId !== binding.sessionId) {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Approval request belongs to another session: ${requestId}`,
        );
        return true;
      }
      if (pending.allowOptionId) {
        gatewayClient.send({
          type: "approval_response",
          requestId,
          optionId: pending.allowOptionId,
        });
      } else {
        gatewayClient.send({ type: "approval_response", requestId, allow: true });
      }
      pendingApprovalsById.delete(requestId);
      const remaining = listPendingApprovalsForSession(binding.sessionId).length;
      if (remaining > 0) {
        await maybeSendNextApprovalPrompt(binding.sessionId);
      } else {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Approved ${compactApprovalTool(pending.tool)}.`,
        );
      }
      return true;
    }

    if (command === "deny" || command === "reject") {
      if (!binding) {
        await sendToConversation(message.adapterId, message.conversationId, "No active session.");
        return true;
      }
      const requestId = parts[0]?.trim();
      if (!requestId) {
        await sendToConversation(message.adapterId, message.conversationId, "Usage: /deny <requestId>");
        return true;
      }
      const pending = pendingApprovalsById.get(requestId);
      if (!pending) {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `No pending approval request: ${requestId}`,
        );
        return true;
      }
      if (pending.sessionId !== binding.sessionId) {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Approval request belongs to another session: ${requestId}`,
        );
        return true;
      }
      if (pending.rejectOptionId) {
        gatewayClient.send({
          type: "approval_response",
          requestId,
          optionId: pending.rejectOptionId,
        });
      } else {
        gatewayClient.send({ type: "approval_response", requestId, allow: false });
      }
      pendingApprovalsById.delete(requestId);
      const remaining = listPendingApprovalsForSession(binding.sessionId).length;
      if (remaining > 0) {
        await maybeSendNextApprovalPrompt(binding.sessionId);
      } else {
        await sendToConversation(
          message.adapterId,
          message.conversationId,
          `Denied ${compactApprovalTool(pending.tool)}.`,
        );
      }
      return true;
    }

    return false;
  };

  const flushStreamBuffer = async (sessionId: string, done: boolean): Promise<void> => {
    const rawText = streamBuffers.get(sessionId) ?? "";
    const text = rawText.trim();
    const binding = resolveBindingBySession(sessionId);
    if (!binding) {
      if (done) streamBuffers.delete(sessionId);
      return;
    }

    if (binding.streamingMode === "edit") {
      const adapter = adapterById.get(binding.adapterId);
      if (adapter?.upsertStreamingMessage) {
        if (text || done) {
          await adapter.upsertStreamingMessage({
            conversationId: binding.conversationId,
            streamId: sessionId,
            text,
            done,
          });
        }
        if (done) {
          streamBuffers.delete(sessionId);
        }
        return;
      }
    }

    if (done) {
      streamBuffers.delete(sessionId);
      if (!text) return;
      await sendToConversation(binding.adapterId, binding.conversationId, text);
    }
  };

  const flushStreamBufferQueued = (sessionId: string, done: boolean): Promise<void> => {
    const previous = streamFlushInFlight.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => flushStreamBuffer(sessionId, done));
    streamFlushInFlight.set(sessionId, next);
    return next.finally(() => {
      if (streamFlushInFlight.get(sessionId) === next) {
        streamFlushInFlight.delete(sessionId);
      }
    });
  };

  const scheduleStreamFlush = (sessionId: string): void => {
    if (streamFlushTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      streamFlushTimers.delete(sessionId);
      void flushStreamBufferQueued(sessionId, false).catch((error) => {
        logger.warn("channel_stream_flush_failed", {
          sessionId,
          error: formatChannelError(error),
        });
      });
    }, STREAM_EDIT_FLUSH_MS);
    timer.unref?.();
    streamFlushTimers.set(sessionId, timer);
  };

  const handleGatewayEvent = async (event: GatewayEvent): Promise<void> => {
    switch (event.type) {
      case "auth_challenge": {
        latestAuthChallenge = event;
        resolveAuthChallengeWaiters(event);
        break;
      }
      case "auth_result": {
        if (event.ok && event.principalType && event.principalId) {
          activeAuthPrincipal = {
            principalType: event.principalType,
            principalId: event.principalId,
          };
        }
        pushAuthResult(event);
        break;
      }
      case "session_created": {
        sessionMetadataById.set(event.sessionId, {
          runtimeId: event.runtimeId ?? "default",
          model: event.model,
          workspaceId: event.workspaceId ?? "default",
        });
        const conversationKey = sessionToConversation.get(event.sessionId);
        if (conversationKey) {
          const binding = conversationBindings.get(conversationKey);
          if (binding) {
            binding.runtimeId = event.runtimeId ?? binding.runtimeId ?? "default";
            binding.model = event.model ?? binding.model;
            binding.workspaceId = event.workspaceId ?? binding.workspaceId ?? "default";
            conversationBindings.set(conversationKey, binding);
            persistConversationBinding(binding);
          }
        }
        if (pendingSessionCreate) {
          const resolver = pendingSessionCreate;
          pendingSessionCreate = null;
          clearTimeout(resolver.timeout);
          resolver.resolve(event.sessionId);
        }
        break;
      }
      case "text_delta": {
        startTyping(event.sessionId);
        const current = streamBuffers.get(event.sessionId) ?? "";
        streamBuffers.set(event.sessionId, `${current}${event.delta}`);
        const binding = resolveBindingBySession(event.sessionId);
        if (binding?.streamingMode === "edit") {
          scheduleStreamFlush(event.sessionId);
        }
        break;
      }
      case "turn_end": {
        clearStreamFlushTimer(event.sessionId);
        await flushStreamBufferQueued(event.sessionId, true);
        pendingPrompts.delete(event.sessionId);
        stopTyping(event.sessionId);
        runningTurns.delete(event.sessionId);
        cancelRequested.delete(event.sessionId);
        const queuedSteer = queuedSteers.get(event.sessionId);
        if (queuedSteer) {
          queuedSteers.delete(event.sessionId);
          await sendPromptForSession(event.sessionId, queuedSteer, 0);
        }
        break;
      }
      case "approval_request": {
        const conversationKey = sessionToConversation.get(event.sessionId);
        if (!conversationKey) return;
        const binding = conversationBindings.get(conversationKey);
        if (!binding) return;
        const pendingBefore = listPendingApprovalsForSession(event.sessionId).length;
        pendingApprovalsById.set(event.requestId, {
          sessionId: event.sessionId,
          requestId: event.requestId,
          tool: event.tool,
          adapterId: binding.adapterId,
          conversationId: binding.conversationId,
          allowOptionId: event.options?.find((opt) => opt.kind.startsWith("allow"))?.optionId,
          rejectOptionId: event.options?.find((opt) => opt.kind.startsWith("reject"))?.optionId,
        });
        if (pendingBefore === 0) {
          const pending = pendingApprovalsById.get(event.requestId);
          if (pending) {
            await sendApprovalPrompt(pending, 1);
          }
        }
        stopTyping(event.sessionId);
        break;
      }
      case "session_transfer_requested": {
        const pendingTransfer = toPendingTransfer(event);
        if (!pendingTransfer) break;
        pendingTransfersBySession.set(event.sessionId, pendingTransfer);
        const bindings = Array.from(conversationBindings.values()).filter((binding) => (
          binding.principalType === event.targetPrincipalType
          && binding.principalId === event.targetPrincipalId
        ));
        for (const binding of bindings) {
          const adapter = adapterById.get(binding.adapterId);
          const supportsQuickActions = adapter?.supportsQuickActions === true;
          const quickActions: ChannelQuickAction[] | undefined = supportsQuickActions
            ? [
                { label: "Accept", command: `/session transfer accept ${event.sessionId}` },
                { label: "Dismiss", command: `/session transfer dismiss ${event.sessionId}` },
              ]
            : undefined;
          const text = supportsQuickActions
            ? [
                "Session transfer request received.",
                `session=${event.sessionId}`,
                `from=${formatPrincipalDisplay(event.fromPrincipalType, event.fromPrincipalId)}`,
              ].join("\n")
            : [
                "Session transfer request received.",
                `session=${event.sessionId}`,
                `from=${formatPrincipalDisplay(event.fromPrincipalType, event.fromPrincipalId)}`,
                `Use /session transfer accept ${event.sessionId} or /session transfer dismiss ${event.sessionId}`,
              ].join("\n");
          await sendToConversation(binding.adapterId, binding.conversationId, text, quickActions);
        }
        break;
      }
      case "session_transfer_updated": {
        if (event.state === "requested") {
          const pendingTransfer = toPendingTransfer(event);
          if (!pendingTransfer) break;
          pendingTransfersBySession.set(event.sessionId, pendingTransfer);
          break;
        }

        pendingTransfersBySession.delete(event.sessionId);
        const fallback = transferCommandRoutes.get(event.sessionId);
        if (fallback) {
          const stateLabel = event.state.replace(/_/g, " ");
          const reasonSuffix = event.reason ? ` (${event.reason.replace(/_/g, " ")})` : "";
          const resumeHint = event.state === "dismissed" || event.state === "expired"
            ? ` Use /session resume ${event.sessionId}.`
            : "";
          await sendToConversation(
            fallback.adapterId,
            fallback.conversationId,
            `Transfer update for session ${event.sessionId}: ${stateLabel}${reasonSuffix}.${resumeHint}`,
          );
          transferCommandRoutes.delete(event.sessionId);
        }
        break;
      }
      case "session_transferred": {
        pendingTransfersBySession.delete(event.sessionId);
        transferCommandRoutes.delete(event.sessionId);

        const fromBindings = Array.from(conversationBindings.values()).filter((binding) => (
          binding.principalType === event.fromPrincipalType
          && binding.principalId === event.fromPrincipalId
        ));
        const targetBindings = Array.from(conversationBindings.values()).filter((binding) => (
          binding.principalType === event.targetPrincipalType
          && binding.principalId === event.targetPrincipalId
        ));
        const targetKeys = new Set(
          targetBindings.map((binding) => conversationKeyOf(binding.adapterId, binding.conversationId)),
        );

        for (const binding of fromBindings) {
          const fromKey = conversationKeyOf(binding.adapterId, binding.conversationId);
          if (targetKeys.has(fromKey)) continue;
          if (binding.sessionId !== event.sessionId) continue;
          conversationBindings.delete(fromKey);
          if (sessionToConversation.get(event.sessionId) === fromKey) {
            sessionToConversation.delete(event.sessionId);
          }
          try {
            bindingStore?.deleteChannelBinding(binding.adapterId, binding.conversationId);
          } catch (error) {
            logger.warn("channel_binding_delete_failed", {
              adapterId: binding.adapterId,
              conversationId: binding.conversationId,
              sessionId: event.sessionId,
              error: formatChannelError(error),
            });
          }
        }

        for (const binding of fromBindings) {
          await sendToConversation(
            binding.adapterId,
            binding.conversationId,
            formatSessionBoundary("Session transferred away", [
              `session=${event.sessionId}`,
              `to=${formatPrincipalDisplay(event.targetPrincipalType, event.targetPrincipalId)}`,
              "This conversation no longer owns that session.",
            ]),
          );
        }

        const replacedByConversationKey = new Map<string, string | undefined>();
        if (targetBindings.length > 0) {
          const targetBinding = targetBindings[0];
          const targetKey = conversationKeyOf(targetBinding.adapterId, targetBinding.conversationId);
          const replacedSessionId = targetBinding.sessionId;
          replacedByConversationKey.set(targetKey, replacedSessionId);
          if (
            replacedSessionId
            && replacedSessionId !== event.sessionId
            && sessionToConversation.get(replacedSessionId) === targetKey
          ) {
            sessionToConversation.delete(replacedSessionId);
          }
          const previousConversationKey = sessionToConversation.get(event.sessionId);
          if (previousConversationKey && previousConversationKey !== targetKey) {
            const previousBinding = conversationBindings.get(previousConversationKey);
            if (previousBinding?.sessionId === event.sessionId) {
              conversationBindings.delete(previousConversationKey);
            }
          }
          targetBinding.sessionId = event.sessionId;
          const metadata = sessionMetadataById.get(event.sessionId);
          if (metadata) {
            targetBinding.runtimeId = metadata.runtimeId ?? targetBinding.runtimeId;
            targetBinding.model = metadata.model ?? targetBinding.model;
            targetBinding.workspaceId = metadata.workspaceId ?? targetBinding.workspaceId;
          }
          conversationBindings.set(targetKey, targetBinding);
          sessionToConversation.set(event.sessionId, targetKey);
          persistConversationBinding(targetBinding);
        }

        for (const binding of targetBindings) {
          const targetKey = conversationKeyOf(binding.adapterId, binding.conversationId);
          const replacedSessionId = replacedByConversationKey.get(targetKey) ?? binding.sessionId;
          await sendToConversation(
            binding.adapterId,
            binding.conversationId,
            formatSessionBoundary("Session attached to this conversation", [
              ...(replacedSessionId && replacedSessionId !== event.sessionId ? [`previous=${replacedSessionId}`] : []),
              `current=${event.sessionId}`,
              `from=${formatPrincipalDisplay(event.fromPrincipalType, event.fromPrincipalId)}`,
            ]),
          );
        }
        break;
      }
      case "session_list": {
        for (const session of event.sessions) {
          sessionInfoById.set(session.id, session);
        }
        const pending = pendingSessionListRequests.shift();
        if (!pending) break;
        if (pending.kind === "probe") {
          clearTimeout(pending.timeout);
          pending.resolve(event.sessions);
          break;
        }
        const conversationKey = conversationKeyOf(pending.adapterId, pending.conversationId);
        sessionListStateByConversation.set(conversationKey, {
          principalType: pending.principalType,
          principalId: pending.principalId,
          limit: pending.limit,
          hasMore: event.hasMore ?? false,
          ...(event.nextCursor ? { nextCursor: event.nextCursor } : {}),
        });
        const visibleSessions = event.sessions.filter((session) => (
          (session.principalType ?? "user") === pending.principalType
          && (session.principalId ?? "user:local") === pending.principalId
        ));
        await sendToConversation(
          pending.adapterId,
          pending.conversationId,
          formatSessionList(visibleSessions, pending.limit, pending.activeSessionId, event.hasMore ?? false),
        );
        break;
      }
      case "session_lifecycle_result": {
        const pendingIndex = pendingSessionLifecycleRequests.findIndex((entry) => entry.sessionId === event.sessionId);
        if (pendingIndex < 0) break;
        const [pending] = pendingSessionLifecycleRequests.splice(pendingIndex, 1);
        if (!pending) break;
        await sendToConversation(
          pending.adapterId,
          pending.conversationId,
          formatSessionLifecycleHistory(event.sessionId, event.events),
        );
        break;
      }
      case "transcript": {
        const pending = clearPendingSessionResume(event.sessionId);
        if (!pending) break;
        const info = sessionInfoById.get(event.sessionId);
        if (info) {
          const previous = sessionMetadataById.get(event.sessionId);
          sessionMetadataById.set(event.sessionId, {
            runtimeId: previous?.runtimeId,
            model: info.model,
            workspaceId: info.workspaceId,
          });
        }
        const rebound = rebindConversationToSession(
          pending.adapterId,
          pending.conversationId,
          event.sessionId,
          pending.principalType,
          pending.principalId,
          sessionMetadataById.get(event.sessionId),
        );
        if (!pending.silent) {
          await sendToConversation(
            pending.adapterId,
            pending.conversationId,
            formatSessionBoundary("Session resumed", [
              ...(pending.previousSessionId && pending.previousSessionId !== event.sessionId
                ? [`previous=${pending.previousSessionId}`]
                : []),
              `current=${event.sessionId}`,
              `runtime=${rebound.runtimeId ?? "default"}`,
              `model=${rebound.model ?? "runtime-default"}`,
              `workspace=${rebound.workspaceId ?? "default"}`,
              `transcript_messages=${event.messages.length}`,
            ]),
          );
        }
        pending.resolve?.(event.sessionId);
        break;
      }
      case "usage_result":
      case "memory_result": {
        const binding = resolveBindingBySession(event.sessionId);
        if (!binding) return;
        await sendToConversation(
          binding.adapterId,
          binding.conversationId,
          formatUsageResult(event),
        );
        break;
      }
      case "session_invalidated": {
        clearStreamFlushTimer(event.sessionId);
        await flushStreamBufferQueued(event.sessionId, true);
        const pending = pendingPrompts.get(event.sessionId);
        pendingPrompts.delete(event.sessionId);
        stopTyping(event.sessionId);
        runningTurns.delete(event.sessionId);
        cancelRequested.delete(event.sessionId);
        queuedSteers.delete(event.sessionId);
        const binding = resolveBindingBySession(event.sessionId);
        if (!binding) break;
        const conversationKey = conversationKeyOf(binding.adapterId, binding.conversationId);
        const hasQueuedReconnectPrompt = (queuedPromptsByConversation.get(conversationKey)?.length ?? 0) > 0;
        if (!hasQueuedReconnectPrompt) {
          await sendToConversation(
            binding.adapterId,
            binding.conversationId,
            formatSessionBoundary("Session runtime restarted", [
              `session=${event.sessionId}`,
              "Runtime context was reset. Transcript and memory are still available.",
            ]),
          );
        }
        if (pending && pending.retryCount < 1) {
          await sendToConversation(
            binding.adapterId,
            binding.conversationId,
            "Retrying your last message once after runtime restart...",
          );
          await sendPrompt(pending.message, pending.retryCount + 1);
        }
        break;
      }
      case "error": {
        if (!event.sessionId) return;
        const conversationKey = sessionToConversation.get(event.sessionId);
        let binding = conversationKey ? conversationBindings.get(conversationKey) : undefined;
        if (!binding) {
          const pendingResume = clearPendingSessionResume(event.sessionId);
          if (pendingResume) {
            const error = new Error(event.message);
            pendingResume.reject?.(error);
            if (!pendingResume.silent) {
              await sendToConversation(
                pendingResume.adapterId,
                pendingResume.conversationId,
                formatUserFacingError(event.message),
              );
            }
            return;
          }
          const fallback = transferCommandRoutes.get(event.sessionId);
          if (fallback) {
            await sendToConversation(
              fallback.adapterId,
              fallback.conversationId,
              formatUserFacingError(event.message),
            );
            transferCommandRoutes.delete(event.sessionId);
          }
          return;
        }
        if (isSessionNotFoundMessage(event.message) || isSessionClosedMessage(event.message)) {
          const pending = pendingPrompts.get(event.sessionId);
          const sourceConversationId = binding.conversationId;
          const sourceAdapterId = binding.adapterId;
          clearSessionState(event.sessionId);
          if (pending && pending.retryCount < 1) {
            logger.warn("channel_prompt_retry_after_missing_session", {
              adapterId: sourceAdapterId,
              conversationId: sourceConversationId,
              missingSessionId: event.sessionId,
              retryCount: pending.retryCount + 1,
            });
            await sendToConversation(
              sourceAdapterId,
              sourceConversationId,
              "Session was reset on gateway. Retrying your last message once...",
            );
            await sendPrompt(pending.message, pending.retryCount + 1);
            return;
          }
        }
        pendingPrompts.delete(event.sessionId);
        stopTyping(event.sessionId);
        runningTurns.delete(event.sessionId);
        cancelRequested.delete(event.sessionId);
        await sendToConversation(binding.adapterId, binding.conversationId, formatUserFacingError(event.message));
        break;
      }
      case "session_closed": {
        clearSessionState(event.sessionId);
        break;
      }
      default:
        break;
    }
  };

  const scheduleReconnect = (): void => {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectGateway();
    }, Math.max(300, reconnectDelayMs));
  };

  const connectGateway = async (): Promise<void> => {
    try {
      await gatewayClient.connect();
      logger.info("channel_manager_gateway_connected", { gatewayUrl });
    } catch (error) {
      logger.warn("channel_manager_gateway_connect_failed", {
        gatewayUrl,
        error: formatChannelError(error),
      });
      scheduleReconnect();
    }
  };

  const handleInbound = async (message: ChannelInboundMessage): Promise<void> => {
    if (!running) return;
    if (!adapterById.has(message.adapterId)) {
      logger.warn("channel_message_unknown_adapter", { adapterId: message.adapterId });
      return;
    }

    try {
      const resolvedPrincipal = resolveInboundPrincipal(message);
      const handled = await handleCommand(message, resolvedPrincipal);
      if (!handled) {
        await sendPromptOrSteer(message);
      }
    } catch (error) {
      if (isGatewayDisconnectedError(error)) {
        const isCommand = message.text.trim().startsWith("/");
        if (!isCommand) {
          await queuePromptWhileDisconnected(message);
          return;
        }
        const key = conversationKeyOf(message.adapterId, message.conversationId);
        if (!reconnectNoticeByConversation.has(key)) {
          reconnectNoticeByConversation.add(key);
          await sendToConversation(
            message.adapterId,
            message.conversationId,
            "Nexus is reconnecting. Retry this command in a moment.",
          );
        }
        return;
      }
      logger.error("channel_inbound_failed", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        error: formatChannelError(error),
      });
      await sendToConversation(message.adapterId, message.conversationId, `Nexus bridge error: ${formatChannelError(error)}`)
        .catch(() => {
          // Ignore adapter send failure when already erroring.
        });
    }
  };

  const startAdapters = async (): Promise<void> => {
    if (startedAdapters) return;
    startedAdapters = true;
    for (const registration of adapters) {
      await registration.adapter.start({
        onMessage: handleInbound,
        log: logger,
      });
      logger.info("channel_adapter_started", {
        adapterId: registration.adapter.id,
      });
    }
  };

  const stopAdapters = async (): Promise<void> => {
    if (!startedAdapters) return;
    startedAdapters = false;
    for (const registration of adapters) {
      try {
        await registration.adapter.stop();
      } catch (error) {
        logger.warn("channel_adapter_stop_failed", {
          adapterId: registration.adapter.id,
          error: formatChannelError(error),
        });
      }
    }
  };

  gatewayClient.onEvent((event) => {
    void handleGatewayEvent(event).catch((error) => {
      logger.error("channel_gateway_event_failed", {
        eventType: event.type,
        error: formatChannelError(error),
      });
    });
  });

  gatewayClient.onOpen(() => {
    logger.info("channel_gateway_open");
    void flushQueuedPrompts().catch((error) => {
      logger.warn("channel_flush_queued_prompts_failed", {
        error: formatChannelError(error),
      });
    });
  });

  gatewayClient.onClose(() => {
    logger.warn("channel_gateway_closed");
    while (pendingSessionListRequests.length > 0) {
      const pending = pendingSessionListRequests.shift();
      if (pending?.kind === "probe") {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Gateway connection closed before session list probe completed."));
      }
    }
    pendingSessionLifecycleRequests.length = 0;
    sessionListStateByConversation.clear();
    for (const [sessionId] of pendingSessionResumeBySession) {
      clearPendingSessionResume(sessionId, new Error("Gateway connection closed before session replay completed."));
    }
    for (const sessionId of Array.from(runningTurns)) {
      stopTyping(sessionId);
    }
    runningTurns.clear();
    cancelRequested.clear();
    queuedSteers.clear();
    latestAuthChallenge = null;
    activeAuthPrincipal = null;
    rejectAuthChallengeWaiters(new Error("Gateway connection closed before auth challenge."));
    rejectAuthResultWaiters(new Error("Gateway connection closed before auth result."));
    if (pendingSessionCreate) {
      pendingSessionCreate.reject(new Error("Gateway connection closed while creating session"));
      clearTimeout(pendingSessionCreate.timeout);
      pendingSessionCreate = null;
    }
    scheduleReconnect();
  });

  gatewayClient.onError((error) => {
    logger.warn("channel_gateway_error", {
      error: error.message,
    });
  });

  return {
    start: async () => {
      if (running) return;
      running = true;
      await startAdapters();
      await connectGateway();
      logger.info("channel_manager_started", {
        adapterCount: adapters.length,
      });
    },
    stop: async () => {
      running = false;
      while (pendingSessionListRequests.length > 0) {
        const pending = pendingSessionListRequests.shift();
        if (pending?.kind === "probe") {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Channel manager stopped before session list probe completed."));
        }
      }
      pendingSessionLifecycleRequests.length = 0;
      sessionListStateByConversation.clear();
      for (const [sessionId] of pendingSessionResumeBySession) {
        clearPendingSessionResume(sessionId, new Error("Channel manager stopped before session replay completed."));
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      latestAuthChallenge = null;
      activeAuthPrincipal = null;
      rejectAuthChallengeWaiters(new Error("Channel manager stopped."));
      rejectAuthResultWaiters(new Error("Channel manager stopped."));
      if (pendingSessionCreate) {
        pendingSessionCreate.reject(new Error("Channel manager stopped"));
        clearTimeout(pendingSessionCreate.timeout);
        pendingSessionCreate = null;
      }
      for (const timer of typingTimers.values()) {
        clearInterval(timer);
      }
      typingTimers.clear();
      for (const timer of streamFlushTimers.values()) {
        clearTimeout(timer);
      }
      streamFlushTimers.clear();
      gatewayClient.close();
      await stopAdapters();
      logger.info("channel_manager_stopped");
    },
  };
};
