import type {
  AuthAlgorithm,
  ClientMessage,
  ExecutionState,
  EventCorrelation,
  GatewayEvent,
  PolicyConfig,
  PrincipalType,
  PromptSource,
  RuntimeHealthInfo,
  RuntimeHealthStatus,
  SessionLifecycleEventType,
  SessionLifecycleState,
  UsageSummary,
} from "@nexus/types";
import { estimateTokens } from "@nexus/types";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { SessionTransferRecord, StateStore } from "@nexus/state";
import type { AcpSession } from "@nexus/acp-bridge";
import type { MemoryProvider } from "@nexus/memory";
import { createLogger } from "./logger.js";

export type EventEmitter = (event: GatewayEvent) => void;

export interface ManagedAcpSession extends AcpSession {
  runtimeId: string;
  model: string;
  modelRouting?: Record<string, string>;
  modelAliases?: Record<string, string>;
  modelCatalog?: Record<string, string[]>;
  runtimeDefaults?: Record<string, string>;
}

export interface SessionPolicyContext {
  principalType: PrincipalType;
  principalId: string;
  source: PromptSource;
  workspaceId: string;
}

export interface RouterDeps {
  createAcpSession: (
    runtimeId: string | undefined,
    model: string | undefined,
    onEvent: EventEmitter,
    policyContext?: SessionPolicyContext,
    options?: {
      gatewaySessionId?: string;
    },
  ) => Promise<ManagedAcpSession>;
  stateStore: StateStore;
  policyConfig: PolicyConfig;
  memoryProvider?: MemoryProvider;
  defaultWorkspaceId?: string;
  sessionIdleTimeoutMs?: number;
  initialRuntimeHealth?: Record<string, RuntimeHealthInfo>;
}

export interface RouterMessageContext {
  connectionId?: string;
}

export interface Router {
  handleMessage: (msg: ClientMessage, emit: EventEmitter, context?: RouterMessageContext) => void;
  registerConnection: (connectionId: string, emit: EventEmitter) => void;
  unregisterConnection: (connectionId: string, emit: EventEmitter) => void;
  setRuntimeHealth: (runtimeId: string, status: RuntimeHealthStatus, reason?: string) => RuntimeHealthInfo;
  getRuntimeHealth: () => RuntimeHealthInfo[];
  closeSessionsByRuntime: (runtimeId: string, reason?: string) => string[];
  sweepIdleSessions: (now?: Date) => string[];
}

interface ConnectionPrincipal {
  principalType: PrincipalType;
  principalId: string;
  verified: boolean;
  publicKey?: string;
  verifiedAt?: string;
}

interface AuthChallenge {
  id: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  algorithm: AuthAlgorithm;
}

interface SessionTransferRequest {
  sessionId: string;
  requesterConnectionId?: string;
  fromPrincipalType: PrincipalType;
  fromPrincipalId: string;
  targetPrincipalType: PrincipalType;
  targetPrincipalId: string;
  expiresAtMs: number;
  state: "requested" | "expired";
  createdAtMs: number;
  updatedAtMs: number;
}

interface ActivePromptTurn {
  executionId: string;
  emit: EventEmitter;
}

const AUTH_CHALLENGE_TTL_MS = 60_000;
const TRANSFER_MIN_TTL_MS = 5_000;
const TRANSFER_MAX_TTL_MS = 10 * 60 * 1000;
const TRANSFER_DEFAULT_TTL_MS = 60_000;
const CONSUMED_AUTH_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_LIST_LIMIT = 20;
const MAX_SESSION_LIST_LIMIT = 100;

const normalizePublicKey = (publicKey: string): string => {
  const trimmed = publicKey.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    return trimmed;
  }
  const raw = trimmed.replace(/\s+/g, "");
  const lines = raw.match(/.{1,64}/g)?.join("\n") ?? raw;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
};

const decodeSignature = (signature: string): Buffer | null => {
  try {
    return Buffer.from(signature, "base64");
  } catch {
    // fall through
  }
  try {
    const normalized = signature.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(`${normalized}${padding}`, "base64");
  } catch {
    return null;
  }
};

const buildAuthPayload = (
  challengeId: string,
  nonce: string,
  principalType: PrincipalType,
  principalId: string,
): string => `${challengeId}:${nonce}:${principalType}:${principalId}`;

const verifyAuthProof = (
  challengeId: string,
  nonce: string,
  principalType: PrincipalType,
  principalId: string,
  publicKey: string,
  signature: string,
): boolean => {
  try {
    const key = createPublicKey(normalizePublicKey(publicKey));
    const payload = Buffer.from(buildAuthPayload(challengeId, nonce, principalType, principalId), "utf8");
    const signatureBytes = decodeSignature(signature);
    if (!signatureBytes) return false;
    return verify(null, payload, key, signatureBytes);
  } catch {
    return false;
  }
};

const mapStopReasonToExecutionState = (stopReason: string | undefined): ExecutionState => {
  const normalized = (stopReason ?? "").toLowerCase();
  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancelled";
  }
  if (
    normalized === "timed_out"
    || normalized === "timeout"
    || normalized === "time_limit"
    || normalized === "max_duration"
  ) {
    return "timed_out";
  }
  return "succeeded";
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[unserializable:${error instanceof Error ? error.message : String(error)}]`;
  }
};

const emitSessionOwnershipError = (
  emit: EventEmitter,
  sessionId: string,
): void => {
  emit({
    type: "error",
    sessionId,
    message: "Session is owned by another connection",
  });
};

type EnsureSessionOwnerResult = "ok" | "owned_by_other" | "claim_denied";

const ensureSessionOwner = (
  sessionOwners: Map<string, EventEmitter>,
  sessionId: string,
  emit: EventEmitter,
  options?: {
    canClaimWhenUnowned?: boolean;
  },
): EnsureSessionOwnerResult => {
  const owner = sessionOwners.get(sessionId);
  if (!owner) {
    if (options?.canClaimWhenUnowned === false) {
      return "claim_denied";
    }
    sessionOwners.set(sessionId, emit);
    return "ok";
  }
  return owner === emit ? "ok" : "owned_by_other";
};

/**
 * Wraps an event emitter to record streaming events into the transcript store.
 * Accumulates text_delta chunks and flushes a single assistant message at turn_end.
 */
export const createRecordingEmitter = (
  workspaceId: string,
  sessionId: string,
  stateStore: StateStore,
  downstream: EventEmitter,
  options?: {
    onTextDelta?: () => void;
    onApprovalRequest?: (requestId: string) => void;
    onAssistantMessage?: (assistantText: string) => void;
    onAnyEvent?: (event: GatewayEvent) => void;
  },
): EventEmitter => {
  let assistantBuffer = "";

  return (event: GatewayEvent) => {
    options?.onAnyEvent?.(event);
    switch (event.type) {
      case "text_delta":
        assistantBuffer += event.delta;
        options?.onTextDelta?.();
        break;
      case "tool_start":
        {
          const content = safeStringify(event.params);
          stateStore.appendMessage({
            workspaceId,
            sessionId,
            role: "tool",
            content,
            toolName: event.tool,
            toolCallId: event.toolCallId,
            timestamp: new Date().toISOString(),
            tokenEstimate: estimateTokens(content),
          });
        }
        break;
      case "tool_end":
        stateStore.appendMessage({
          workspaceId,
          sessionId,
          role: "tool",
          content: event.result ?? "",
          toolName: event.tool,
          toolCallId: event.toolCallId,
          timestamp: new Date().toISOString(),
          tokenEstimate: estimateTokens(event.result ?? ""),
        });
        break;
      case "approval_request":
        options?.onApprovalRequest?.(event.requestId);
        break;
      case "turn_end":
        if (assistantBuffer) {
          options?.onAssistantMessage?.(assistantBuffer);
          stateStore.appendMessage({
            workspaceId,
            sessionId,
            role: "assistant",
            content: assistantBuffer,
            timestamp: new Date().toISOString(),
            tokenEstimate: estimateTokens(assistantBuffer),
          });
          assistantBuffer = "";
        }
        break;
    }
    downstream(event);
  };
};

export const createRouter = (deps: RouterDeps): Router => {
  const {
    createAcpSession,
    stateStore,
    policyConfig,
    memoryProvider,
    defaultWorkspaceId = "default",
    sessionIdleTimeoutMs = 30 * 60 * 1000,
    initialRuntimeHealth = {},
  } = deps;
  const idleTimeoutMs = Math.max(1_000, sessionIdleTimeoutMs);
  const policySnapshotId = createHash("sha256")
    .update(safeStringify(policyConfig))
    .digest("hex")
    .slice(0, 16);
  const sessions = new Map<string, ManagedAcpSession>();
  const sessionWorkspaces = new Map<string, string>();
  const sessionPrincipals = new Map<string, {
    principalType: PrincipalType;
    principalId: string;
    source: PromptSource;
  }>();
  const sessionPolicyContexts = new Map<string, SessionPolicyContext>();
  const sessionLastActivityMs = new Map<string, number>();
  const sessionInFlightTurns = new Map<string, number>();
  const sessionOwners = new Map<string, EventEmitter>();
  const requestToSession = new Map<string, {
    sessionId: string;
    turnId?: string;
    executionId?: string;
    parentExecutionId?: string;
    policySnapshotId?: string;
  }>();
  const sessionIdempotency = new Map<string, Map<string, {
    state: "running" | "completed";
    turnId: string;
    executionId: string;
    parentExecutionId?: string;
    completedAtMs?: number;
  }>>();
  const pendingSessionHydrations = new Map<string, Promise<boolean>>();
  const sessionToPendingRequests = new Map<string, Set<string>>();
  const sessionActivePromptTurns = new Map<string, ActivePromptTurn[]>();
  const activeConnections = new Map<string, EventEmitter>();
  const emitterConnectionIds = new WeakMap<EventEmitter, string>();
  const connectionPrincipals = new Map<string, ConnectionPrincipal>();
  const authChallenges = new Map<string, AuthChallenge>();
  const consumedAuthChallenges = new Map<string, number>();
  const sessionTransfers = new Map<string, SessionTransferRequest>();
  const runtimeHealth = new Map<string, RuntimeHealthInfo>(Object.entries(initialRuntimeHealth));
  const log = createLogger("gateway.router");

  const toPersistedTransfer = (
    transfer: SessionTransferRequest,
  ): SessionTransferRecord => ({
    sessionId: transfer.sessionId,
    fromPrincipalType: transfer.fromPrincipalType,
    fromPrincipalId: transfer.fromPrincipalId,
    targetPrincipalType: transfer.targetPrincipalType,
    targetPrincipalId: transfer.targetPrincipalId,
    expiresAt: new Date(transfer.expiresAtMs).toISOString(),
    state: transfer.state,
    createdAt: new Date(transfer.createdAtMs).toISOString(),
    updatedAt: new Date(transfer.updatedAtMs).toISOString(),
  });

  const persistTransfer = (transfer: SessionTransferRequest): void => {
    stateStore.upsertSessionTransfer(toPersistedTransfer(transfer));
    sessionTransfers.set(transfer.sessionId, transfer);
  };

  const deleteTransfer = (sessionId: string): void => {
    sessionTransfers.delete(sessionId);
    stateStore.deleteSessionTransfer(sessionId);
  };

  for (const persistedTransfer of stateStore.listSessionTransfers()) {
    sessionTransfers.set(persistedTransfer.sessionId, {
      sessionId: persistedTransfer.sessionId,
      fromPrincipalType: persistedTransfer.fromPrincipalType,
      fromPrincipalId: persistedTransfer.fromPrincipalId,
      targetPrincipalType: persistedTransfer.targetPrincipalType,
      targetPrincipalId: persistedTransfer.targetPrincipalId,
      expiresAtMs: new Date(persistedTransfer.expiresAt).getTime(),
      state: persistedTransfer.state,
      createdAtMs: new Date(persistedTransfer.createdAt).getTime(),
      updatedAtMs: new Date(persistedTransfer.updatedAt).getTime(),
    });
  }

  const emitRuntimeHealth = (emit: EventEmitter, runtime: RuntimeHealthInfo): void => {
    emit({
      type: "runtime_health",
      runtime,
    });
  };

  const listRuntimeHealth = (): RuntimeHealthInfo[] =>
    Array.from(runtimeHealth.values()).sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));

  const broadcastRuntimeHealth = (runtime: RuntimeHealthInfo): void => {
    for (const emit of activeConnections.values()) {
      emitRuntimeHealth(emit, runtime);
    }
  };

  const resolvePrincipal = (connectionId?: string): ConnectionPrincipal | undefined => (
    connectionId ? connectionPrincipals.get(connectionId) : undefined
  );

  const resolveSessionPrincipal = (
    sessionId: string,
  ): { principalType: PrincipalType; principalId: string; source: PromptSource } | null => {
    const inMemory = sessionPrincipals.get(sessionId);
    if (inMemory) return inMemory;
    const persisted = stateStore.getSession(sessionId);
    if (!persisted) return null;
    return {
      principalType: persisted.principalType,
      principalId: persisted.principalId,
      source: persisted.source,
    };
  };

  const canConnectionClaimSession = (
    sessionId: string,
    connectionId?: string,
  ): boolean => {
    const sessionPrincipal = resolveSessionPrincipal(sessionId);
    if (!sessionPrincipal) return false;

    const connectionPrincipal = resolvePrincipal(connectionId);
    const isSessionLocalInteractive =
      sessionPrincipal.principalType === "user"
      && sessionPrincipal.principalId === "user:local"
      && sessionPrincipal.source === "interactive";

    if (!connectionPrincipal?.verified) {
      return isSessionLocalInteractive;
    }

    if (isSessionLocalInteractive) {
      return true;
    }

    return (
      connectionPrincipal.principalType === sessionPrincipal.principalType
      && connectionPrincipal.principalId === sessionPrincipal.principalId
    );
  };

  const ensureSessionOwnerForConnection = (
    sessionId: string,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): boolean => {
    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    const result = ensureSessionOwner(sessionOwners, sessionId, emit, {
      canClaimWhenUnowned: canConnectionClaimSession(sessionId, connectionId),
    });
    if (result === "ok") return true;
    if (result === "owned_by_other") {
      emitSessionOwnershipError(emit, sessionId);
      return false;
    }
    emit({
      type: "error",
      sessionId,
      message: "Authenticated principal does not own this session.",
    });
    return false;
  };

  const rebindLocalOwnedSessionsToPrincipal = (
    connectionId: string,
    principalType: PrincipalType,
    principalId: string,
  ): void => {
    const ownerEmit = activeConnections.get(connectionId);
    if (!ownerEmit) return;

    let reboundCount = 0;
    for (const [sessionId, owner] of sessionOwners.entries()) {
      if (owner !== ownerEmit) continue;
      const currentPrincipal = sessionPrincipals.get(sessionId);
      if (!currentPrincipal) continue;
      if (
        currentPrincipal.principalType !== "user"
        || currentPrincipal.principalId !== "user:local"
        || currentPrincipal.source !== "interactive"
      ) {
        continue;
      }

      sessionPrincipals.set(sessionId, {
        principalType,
        principalId,
        source: currentPrincipal.source,
      });
      const policyContext = sessionPolicyContexts.get(sessionId);
      if (policyContext) {
        sessionPolicyContexts.set(sessionId, {
          ...policyContext,
          principalType,
          principalId,
        });
      }
      try {
        stateStore.updateSession(sessionId, {
          principalType,
          principalId,
        });
      } catch {
        // Ignore state races for sessions that may have just been closed.
      }
      reboundCount += 1;
    }

    if (reboundCount > 0) {
      log.info("connection_sessions_rebound_to_authenticated_principal", {
        connectionId,
        principalType,
        principalId,
        sessionCount: reboundCount,
      });
    }
  };

  const rebindOwnedSessionPrincipalIfLocal = (
    sessionId: string,
    ownerEmit: EventEmitter,
    principalType: PrincipalType,
    principalId: string,
  ): boolean => {
    if (sessionOwners.get(sessionId) !== ownerEmit) return false;
    const currentPrincipal = sessionPrincipals.get(sessionId);
    if (!currentPrincipal) return false;
    if (
      currentPrincipal.principalType !== "user"
      || currentPrincipal.principalId !== "user:local"
      || currentPrincipal.source !== "interactive"
    ) {
      return false;
    }

    sessionPrincipals.set(sessionId, {
      principalType,
      principalId,
      source: currentPrincipal.source,
    });
    const policyContext = sessionPolicyContexts.get(sessionId);
    if (policyContext) {
      sessionPolicyContexts.set(sessionId, {
        ...policyContext,
        principalType,
        principalId,
      });
    }
    try {
      stateStore.updateSession(sessionId, {
        principalType,
        principalId,
      });
    } catch {
      // Ignore state races for sessions that may have just been closed.
    }
    return true;
  };

  const emitterOwnsSessionForPrincipal = (
    ownerEmit: EventEmitter,
    principalType: PrincipalType,
    principalId: string,
  ): boolean => (
    Array.from(sessionOwners.entries()).some(([sessionId, candidateOwner]) => {
      if (candidateOwner !== ownerEmit) return false;
      const principal = sessionPrincipals.get(sessionId);
      return principal?.principalType === principalType && principal.principalId === principalId;
    })
  );

  const emitTransferEventToParties = (
    transfer: SessionTransferRequest,
    event: GatewayEvent,
    preferredEmit?: EventEmitter,
  ): void => {
    const delivered = new Set<EventEmitter>();
    const emitOnce = (candidate?: EventEmitter): void => {
      if (!candidate || delivered.has(candidate)) return;
      candidate(event);
      delivered.add(candidate);
    };

    emitOnce(preferredEmit);
    emitOnce(sessionOwners.get(transfer.sessionId));

    for (const [connectionId, activeEmit] of activeConnections) {
      if (delivered.has(activeEmit)) continue;
      const principal = resolvePrincipal(connectionId);
      if (principal?.verified) {
        const isSourcePrincipal =
          principal.principalType === transfer.fromPrincipalType
          && principal.principalId === transfer.fromPrincipalId;
        const isTargetPrincipal =
          principal.principalType === transfer.targetPrincipalType
          && principal.principalId === transfer.targetPrincipalId;
        if (!isSourcePrincipal && !isTargetPrincipal) continue;
        emitOnce(activeEmit);
        continue;
      }

      if (
        emitterOwnsSessionForPrincipal(activeEmit, transfer.fromPrincipalType, transfer.fromPrincipalId)
        || emitterOwnsSessionForPrincipal(activeEmit, transfer.targetPrincipalType, transfer.targetPrincipalId)
      ) {
        emitOnce(activeEmit);
      }
    }
  };

  const emitTransferUpdated = (
    transfer: SessionTransferRequest,
    state: "requested" | "accepted" | "dismissed" | "expired" | "cancelled",
    preferredEmit?: EventEmitter,
    reason?: string,
  ): void => {
    const event: GatewayEvent = {
      type: "session_transfer_updated",
      sessionId: transfer.sessionId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType: transfer.targetPrincipalType,
      targetPrincipalId: transfer.targetPrincipalId,
      state,
      updatedAt: new Date().toISOString(),
      ...(state === "requested" || state === "expired" ? { expiresAt: new Date(transfer.expiresAtMs).toISOString() } : {}),
      ...(reason ? { reason } : {}),
    };
    emitTransferEventToParties(transfer, event, preferredEmit);
  };

  const setTransferExpired = (
    transfer: SessionTransferRequest,
    preferredEmit?: EventEmitter,
    reason = "expired",
  ): SessionTransferRequest => {
    if (transfer.state === "expired") {
      return transfer;
    }
    transfer.state = "expired";
    transfer.updatedAtMs = Date.now();
    persistTransfer(transfer);
    applyLifecycleEvent(transfer.sessionId, "TRANSFER_EXPIRED", {
      parkedReason: "transfer_expired",
      reason,
      actorPrincipalType: transfer.fromPrincipalType,
      actorPrincipalId: transfer.fromPrincipalId,
      ...(preferredEmit ? { notifyEmit: preferredEmit } : {}),
    });
    emitTransferUpdated(transfer, "expired", preferredEmit, reason);
    log.info("session_transfer_expired", {
      sessionId: transfer.sessionId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType: transfer.targetPrincipalType,
      targetPrincipalId: transfer.targetPrincipalId,
      reason,
    });
    return transfer;
  };

  const markTransferExpiredIfNeeded = (
    transfer: SessionTransferRequest,
    preferredEmit?: EventEmitter,
    reason = "expired",
  ): SessionTransferRequest => {
    if (Date.now() <= transfer.expiresAtMs) {
      return transfer;
    }
    return setTransferExpired(transfer, preferredEmit, reason);
  };

  const pruneConsumedAuthChallenges = (): void => {
    const nowMs = Date.now();
    for (const [key, expiresAtMs] of consumedAuthChallenges) {
      if (nowMs >= expiresAtMs) {
        consumedAuthChallenges.delete(key);
      }
    }
  };

  const issueAuthChallenge = (connectionId: string, emit: EventEmitter): AuthChallenge => {
    const issuedAtMs = Date.now();
    const challenge: AuthChallenge = {
      id: randomBytes(12).toString("base64url"),
      algorithm: "ed25519",
      nonce: randomBytes(24).toString("base64url"),
      issuedAtMs,
      expiresAtMs: issuedAtMs + AUTH_CHALLENGE_TTL_MS,
    };
    authChallenges.set(connectionId, challenge);
    emit({
      type: "auth_challenge",
      algorithm: challenge.algorithm,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      issuedAt: new Date(challenge.issuedAtMs).toISOString(),
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
    });
    return challenge;
  };

  const emitAuthChallenge = (challenge: AuthChallenge, emit: EventEmitter): void => {
    emit({
      type: "auth_challenge",
      algorithm: challenge.algorithm,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      issuedAt: new Date(challenge.issuedAtMs).toISOString(),
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
    });
  };

  const touchSession = (sessionId: string, timestamp = Date.now()): void => {
    sessionLastActivityMs.set(sessionId, timestamp);
    try {
      stateStore.updateSession(sessionId, {
        lastActivityAt: new Date(timestamp).toISOString(),
      });
    } catch {
      // Ignore sessions that were already cleaned up from state.
    }
  };

  const incrementSessionTokenUsage = (
    sessionId: string,
    inputDelta: number,
    outputDelta: number,
  ): void => {
    const normalizedInput = Math.max(0, Math.floor(inputDelta));
    const normalizedOutput = Math.max(0, Math.floor(outputDelta));
    if (normalizedInput === 0 && normalizedOutput === 0) return;
    stateStore.incrementSessionTokenUsage(sessionId, normalizedInput, normalizedOutput);
  };

  const applyLifecycleEvent = (
    sessionId: string,
    eventType: SessionLifecycleEventType,
    options?: {
      at?: string;
      reason?: string;
      parkedReason?: "transfer_pending" | "transfer_expired" | "runtime_timeout" | "owner_disconnected" | "manual";
      actorPrincipalType?: PrincipalType;
      actorPrincipalId?: string;
      metadata?: string;
      notifyEmit?: EventEmitter;
    },
  ): void => {
    try {
      const previous = stateStore.getSession(sessionId);
      const previousState: SessionLifecycleState = previous?.lifecycleState ?? (
        previous?.status === "active" ? "live" : "parked"
      );
      const updated = stateStore.applySessionLifecycleEvent(sessionId, {
        eventType,
        ...(options?.at ? { at: options.at } : {}),
        ...(options?.reason ? { reason: options.reason } : {}),
        ...(options?.parkedReason ? { parkedReason: options.parkedReason } : {}),
        ...(options?.actorPrincipalType ? { actorPrincipalType: options.actorPrincipalType } : {}),
        ...(options?.actorPrincipalId ? { actorPrincipalId: options.actorPrincipalId } : {}),
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      });
      const nextState: SessionLifecycleState = updated.lifecycleState ?? (
        updated.status === "active" ? "live" : "parked"
      );
      const lifecycleEvent: GatewayEvent = {
        type: "session_lifecycle",
        sessionId,
        eventType,
        fromState: previousState,
        toState: nextState,
        at: options?.at ?? updated.lifecycleUpdatedAt ?? new Date().toISOString(),
        ...(options?.reason ? { reason: options.reason } : {}),
        ...(updated.parkedReason ? { parkedReason: updated.parkedReason } : {}),
        ...(options?.actorPrincipalType ? { actorPrincipalType: options.actorPrincipalType } : {}),
        ...(options?.actorPrincipalId ? { actorPrincipalId: options.actorPrincipalId } : {}),
      };
      const targets = new Set<EventEmitter>();
      if (options?.notifyEmit) targets.add(options.notifyEmit);
      const owner = sessionOwners.get(sessionId);
      if (owner) targets.add(owner);
      for (const target of targets) {
        target(lifecycleEvent);
      }
    } catch (error) {
      log.warn("session_lifecycle_apply_failed", {
        sessionId,
        eventType,
        reason: options?.reason ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const hydrateSessionIfPersisted = (
    sessionId: string,
    emit: EventEmitter,
    context?: RouterMessageContext,
    options?: {
      allowTransferTarget?: boolean;
    },
  ): Promise<boolean> => {
    if (sessions.has(sessionId)) return Promise.resolve(true);
    const pending = pendingSessionHydrations.get(sessionId);
    if (pending) return pending;

    const hydration = (async (): Promise<boolean> => {
      const sessionRecord = stateStore.getSession(sessionId);
      if (!sessionRecord) {
        emit({
          type: "error",
          sessionId,
          message: `Session not found: ${sessionId}`,
        });
        return false;
      }
      if (sessionRecord.lifecycleState === "closed") {
        emit({
          type: "error",
          sessionId,
          message: "Session is closed and cannot be resumed. Start a new session.",
        });
        return false;
      }

      const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
      const connectionPrincipal = resolvePrincipal(connectionId);
      let principalType = sessionRecord.principalType;
      let principalId = sessionRecord.principalId;
      const source = sessionRecord.source;
      if (connectionPrincipal?.verified) {
        const isLocalInteractiveSession =
          sessionRecord.principalType === "user"
          && sessionRecord.principalId === "user:local"
          && sessionRecord.source === "interactive";
        if (isLocalInteractiveSession) {
          principalType = connectionPrincipal.principalType;
          principalId = connectionPrincipal.principalId;
        } else if (options?.allowTransferTarget) {
          const pendingTransfer = sessionTransfers.get(sessionId);
          const isTransferTarget =
            pendingTransfer
            && pendingTransfer.state === "requested"
            && connectionPrincipal.principalType === pendingTransfer.targetPrincipalType
            && connectionPrincipal.principalId === pendingTransfer.targetPrincipalId;
          if (!isTransferTarget) {
            emit({
              type: "error",
              sessionId,
              message: "Authenticated principal does not own this session.",
            });
            return false;
          }
        } else if (
          connectionPrincipal.principalType !== sessionRecord.principalType
          || connectionPrincipal.principalId !== sessionRecord.principalId
        ) {
          emit({
            type: "error",
            sessionId,
            message: "Authenticated principal does not own this session.",
          });
          return false;
        }
      }

      const workspaceId = sessionRecord.workspaceId || defaultWorkspaceId;
      const policyContext: SessionPolicyContext = {
        principalType,
        principalId,
        source,
        workspaceId,
      };

      try {
        const restored = await createAcpSession(
          sessionRecord.runtimeId,
          sessionRecord.model,
          emit,
          policyContext,
          { gatewaySessionId: sessionId },
        );
        sessions.set(sessionId, restored);
        bindSessionEventDispatcher(sessionId, restored);
        sessionWorkspaces.set(sessionId, workspaceId);
        sessionPrincipals.set(sessionId, {
          principalType,
          principalId,
          source,
        });
        sessionPolicyContexts.set(sessionId, policyContext);
        sessionLastActivityMs.set(sessionId, Date.now());
        stateStore.updateSession(sessionId, {
          runtimeId: restored.runtimeId,
          acpSessionId: restored.acpSessionId,
          model: restored.model,
          principalType,
          principalId,
          source,
          workspaceId,
        });
        emit({
          type: "session_invalidated",
          sessionId,
          reason: "runtime_state_lost",
          message: "Session runtime state was lost after restart and cold-restored. Replay transcript if needed.",
        });
        log.info("session_rehydrated", {
          connectionId: connectionId ?? null,
          sessionId,
          runtimeId: restored.runtimeId,
          model: restored.model,
          workspaceId,
          principalType,
          principalId,
          source,
        });
        return true;
      } catch (error) {
        log.error("session_rehydrate_failed", {
          connectionId: connectionId ?? null,
          sessionId,
          runtimeId: sessionRecord.runtimeId,
          model: sessionRecord.model,
          workspaceId,
          principalType,
          principalId,
          source,
          error: error instanceof Error ? error.message : String(error),
        });
        emit({
          type: "error",
          sessionId,
          message: `Failed to restore session: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
        return false;
      }
    })().finally(() => {
      pendingSessionHydrations.delete(sessionId);
    });

    pendingSessionHydrations.set(sessionId, hydration);
    return hydration;
  };

  const trackPendingApproval = (
    sessionId: string,
    requestId: string,
    turnId?: string,
    executionId?: string,
    parentExecutionId?: string,
    correlationPolicySnapshotId?: string,
  ): void => {
    requestToSession.set(requestId, {
      sessionId,
      turnId,
      executionId,
      parentExecutionId,
      policySnapshotId: correlationPolicySnapshotId,
    });
    const pending = sessionToPendingRequests.get(sessionId) ?? new Set<string>();
    pending.add(requestId);
    sessionToPendingRequests.set(sessionId, pending);
  };

  const clearPendingApproval = (sessionId: string, requestId: string): void => {
    requestToSession.delete(requestId);
    const pending = sessionToPendingRequests.get(sessionId);
    if (!pending) return;
    pending.delete(requestId);
    if (pending.size === 0) {
      sessionToPendingRequests.delete(sessionId);
    }
  };

  const clearSessionPendingApprovals = (sessionId: string): void => {
    const pending = sessionToPendingRequests.get(sessionId);
    if (!pending) return;
    for (const requestId of pending) {
      requestToSession.delete(requestId);
    }
    sessionToPendingRequests.delete(sessionId);
  };

  const bumpInFlightTurns = (sessionId: string, delta: number): void => {
    const next = (sessionInFlightTurns.get(sessionId) ?? 0) + delta;
    if (next <= 0) {
      sessionInFlightTurns.delete(sessionId);
      return;
    }
    sessionInFlightTurns.set(sessionId, next);
  };

  const enqueueActivePromptTurn = (
    sessionId: string,
    turn: ActivePromptTurn,
  ): void => {
    const turns = sessionActivePromptTurns.get(sessionId) ?? [];
    turns.push(turn);
    sessionActivePromptTurns.set(sessionId, turns);
  };

  const dequeueActivePromptTurn = (
    sessionId: string,
    executionId: string,
  ): void => {
    const turns = sessionActivePromptTurns.get(sessionId);
    if (!turns) return;
    const next = turns.filter((turn) => turn.executionId !== executionId);
    if (next.length === 0) {
      sessionActivePromptTurns.delete(sessionId);
      return;
    }
    sessionActivePromptTurns.set(sessionId, next);
  };

  const bindSessionEventDispatcher = (
    sessionId: string,
    session: ManagedAcpSession,
  ): void => {
    session.onEvent((event) => {
      const activeTurn = sessionActivePromptTurns.get(sessionId)?.[0];
      if (activeTurn) {
        activeTurn.emit(event);
        return;
      }
      const owner = sessionOwners.get(sessionId);
      if (owner) {
        owner(event);
        return;
      }
      log.debug("session_event_dropped_without_owner", {
        sessionId,
        eventType: event.type,
      });
    });
  };

  const closeSession = (
    sessionId: string,
    reason: string,
    emit?: EventEmitter,
  ): boolean => {
    const session = sessions.get(sessionId);
    if (!session) return false;

    sessions.delete(sessionId);
    sessionWorkspaces.delete(sessionId);
    sessionPrincipals.delete(sessionId);
    sessionPolicyContexts.delete(sessionId);
    sessionOwners.delete(sessionId);
    sessionLastActivityMs.delete(sessionId);
    sessionInFlightTurns.delete(sessionId);
    sessionIdempotency.delete(sessionId);
    sessionActivePromptTurns.delete(sessionId);
    deleteTransfer(sessionId);
    clearSessionPendingApprovals(sessionId);

    try {
      session.cancel();
    } catch {
      // Best-effort cancel on close.
    }

    try {
      const executions = stateStore.listExecutions(sessionId, 500);
      for (const execution of executions) {
        if (execution.state !== "queued" && execution.state !== "running") continue;
        stateStore.transitionExecutionState(execution.id, "cancelled", {
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          stopReason: reason,
        });
      }
    } catch {
      // Best-effort execution transition on session close.
    }

    const nowIso = new Date().toISOString();
    try {
      applyLifecycleEvent(sessionId, "SESSION_CLOSED", {
        at: nowIso,
        reason,
        ...(emit ? { notifyEmit: emit } : {}),
      });
      stateStore.updateSession(sessionId, {
        status: "idle",
        lifecycleState: "closed",
        parkedReason: null,
        parkedAt: null,
        lifecycleUpdatedAt: nowIso,
        lastActivityAt: nowIso,
      });
    } catch {
      // Session could be already absent from the persisted store.
    }

    if (emit) {
      emit({
        type: "session_closed",
        sessionId,
        reason,
      });
    }

    log.info("session_closed", {
      sessionId,
      runtimeId: session.runtimeId,
      reason,
    });
    return true;
  };

  const withCorrelation = <T extends GatewayEvent>(
    event: T,
    correlation: EventCorrelation,
  ): GatewayEvent => {
    switch (event.type) {
      case "text_delta":
      case "thinking_delta":
      case "tool_start":
      case "tool_end":
      case "approval_request":
      case "turn_end":
      case "error":
        return { ...event, ...correlation };
      default:
        return event;
    }
  };

  const getOrCreateIdempotencyMap = (
    sessionId: string,
  ): Map<string, { state: "running" | "completed"; turnId: string; executionId: string; parentExecutionId?: string; completedAtMs?: number }> => {
    const existing = sessionIdempotency.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, { state: "running" | "completed"; turnId: string; executionId: string; parentExecutionId?: string; completedAtMs?: number }>();
    sessionIdempotency.set(sessionId, created);
    return created;
  };

  const pruneIdempotencyMap = (entries: Map<string, { state: "running" | "completed"; turnId: string; executionId: string; parentExecutionId?: string; completedAtMs?: number }>): void => {
    const nowMs = Date.now();
    const ttlMs = 15 * 60 * 1000;
    for (const [key, value] of entries) {
      if (value.state === "completed" && value.completedAtMs && nowMs - value.completedAtMs > ttlMs) {
        entries.delete(key);
      }
    }
  };

  const handleSessionNew = (
    msg: Extract<ClientMessage, { type: "session_new" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    const connectionPrincipal = resolvePrincipal(connectionId);
    const workspaceId = msg.workspaceId?.trim() || defaultWorkspaceId;
    const requestedPrincipalType = msg.principalType;
    const requestedPrincipalId = msg.principalId?.trim();
    if (
      connectionPrincipal?.verified
      && (
        (requestedPrincipalType !== undefined && requestedPrincipalType !== connectionPrincipal.principalType)
        || (requestedPrincipalId !== undefined && requestedPrincipalId !== connectionPrincipal.principalId)
      )
    ) {
      emit({
        type: "error",
        sessionId: "",
        message: "Authenticated principal does not match requested session principal.",
      });
      return;
    }
    const principalType: PrincipalType = connectionPrincipal?.verified
      ? connectionPrincipal.principalType
      : (requestedPrincipalType ?? "user");
    const principalId = connectionPrincipal?.verified
      ? connectionPrincipal.principalId
      : (requestedPrincipalId || "user:local");
    const source: PromptSource = msg.source ?? "interactive";
    const policyContext: SessionPolicyContext = {
      principalType,
      principalId,
      source,
      workspaceId,
    };
    void (async () => {
      const acpSession = await createAcpSession(msg.runtimeId, msg.model, emit, policyContext);
      const sessionId = acpSession.id;
      const now = new Date().toISOString();

      try {
        stateStore.createSession({
          id: sessionId,
          workspaceId,
          principalType,
          principalId,
          source,
          runtimeId: acpSession.runtimeId,
          acpSessionId: acpSession.acpSessionId,
          status: "active",
          lifecycleState: "live",
          lifecycleUpdatedAt: now,
          lifecycleVersion: 0,
          createdAt: now,
          lastActivityAt: now,
          tokenUsage: { input: 0, output: 0 },
          model: acpSession.model,
        });
      } catch (error) {
        try {
          acpSession.cancel();
        } catch {
          // Best-effort cleanup when persistence fails after ACP allocation.
        }
        throw error;
      }

      sessions.set(sessionId, acpSession);
      bindSessionEventDispatcher(sessionId, acpSession);
      sessionWorkspaces.set(sessionId, workspaceId);
      sessionPrincipals.set(sessionId, { principalType, principalId, source });
      sessionPolicyContexts.set(sessionId, policyContext);
      sessionOwners.set(sessionId, emit);
      sessionLastActivityMs.set(sessionId, Date.now());
      emit({
        type: "session_created",
        sessionId,
        model: acpSession.model,
        runtimeId: acpSession.runtimeId,
        workspaceId,
        principalType,
        principalId,
        source,
        modelRouting: acpSession.modelRouting,
        modelAliases: acpSession.modelAliases,
        modelCatalog: acpSession.modelCatalog,
        runtimeDefaults: acpSession.runtimeDefaults,
      });
      log.info("session_created", {
        sessionId,
        runtimeId: acpSession.runtimeId,
        model: acpSession.model,
        workspaceId,
        principalType,
        principalId,
        source,
        connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
      });
    })().catch((err: unknown) => {
      log.error("session_create_failed", {
        runtimeId: msg.runtimeId ?? null,
        model: msg.model ?? null,
        connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
        error: err instanceof Error ? err.message : "Unknown error",
      });
      emit({
        type: "error",
        sessionId: "",
        message: `Failed to create session: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    });
  };

  const handleAuthProof = (
    msg: Extract<ClientMessage, { type: "auth_proof" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    if (!connectionId) {
      emit({
        type: "auth_result",
        ok: false,
        message: "Unable to verify auth proof without connection context.",
      });
      return;
    }

    const principalType: PrincipalType = msg.principalType ?? "user";
    const principalId = msg.principalId.trim();
    if (!principalId) {
      emit({
        type: "auth_result",
        ok: false,
        message: "principalId is required for auth proof.",
      });
      return;
    }

    const isChallengeProbe = msg.challengeId === "" && msg.nonce === "" && msg.signature === "";
    if (isChallengeProbe) {
      const nowMs = Date.now();
      const currentChallenge = authChallenges.get(connectionId);
      if (currentChallenge && nowMs <= currentChallenge.expiresAtMs) {
        emitAuthChallenge(currentChallenge, emit);
        return;
      }
      issueAuthChallenge(connectionId, emit);
      return;
    }

    pruneConsumedAuthChallenges();
    const challengeReplayKey = `${connectionId}:${msg.challengeId}`;
    if (consumedAuthChallenges.has(challengeReplayKey)) {
      emit({
        type: "auth_result",
        ok: false,
        principalType,
        principalId,
        message: "Auth challenge was already used.",
      });
      return;
    }

    const challenge = authChallenges.get(connectionId);
    if (!challenge) {
      issueAuthChallenge(connectionId, emit);
      emit({
        type: "auth_result",
        ok: false,
        principalType,
        principalId,
        message: "Auth challenge is missing or expired; requested a new challenge.",
      });
      return;
    }

    const nowMs = Date.now();
    if (msg.nonce !== challenge.nonce) {
      emit({
        type: "auth_result",
        ok: false,
        principalType,
        principalId,
        message: "Auth nonce does not match active challenge.",
      });
      return;
    }
    if (msg.challengeId !== challenge.id) {
      emit({
        type: "auth_result",
        ok: false,
        principalType,
        principalId,
        message: "Auth challenge ID does not match active challenge.",
      });
      return;
    }
    if (nowMs > challenge.expiresAtMs) {
      authChallenges.delete(connectionId);
      issueAuthChallenge(connectionId, emit);
      emit({
        type: "auth_result",
        ok: false,
        principalType,
        principalId,
        message: "Auth challenge expired; requested a new challenge.",
      });
      return;
    }

    const verified = verifyAuthProof(
      challenge.id,
      msg.nonce,
      principalType,
      principalId,
      msg.publicKey,
      msg.signature,
    );

    if (!verified) {
      emit({
        type: "auth_result",
        ok: false,
        principalType,
        principalId,
        message: "Invalid auth signature.",
      });
      return;
    }

    consumedAuthChallenges.set(challengeReplayKey, Date.now() + CONSUMED_AUTH_CHALLENGE_TTL_MS);
    authChallenges.delete(connectionId);
    connectionPrincipals.set(connectionId, {
      principalType,
      principalId,
      verified: true,
      publicKey: normalizePublicKey(msg.publicKey),
      verifiedAt: new Date(nowMs).toISOString(),
    });
    rebindLocalOwnedSessionsToPrincipal(connectionId, principalType, principalId);

    emit({
      type: "auth_result",
      ok: true,
      principalType,
      principalId,
      message: "Authenticated connection principal.",
    });
    log.info("connection_authenticated", {
      connectionId,
      principalType,
      principalId,
    });
  };

  const handleSessionTransferRequest = (
    msg: Extract<ClientMessage, { type: "session_transfer_request" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handleSessionTransferRequest(msg, emit, context);
      });
      return;
    }
    if (!ensureSessionOwnerForConnection(msg.sessionId, emit, context)) {
      return;
    }

    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    if (!connectionId) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Session transfer requires a registered connection.",
      });
      return;
    }
    const requesterPrincipal = resolvePrincipal(connectionId);
    if (!requesterPrincipal?.verified) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Session transfer request requires authenticated connection principal.",
      });
      return;
    }

    const targetPrincipalId = msg.targetPrincipalId.trim();
    if (!targetPrincipalId) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "targetPrincipalId is required for session transfer.",
      });
      return;
    }
    const targetPrincipalType: PrincipalType = msg.targetPrincipalType ?? "user";
    let sessionPrincipal = sessionPrincipals.get(msg.sessionId) ?? {
      principalType: "user" as const,
      principalId: "user:local",
      source: "interactive" as const,
    };
    if (
      requesterPrincipal.principalType !== sessionPrincipal.principalType
      || requesterPrincipal.principalId !== sessionPrincipal.principalId
    ) {
      const rebound = rebindOwnedSessionPrincipalIfLocal(
        msg.sessionId,
        emit,
        requesterPrincipal.principalType,
        requesterPrincipal.principalId,
      );
      if (rebound) {
        sessionPrincipal = sessionPrincipals.get(msg.sessionId) ?? sessionPrincipal;
        log.info("session_rebound_to_authenticated_principal_on_transfer", {
          connectionId,
          sessionId: msg.sessionId,
          principalType: requesterPrincipal.principalType,
          principalId: requesterPrincipal.principalId,
        });
      }
    }
    if (
      requesterPrincipal.principalType !== sessionPrincipal.principalType
      || requesterPrincipal.principalId !== sessionPrincipal.principalId
    ) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Authenticated principal does not own this session.",
      });
      return;
    }
    const expiresInMs = Math.max(
      TRANSFER_MIN_TTL_MS,
      Math.min(TRANSFER_MAX_TTL_MS, Math.floor(msg.expiresInMs ?? TRANSFER_DEFAULT_TTL_MS)),
    );
    const nowMs = Date.now();
    const expiresAtMs = nowMs + expiresInMs;

    const transfer: SessionTransferRequest = {
      sessionId: msg.sessionId,
      requesterConnectionId: connectionId,
      fromPrincipalType: sessionPrincipal.principalType,
      fromPrincipalId: sessionPrincipal.principalId,
      targetPrincipalType,
      targetPrincipalId,
      expiresAtMs,
      state: "requested",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    persistTransfer(transfer);
    applyLifecycleEvent(msg.sessionId, "TRANSFER_REQUESTED", {
      parkedReason: "transfer_pending",
      reason: "transfer_requested",
      actorPrincipalType: transfer.fromPrincipalType,
      actorPrincipalId: transfer.fromPrincipalId,
      notifyEmit: emit,
    });

    const requestedEvent: GatewayEvent = {
      type: "session_transfer_requested",
      sessionId: msg.sessionId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType: transfer.targetPrincipalType,
      targetPrincipalId: transfer.targetPrincipalId,
      expiresAt: new Date(transfer.expiresAtMs).toISOString(),
    };
    emitTransferEventToParties(transfer, requestedEvent, emit);
    emitTransferUpdated(transfer, "requested", emit);

    log.info("session_transfer_requested", {
      connectionId,
      sessionId: msg.sessionId,
      runtimeId: session.runtimeId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType,
      targetPrincipalId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  };

  const handleSessionTransferAccept = (
    msg: Extract<ClientMessage, { type: "session_transfer_accept" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context, {
        allowTransferTarget: true,
      }).then((hydrated) => {
        if (!hydrated) return;
        handleSessionTransferAccept(msg, emit, context);
      });
      return;
    }

    const pendingTransfer = sessionTransfers.get(msg.sessionId);
    if (!pendingTransfer) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "No pending transfer for this session.",
      });
      return;
    }
    const transfer = markTransferExpiredIfNeeded(pendingTransfer, emit);

    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    const principal = resolvePrincipal(connectionId);
    if (!connectionId || !principal?.verified) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Session transfer acceptance requires authenticated connection principal.",
      });
      return;
    }
    if (transfer.state === "expired") {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Pending transfer expired and remains parked until owner resumes.",
      });
      return;
    }

    if (
      principal.principalType !== transfer.targetPrincipalType
      || principal.principalId !== transfer.targetPrincipalId
    ) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Connection principal does not match transfer target.",
      });
      return;
    }

    sessionOwners.set(msg.sessionId, emit);
    deleteTransfer(msg.sessionId);
    applyLifecycleEvent(msg.sessionId, "TRANSFER_ACCEPTED", {
      reason: "transfer_accepted",
      actorPrincipalType: principal.principalType,
      actorPrincipalId: principal.principalId,
      notifyEmit: emit,
    });
    emitTransferUpdated(transfer, "accepted", emit);
    sessionPrincipals.set(msg.sessionId, {
      principalType: principal.principalType,
      principalId: principal.principalId,
      source: "interactive",
    });
    const policyContext = sessionPolicyContexts.get(msg.sessionId);
    if (policyContext) {
      policyContext.principalType = principal.principalType;
      policyContext.principalId = principal.principalId;
      policyContext.source = "interactive";
    }
    touchSession(msg.sessionId);
    try {
      stateStore.updateSession(msg.sessionId, {
        principalType: principal.principalType,
        principalId: principal.principalId,
        source: "interactive",
        lastActivityAt: new Date().toISOString(),
      });
    } catch {
      // Session may already be gone from persistence if concurrently closed.
    }

    const transferredEvent: GatewayEvent = {
      type: "session_transferred",
      sessionId: msg.sessionId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType: transfer.targetPrincipalType,
      targetPrincipalId: transfer.targetPrincipalId,
      transferredAt: new Date().toISOString(),
    };

    emitTransferEventToParties(transfer, transferredEvent, emit);
    log.info("session_transferred", {
      connectionId,
      sessionId: msg.sessionId,
      runtimeId: session.runtimeId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType: transfer.targetPrincipalType,
      targetPrincipalId: transfer.targetPrincipalId,
    });
  };

  const handleSessionTransferDismiss = (
    msg: Extract<ClientMessage, { type: "session_transfer_dismiss" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context, {
        allowTransferTarget: true,
      }).then((hydrated) => {
        if (!hydrated) return;
        handleSessionTransferDismiss(msg, emit, context);
      });
      return;
    }

    const pendingTransfer = sessionTransfers.get(msg.sessionId);
    if (!pendingTransfer) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "No pending transfer for this session.",
      });
      return;
    }
    const transfer = markTransferExpiredIfNeeded(pendingTransfer, emit);
    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    const principal = resolvePrincipal(connectionId);
    if (!connectionId || !principal?.verified) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Session transfer dismiss requires authenticated connection principal.",
      });
      return;
    }
    if (
      principal.principalType !== transfer.targetPrincipalType
      || principal.principalId !== transfer.targetPrincipalId
    ) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Connection principal does not match transfer target.",
      });
      return;
    }

    deleteTransfer(msg.sessionId);
    applyLifecycleEvent(msg.sessionId, "TRANSFER_DISMISSED", {
      reason: transfer.state === "expired" ? "target_dismissed_after_expiry" : "target_dismissed",
      actorPrincipalType: principal.principalType,
      actorPrincipalId: principal.principalId,
      notifyEmit: emit,
    });
    emitTransferUpdated(transfer, "dismissed", emit, transfer.state === "expired" ? "target_dismissed_after_expiry" : "target_dismissed");
    log.info("session_transfer_dismissed", {
      connectionId,
      sessionId: msg.sessionId,
      runtimeId: session.runtimeId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType: transfer.targetPrincipalType,
      targetPrincipalId: transfer.targetPrincipalId,
    });
  };

  const handlePrompt = (
    msg: Extract<ClientMessage, { type: "prompt" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handlePrompt(msg, emit, context);
      });
      return;
    }
    if (!ensureSessionOwnerForConnection(msg.sessionId, emit, context)) {
      return;
    }

    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit) ?? null;
    const principal = sessionPrincipals.get(msg.sessionId) ?? {
      principalType: "user" as const,
      principalId: "user:local" as const,
      source: "interactive" as const,
    };
    const transfer = sessionTransfers.get(msg.sessionId);
    if (transfer) {
      const resolvedTransfer = markTransferExpiredIfNeeded(transfer, emit);
      const principal = resolvePrincipal(connectionId ?? undefined);
      const isSourcePrincipal =
        principal?.verified
        && principal.principalType === resolvedTransfer.fromPrincipalType
        && principal.principalId === resolvedTransfer.fromPrincipalId;
      if (!isSourcePrincipal) {
        emit({
          type: "error",
          sessionId: msg.sessionId,
          message: "Session is parked due to pending transfer; only owner can resume.",
        });
        return;
      }
      deleteTransfer(msg.sessionId);
      applyLifecycleEvent(msg.sessionId, "OWNER_RESUMED", {
        reason: resolvedTransfer.state === "expired" ? "owner_resumed_after_expiry" : "owner_resumed",
        actorPrincipalType: resolvedTransfer.fromPrincipalType,
        actorPrincipalId: resolvedTransfer.fromPrincipalId,
        notifyEmit: emit,
      });
      emitTransferUpdated(
        resolvedTransfer,
        "cancelled",
        emit,
        resolvedTransfer.state === "expired" ? "owner_resumed_after_expiry" : "owner_resumed",
      );
      log.info("session_transfer_cancelled_by_owner_resume", {
        connectionId,
        sessionId: msg.sessionId,
        fromPrincipalType: resolvedTransfer.fromPrincipalType,
        fromPrincipalId: resolvedTransfer.fromPrincipalId,
        targetPrincipalType: resolvedTransfer.targetPrincipalType,
        targetPrincipalId: resolvedTransfer.targetPrincipalId,
      });
    } else {
      const persisted = stateStore.getSession(msg.sessionId);
      if (persisted?.lifecycleState === "parked") {
        applyLifecycleEvent(msg.sessionId, "OWNER_RESUMED", {
          reason: "owner_prompt_resumed",
          actorPrincipalType: principal.principalType,
          actorPrincipalId: principal.principalId,
          notifyEmit: emit,
        });
      }
    }

    const executionId = `exec-${msg.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parentExecutionId = msg.parentExecutionId?.trim() || undefined;
    const imageInputs = msg.images ?? [];
    const promptBody = msg.text.trim().length > 0
      ? msg.text
      : (imageInputs.length > 0 ? "(image input)" : "");
    const workspaceId = sessionWorkspaces.get(msg.sessionId) ?? defaultWorkspaceId;
    if (parentExecutionId) {
      const parentExecution = stateStore.getExecution(parentExecutionId);
      if (!parentExecution || parentExecution.sessionId !== msg.sessionId) {
        emit({
          type: "error",
          sessionId: msg.sessionId,
          message: "parentExecutionId must reference an execution in the same session.",
        });
        return;
      }
    }
    const correlation: EventCorrelation = {
      executionId,
      parentExecutionId,
      turnId,
      policySnapshotId,
    };
    const idempotencyKey = msg.idempotencyKey?.trim() || undefined;
    const dedup = idempotencyKey ? getOrCreateIdempotencyMap(msg.sessionId) : undefined;
    if (idempotencyKey) {
      pruneIdempotencyMap(dedup!);
      const existing = dedup!.get(idempotencyKey);
      if (existing) {
        log.info("prompt_deduplicated", {
          connectionId,
          sessionId: msg.sessionId,
          idempotencyKey,
          existingExecutionId: existing.executionId,
          existingTurnId: existing.turnId,
          existingState: existing.state,
        });
        emit(withCorrelation({
          type: "turn_end",
          sessionId: msg.sessionId,
          stopReason: "idempotent_duplicate",
        }, {
          executionId: existing.executionId,
          parentExecutionId: existing.parentExecutionId,
          turnId: existing.turnId,
          policySnapshotId,
        }));
        return;
      }
      dedup!.set(idempotencyKey, {
        state: "running",
        turnId,
        executionId,
        parentExecutionId,
      });
    }

    const executionCreatedAt = new Date().toISOString();
    try {
      stateStore.createExecution({
        id: executionId,
        sessionId: msg.sessionId,
        turnId,
        ...(parentExecutionId ? { parentExecutionId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        workspaceId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        source: principal.source,
        runtimeId: session.runtimeId,
        model: session.model,
        policySnapshotId,
        state: "queued",
        createdAt: executionCreatedAt,
        updatedAt: executionCreatedAt,
      });
      stateStore.transitionExecutionState(executionId, "running", {
        updatedAt: executionCreatedAt,
        startedAt: executionCreatedAt,
      });
    } catch (error) {
      if (idempotencyKey) {
        dedup?.delete(idempotencyKey);
      }
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: error instanceof Error ? error.message : "Failed to create execution record.",
      });
      return;
    }

    log.info("prompt_received", {
      connectionId,
      sessionId: msg.sessionId,
      executionId,
      parentExecutionId: parentExecutionId ?? null,
      turnId,
      policySnapshotId,
      principalType: principal.principalType,
      principalId: principal.principalId,
      source: principal.source,
      idempotencyKey: idempotencyKey ?? null,
      textPreview: msg.text.slice(0, 50),
      imageCount: imageInputs.length,
    });
    touchSession(msg.sessionId);
    const emitWithCorrelation: EventEmitter = (event) => {
      emit(withCorrelation(event, correlation));
    };

    // Record user prompt to transcript
    const promptRecordContent = imageInputs.length > 0
      ? `${msg.text}${msg.text ? "\n\n" : ""}${imageInputs.map((image) => `[image] ${image.url}`).join("\n")}`
      : msg.text;
    stateStore.appendMessage({
      workspaceId,
      sessionId: msg.sessionId,
      role: "user",
      content: promptRecordContent,
      timestamp: new Date().toISOString(),
      tokenEstimate: estimateTokens(promptRecordContent),
    });

    // Wrap emit with recording layer to capture streaming events
    let sawStreamedText = false;
    let assistantMessageForTurn = "";
    let turnCompleted = false;
    let executionFinalized = false;
    const markTurnCompleted = (): void => {
      if (turnCompleted) return;
      turnCompleted = true;
      bumpInFlightTurns(msg.sessionId, -1);
      dequeueActivePromptTurn(msg.sessionId, executionId);
    };
    const finalizeExecution = (
      state: ExecutionState,
      options: {
        stopReason?: string;
        errorMessage?: string;
      } = {},
    ): void => {
      if (executionFinalized) return;
      executionFinalized = true;
      try {
        stateStore.transitionExecutionState(executionId, state, {
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          ...(options.stopReason !== undefined ? { stopReason: options.stopReason } : {}),
          ...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
        });
      } catch (error) {
        log.warn("execution_finalize_failed", {
          connectionId,
          sessionId: msg.sessionId,
          executionId,
          parentExecutionId: parentExecutionId ?? null,
          turnId,
          policySnapshotId,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    bumpInFlightTurns(msg.sessionId, 1);
    const recordingEmitWithHooks = createRecordingEmitter(workspaceId, msg.sessionId, stateStore, emitWithCorrelation, {
      onAnyEvent: (event) => {
        touchSession(msg.sessionId);
        if (event.type === "tool_start") {
          stateStore.logEvent({
            sessionId: msg.sessionId,
            timestamp: new Date().toISOString(),
            type: "tool_call",
            tool: event.tool,
            detail: safeStringify({
              executionId,
              parentExecutionId,
              turnId,
              policySnapshotId,
              principalType: principal.principalType,
              principalId: principal.principalId,
              source: principal.source,
              toolCallId: event.toolCallId ?? null,
            }),
          });
        }
        if (event.type === "turn_end" && !turnCompleted) {
          markTurnCompleted();
          finalizeExecution(
            mapStopReasonToExecutionState(event.stopReason),
            { stopReason: event.stopReason },
          );
        }
      },
      onTextDelta: () => {
        sawStreamedText = true;
      },
      onApprovalRequest: (requestId) => {
        trackPendingApproval(
          msg.sessionId,
          requestId,
          turnId,
          executionId,
          parentExecutionId,
          policySnapshotId,
        );
      },
      onAssistantMessage: (assistantText) => {
        assistantMessageForTurn = assistantText;
      },
    });

    let promptText = msg.text;
    if (memoryProvider) {
      try {
        const context = memoryProvider.getContext({
          workspaceId,
          sessionId: msg.sessionId,
          prompt: promptBody,
          scope: "hybrid",
        });
        if (context.rendered) {
          promptText = `${context.rendered}\n\n# User Prompt\n${promptBody}`;
        }
        log.debug("memory_context_applied", {
          connectionId,
          sessionId: msg.sessionId,
          runtimeId: session.runtimeId,
          executionId,
          turnId,
          policySnapshotId,
          rendered: context.rendered.length > 0,
          totalTokens: context.totalTokens,
          budgetTokens: context.budgetTokens,
          hotCount: context.hot.length,
          warmCount: context.warm.length,
          coldCount: context.cold.length,
        });
      } catch (error) {
        log.warn("memory_context_failed", {
          connectionId,
          sessionId: msg.sessionId,
          runtimeId: session.runtimeId,
          executionId,
          turnId,
          policySnapshotId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      // Count model input payload (including any injected memory context).
      incrementSessionTokenUsage(msg.sessionId, estimateTokens(promptText), 0);
    } catch (error) {
      log.warn("session_token_usage_input_update_failed", {
        connectionId,
        sessionId: msg.sessionId,
        runtimeId: session.runtimeId,
        executionId,
        turnId,
        policySnapshotId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    enqueueActivePromptTurn(msg.sessionId, {
      executionId,
      emit: recordingEmitWithHooks,
    });

    // ACP streaming events flow via session-scoped dispatcher → active prompt turn emitter.
    // prompt() resolves when the turn ends (PromptResponse with stopReason)
    let promptPromise: Promise<unknown>;
    try {
      promptPromise = Promise.resolve(session.prompt(promptText, imageInputs));
    } catch (err) {
      if (idempotencyKey) {
        sessionIdempotency.get(msg.sessionId)?.delete(idempotencyKey);
      }
      finalizeExecution("failed", {
        errorMessage: err instanceof Error ? err.message : "Unknown error",
      });
      markTurnCompleted();
      touchSession(msg.sessionId);
      log.error("prompt_failed", {
        connectionId,
        sessionId: msg.sessionId,
        runtimeId: session.runtimeId,
        executionId,
        parentExecutionId: parentExecutionId ?? null,
        turnId,
        policySnapshotId,
        error: err instanceof Error ? err.message : "Unknown error",
      });
      stateStore.logEvent({
        sessionId: msg.sessionId,
        timestamp: new Date().toISOString(),
        type: "error",
        detail: safeStringify({
          executionId,
          parentExecutionId,
          turnId,
          policySnapshotId,
          principalType: principal.principalType,
          principalId: principal.principalId,
          source: principal.source,
          error: err instanceof Error ? err.message : "Unknown error",
        }),
      });
      emitWithCorrelation({
        type: "error",
        sessionId: msg.sessionId,
        message: err instanceof Error ? err.message : "Unknown error",
      });
      return;
    }
    promptPromise.then(
      (result) => {
        log.info("prompt_response", {
          connectionId,
          sessionId: msg.sessionId,
          runtimeId: session.runtimeId,
          executionId,
          parentExecutionId: parentExecutionId ?? null,
          turnId,
          policySnapshotId,
          payloadPreview: safeStringify(result ?? null).slice(0, 500),
        });
        const r = result as { stopReason?: string; content?: unknown } | undefined;

        // Extract any text from the prompt response content blocks
        // (the agent may include final text here instead of streaming it)
        try {
          const rawContent = r?.content;
          const blocks = Array.isArray(rawContent)
            ? rawContent
            : rawContent && typeof rawContent === "object"
              ? [rawContent]
              : [];
          for (const block of blocks) {
            const b = block as { type?: unknown; text?: unknown };
            if (!sawStreamedText && b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
              recordingEmitWithHooks({
                type: "text_delta",
                sessionId: msg.sessionId,
                delta: b.text,
              });
            }
          }
        } catch (contentErr) {
          log.error("prompt_response_content_extract_error", {
            connectionId,
            sessionId: msg.sessionId,
            runtimeId: session.runtimeId,
            executionId,
            turnId,
            policySnapshotId,
            error: contentErr instanceof Error ? contentErr.message : String(contentErr),
          });
        }

        if (!turnCompleted) {
          recordingEmitWithHooks({
            type: "turn_end",
            sessionId: msg.sessionId,
            stopReason: r?.stopReason ?? "end_turn",
          });
        }
        if (idempotencyKey) {
          const dedup = sessionIdempotency.get(msg.sessionId);
          dedup?.set(idempotencyKey, {
            state: "completed",
            turnId,
            executionId,
            parentExecutionId,
            completedAtMs: Date.now(),
          });
        }
        if (memoryProvider) {
          try {
            memoryProvider.recordTurn({
              workspaceId,
              sessionId: msg.sessionId,
              userText: msg.text,
              assistantText: assistantMessageForTurn,
            });
          } catch (error) {
            log.warn("memory_record_turn_failed", {
              connectionId,
              sessionId: msg.sessionId,
              runtimeId: session.runtimeId,
              executionId,
              turnId,
              policySnapshotId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        try {
          incrementSessionTokenUsage(
            msg.sessionId,
            0,
            estimateTokens(assistantMessageForTurn),
          );
        } catch (error) {
          log.warn("session_token_usage_output_update_failed", {
            connectionId,
            sessionId: msg.sessionId,
            runtimeId: session.runtimeId,
            executionId,
            turnId,
            policySnapshotId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      (err: unknown) => {
        if (idempotencyKey) {
          sessionIdempotency.get(msg.sessionId)?.delete(idempotencyKey);
        }
        finalizeExecution("failed", {
          errorMessage: err instanceof Error ? err.message : "Unknown error",
        });
        markTurnCompleted();
        touchSession(msg.sessionId);
        log.error("prompt_failed", {
          connectionId,
          sessionId: msg.sessionId,
          runtimeId: session.runtimeId,
          executionId,
          parentExecutionId: parentExecutionId ?? null,
          turnId,
          policySnapshotId,
          error: err instanceof Error ? err.message : "Unknown error",
        });
        stateStore.logEvent({
          sessionId: msg.sessionId,
          timestamp: new Date().toISOString(),
          type: "error",
          detail: safeStringify({
            executionId,
            parentExecutionId,
            turnId,
            policySnapshotId,
            principalType: principal.principalType,
            principalId: principal.principalId,
            source: principal.source,
            error: err instanceof Error ? err.message : "Unknown error",
          }),
        });
        emitWithCorrelation({
          type: "error",
          sessionId: msg.sessionId,
          message: err instanceof Error ? err.message : "Unknown error",
        });
      },
    );
  };

  const handleSessionList = (
    msg: Extract<ClientMessage, { type: "session_list" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const requestedLimit = Math.max(
      1,
      Math.min(
        Number.isFinite(msg.limit) ? Math.floor(msg.limit as number) : DEFAULT_SESSION_LIST_LIMIT,
        MAX_SESSION_LIST_LIMIT,
      ),
    );
    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    const connectionPrincipal = resolvePrincipal(connectionId);
    if (connectionPrincipal?.verified) {
      try {
        const page = stateStore.listSessionsPage({
          principalType: connectionPrincipal.principalType,
          principalId: connectionPrincipal.principalId,
          limit: requestedLimit,
          ...(msg.cursor ? { cursor: msg.cursor } : {}),
        });
        emit({
          type: "session_list",
          sessions: page.sessions,
          hasMore: page.hasMore,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
      } catch (error) {
        log.warn("session_list_failed", {
          connectionId: connectionId ?? null,
          principalType: connectionPrincipal.principalType,
          principalId: connectionPrincipal.principalId,
          error: error instanceof Error ? error.message : String(error),
        });
        emit({
          type: "error",
          sessionId: "session-list",
          message: error instanceof Error ? error.message : "Unable to list sessions.",
        });
      }
      return;
    }

    if (msg.cursor) {
      emit({
        type: "error",
        sessionId: "session-list",
        message: "Session list cursor requires authenticated principal.",
      });
      return;
    }

    const sessionsList = stateStore
      .listSessions()
      .filter((session) => sessionOwners.get(session.id) === emit);
    const hasMore = sessionsList.length > requestedLimit;
    emit({
      type: "session_list",
      sessions: hasMore ? sessionsList.slice(0, requestedLimit) : sessionsList,
      hasMore,
    });
  };

  const handleCancel = (
    msg: Extract<ClientMessage, { type: "cancel" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handleCancel(msg, emit, context);
      });
      return;
    }
    if (!ensureSessionOwnerForConnection(msg.sessionId, emit, context)) {
      return;
    }

    session.cancel();
    touchSession(msg.sessionId);
    clearSessionPendingApprovals(msg.sessionId);
    log.info("session_cancelled", {
      connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
      sessionId: msg.sessionId,
      runtimeId: session.runtimeId,
    });
  };

  const handleSessionClose = (
    msg: Extract<ClientMessage, { type: "session_close" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handleSessionClose(msg, emit, context);
      });
      return;
    }
    if (!ensureSessionOwnerForConnection(msg.sessionId, emit, context)) {
      return;
    }
    const closed = closeSession(msg.sessionId, "client_close", emit);
    if (!closed) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: `Session not found: ${msg.sessionId}`,
      });
      return;
    }
    log.info("session_close_requested", {
      connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
      sessionId: msg.sessionId,
    });
  };

  const handleApprovalResponse = (
    msg: Extract<ClientMessage, { type: "approval_response" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const allow = msg.allow ?? msg.optionId?.startsWith("allow_") ?? false;
    const optionId =
      msg.optionId
      ?? (allow ? "allow_once" : "reject_once");

    const requestMeta = requestToSession.get(msg.requestId);
    if (!requestMeta) {
      log.info("approval_response_stale_unknown_request_ignored", {
        connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
        requestId: msg.requestId,
      });
      return;
    }
    const sessionId = requestMeta.sessionId;
    const principal = sessionPrincipals.get(sessionId) ?? {
      principalType: "user" as const,
      principalId: "user:local",
      source: "interactive" as const,
    };

    if (!ensureSessionOwnerForConnection(sessionId, emit, context)) {
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      clearPendingApproval(sessionId, msg.requestId);
      log.info("approval_response_stale_session_ignored", {
        connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
        sessionId,
        requestId: msg.requestId,
      });
      return;
    }

    const found = session.respondToPermission(msg.requestId, optionId);
    if (!found) {
      clearPendingApproval(sessionId, msg.requestId);
      log.warn("approval_response_no_pending_permission", {
        connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
        sessionId,
        turnId: requestMeta.turnId ?? null,
        requestId: msg.requestId,
      });
      return;
    }

    clearPendingApproval(sessionId, msg.requestId);
    touchSession(sessionId);
    log.info("approval_response_applied", {
      connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
      sessionId,
      runtimeId: session.runtimeId,
      turnId: requestMeta.turnId ?? null,
      executionId: requestMeta.executionId ?? null,
      parentExecutionId: requestMeta.parentExecutionId ?? null,
      policySnapshotId: requestMeta.policySnapshotId ?? policySnapshotId,
      requestId: msg.requestId,
      optionId,
    });
    stateStore.logEvent({
      sessionId,
      timestamp: new Date().toISOString(),
      type: allow ? "approval" : "deny",
      detail: safeStringify({
        requestId: msg.requestId,
        optionId,
        allow,
        executionId: requestMeta.executionId ?? null,
        parentExecutionId: requestMeta.parentExecutionId ?? null,
        turnId: requestMeta.turnId ?? null,
        policySnapshotId: requestMeta.policySnapshotId ?? policySnapshotId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        source: principal.source,
      }),
    });
  };

  const handleSessionReplay = (
    msg: Extract<ClientMessage, { type: "session_replay" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      if (!stateStore.getSession(msg.sessionId)) {
        emit({
          type: "transcript",
          sessionId: msg.sessionId,
          messages: [],
        });
        return;
      }
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handleSessionReplay(msg, emit, context);
      });
      return;
    }
    if (!ensureSessionOwnerForConnection(msg.sessionId, emit, context)) {
      return;
    }
    touchSession(msg.sessionId);
    const messages = stateStore.getTranscript(msg.sessionId);
    emit({
      type: "transcript",
      sessionId: msg.sessionId,
      messages,
    });
    log.info("session_replayed", {
      connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
      sessionId: msg.sessionId,
      messageCount: messages.length,
    });
  };

  const handleSessionTakeover = (
    msg: Extract<ClientMessage, { type: "session_takeover" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      if (!stateStore.getSession(msg.sessionId)) {
        emit({
          type: "error",
          sessionId: msg.sessionId,
          message: `Session not found: ${msg.sessionId}`,
        });
        return;
      }
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handleSessionTakeover(msg, emit, context);
      });
      return;
    }

    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit);
    const principal = resolvePrincipal(connectionId);
    if (!principal?.verified) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Session takeover requires authenticated connection principal.",
      });
      return;
    }
    if (!canConnectionClaimSession(msg.sessionId, connectionId)) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Authenticated principal does not own this session.",
      });
      return;
    }

    const ownership = ensureSessionOwner(sessionOwners, msg.sessionId, emit, {
      canClaimWhenUnowned: true,
    });
    if (ownership === "owned_by_other") {
      emitSessionOwnershipError(emit, msg.sessionId);
      return;
    }

    const pendingTransfer = sessionTransfers.get(msg.sessionId);
    if (pendingTransfer) {
      const resolved = markTransferExpiredIfNeeded(pendingTransfer, emit);
      if (resolved.state !== "expired") {
        emit({
          type: "error",
          sessionId: msg.sessionId,
          message: "Session has an active transfer request. Use transfer accept/dismiss first.",
        });
        return;
      }
      deleteTransfer(msg.sessionId);
      emitTransferUpdated(resolved, "cancelled", emit, "takeover_cancelled_expired_transfer");
    }

    rebindOwnedSessionPrincipalIfLocal(
      msg.sessionId,
      emit,
      principal.principalType,
      principal.principalId,
    );

    const persisted = stateStore.getSession(msg.sessionId);
    if (persisted?.lifecycleState === "parked") {
      applyLifecycleEvent(msg.sessionId, "TAKEOVER", {
        reason: "session_takeover",
        actorPrincipalType: principal.principalType,
        actorPrincipalId: principal.principalId,
        notifyEmit: emit,
      });
    }
    touchSession(msg.sessionId);
    const messages = stateStore.getTranscript(msg.sessionId);
    emit({
      type: "transcript",
      sessionId: msg.sessionId,
      messages,
    });
    log.info("session_takeover_completed", {
      connectionId: connectionId ?? null,
      sessionId: msg.sessionId,
      principalType: principal.principalType,
      principalId: principal.principalId,
      messageCount: messages.length,
    });
  };

  const buildUsageSummary = (
    sessionId: string,
    workspaceId: string,
  ): UsageSummary => {
    const sessionRecord = stateStore.getSession(sessionId);
    const tokensInput = sessionRecord?.tokenUsage.input ?? 0;
    const tokensOutput = sessionRecord?.tokenUsage.output ?? 0;
    const executionCounts = stateStore.getExecutionStateCounts(sessionId);

    const summary: UsageSummary = {
      tokens: {
        input: tokensInput,
        output: tokensOutput,
        total: tokensInput + tokensOutput,
      },
      executions: executionCounts,
    };

    if (memoryProvider) {
      summary.memory = {
        session: memoryProvider.getStats({ workspaceId, sessionId, scope: "session" }),
        workspace: memoryProvider.getStats({ workspaceId, sessionId, scope: "workspace" }),
      };
    }

    return summary;
  };

  const handleMemoryBackedUsageAction = (
    queryType: "memory_query" | "usage_query",
    msg: {
      sessionId: string;
      action: "stats" | "recent" | "search" | "context" | "clear";
      query?: string;
      prompt?: string;
      limit?: number;
      scope?: "session" | "workspace" | "hybrid";
    },
    emit: EventEmitter,
    workspaceId: string,
    connectionId: string | null,
  ): void => {
    if (!memoryProvider) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Memory is not enabled for this gateway.",
      });
      return;
    }

    const limit = Math.max(1, Math.min(50, Math.floor(msg.limit ?? 10)));
    const scope = msg.scope ?? "session";
    const resultType = queryType === "usage_query" ? "usage_result" : "memory_result";

    switch (msg.action) {
      case "stats": {
        const stats = memoryProvider.getStats({
          workspaceId,
          sessionId: msg.sessionId,
          scope: scope === "workspace" ? "workspace" : "session",
        });
        emit({
          type: resultType,
          sessionId: msg.sessionId,
          action: "stats",
          scope: scope === "workspace" ? "workspace" : "session",
          stats,
        });
        log.debug(`${queryType}_stats`, {
          connectionId,
          sessionId: msg.sessionId,
          scope: scope === "workspace" ? "workspace" : "session",
        });
        return;
      }
      case "recent": {
        const items = memoryProvider.getRecent({
          workspaceId,
          sessionId: msg.sessionId,
          scope: scope === "workspace" ? "workspace" : "session",
          limit,
        });
        emit({
          type: resultType,
          sessionId: msg.sessionId,
          action: "recent",
          scope: scope === "workspace" ? "workspace" : "session",
          limit,
          items,
        });
        log.debug(`${queryType}_recent`, {
          connectionId,
          sessionId: msg.sessionId,
          scope: scope === "workspace" ? "workspace" : "session",
          limit,
        });
        return;
      }
      case "search": {
        const query = msg.query?.trim() ?? "";
        if (!query) {
          emit({
            type: "error",
            sessionId: msg.sessionId,
            message: "Memory search query is required.",
          });
          return;
        }
        const items = memoryProvider.search({
          workspaceId,
          sessionId: msg.sessionId,
          scope: scope === "workspace" ? "workspace" : "session",
          query,
          limit,
        });
        emit({
          type: resultType,
          sessionId: msg.sessionId,
          action: "search",
          scope: scope === "workspace" ? "workspace" : "session",
          query,
          limit,
          items,
        });
        log.debug(`${queryType}_search`, {
          connectionId,
          sessionId: msg.sessionId,
          scope: scope === "workspace" ? "workspace" : "session",
          query,
          limit,
        });
        return;
      }
      case "context": {
        const contextScope = msg.scope ?? "hybrid";
        const prompt = msg.prompt?.trim()
          || stateStore
            .getTranscript(msg.sessionId)
            .filter((entry) => entry.role === "user")
            .slice(-1)[0]
            ?.content
          || "(no prompt)";
        const context = memoryProvider.getContext({
          workspaceId,
          sessionId: msg.sessionId,
          prompt,
          scope: contextScope === "workspace" || contextScope === "session" || contextScope === "hybrid"
            ? contextScope
            : "hybrid",
        });
        emit({
          type: resultType,
          sessionId: msg.sessionId,
          action: "context",
          scope: contextScope === "workspace" || contextScope === "session" || contextScope === "hybrid"
            ? contextScope
            : "hybrid",
          prompt,
          context,
        });
        log.debug(`${queryType}_context`, {
          connectionId,
          sessionId: msg.sessionId,
          scope: contextScope === "workspace" || contextScope === "session" || contextScope === "hybrid"
            ? contextScope
            : "hybrid",
        });
        return;
      }
      case "clear": {
        const effectiveScope = scope === "workspace" ? "workspace" : "session";
        const deleted = memoryProvider.clear({
          workspaceId,
          sessionId: msg.sessionId,
          scope: effectiveScope,
        });
        emit({
          type: resultType,
          sessionId: msg.sessionId,
          action: "clear",
          scope: effectiveScope,
          deleted,
        });
        log.info(`${queryType}_clear`, {
          connectionId,
          sessionId: msg.sessionId,
          scope: effectiveScope,
          deleted,
        });
      }
    }
  };

  const validateSessionForRead = (
    sessionId: string,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): { workspaceId: string; connectionId: string | null } | null => {
    const session = sessions.get(sessionId);
    if (!session) {
      emit({
        type: "error",
        sessionId,
        message: `Session not found: ${sessionId}`,
      });
      return null;
    }
    if (!ensureSessionOwnerForConnection(sessionId, emit, context)) {
      return null;
    }
    touchSession(sessionId);
    return {
      workspaceId: sessionWorkspaces.get(sessionId) ?? defaultWorkspaceId,
      connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
    };
  };

  const handleMemoryQuery = (
    msg: Extract<ClientMessage, { type: "memory_query" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handleMemoryQuery(msg, emit, context);
      });
      return;
    }
    const sessionContext = validateSessionForRead(msg.sessionId, emit, context);
    if (!sessionContext) return;
    handleMemoryBackedUsageAction("memory_query", msg, emit, sessionContext.workspaceId, sessionContext.connectionId);
  };

  const handleUsageQuery = (
    msg: Extract<ClientMessage, { type: "usage_query" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      void hydrateSessionIfPersisted(msg.sessionId, emit, context).then((hydrated) => {
        if (!hydrated) return;
        handleUsageQuery(msg, emit, context);
      });
      return;
    }
    const sessionContext = validateSessionForRead(msg.sessionId, emit, context);
    if (!sessionContext) return;

    const action = msg.action ?? "summary";
    if (action === "summary") {
      const summary = buildUsageSummary(msg.sessionId, sessionContext.workspaceId);
      emit({
        type: "usage_result",
        sessionId: msg.sessionId,
        action: "summary",
        summary,
      });
      log.debug("usage_query_summary", {
        connectionId: sessionContext.connectionId,
        sessionId: msg.sessionId,
        hasMemory: Boolean(memoryProvider),
      });
      return;
    }

    handleMemoryBackedUsageAction(
      "usage_query",
      { ...msg, action },
      emit,
      sessionContext.workspaceId,
      sessionContext.connectionId,
    );
  };

  const registerConnection = (connectionId: string, emit: EventEmitter): void => {
    activeConnections.set(connectionId, emit);
    emitterConnectionIds.set(emit, connectionId);
    connectionPrincipals.set(connectionId, {
      principalType: "user",
      principalId: "user:local",
      verified: false,
    });
    issueAuthChallenge(connectionId, emit);
    for (const runtime of listRuntimeHealth()) {
      emitRuntimeHealth(emit, runtime);
    }
    log.info("connection_registered", { connectionId });
  };

  const unregisterConnection = (connectionId: string, emit: EventEmitter): void => {
    activeConnections.delete(connectionId);
    emitterConnectionIds.delete(emit);
    connectionPrincipals.delete(connectionId);
    const challenge = authChallenges.get(connectionId);
    if (challenge) {
      consumedAuthChallenges.set(
        `${connectionId}:${challenge.id}`,
        Date.now() + CONSUMED_AUTH_CHALLENGE_TTL_MS,
      );
      authChallenges.delete(connectionId);
    }

    const released: string[] = [];
    for (const [sessionId, owner] of sessionOwners) {
      if (owner === emit) {
        sessionOwners.delete(sessionId);
        released.push(sessionId);
        const pendingTransfer = sessionTransfers.get(sessionId);
        if (!pendingTransfer) {
          applyLifecycleEvent(sessionId, "OWNER_DISCONNECTED", {
            parkedReason: "owner_disconnected",
            reason: "owner_disconnected",
          });
        }
      }
    }

    if (released.length > 0) {
      log.info("connection_unregistered_released_sessions", {
        connectionId,
        sessionIds: released,
      });
    } else {
      log.info("connection_unregistered", { connectionId });
    }
  };

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
    log.info("runtime_health_updated", {
      runtimeId,
      status,
      reason: reason ?? null,
    });
    broadcastRuntimeHealth(next);
    return next;
  };

  const getRuntimeHealth = (): RuntimeHealthInfo[] => listRuntimeHealth();

  const sweepIdleSessions = (now: Date = new Date()): string[] => {
    const nowMs = now.getTime();
    const closed: string[] = [];
    for (const sessionId of sessions.keys()) {
      if ((sessionInFlightTurns.get(sessionId) ?? 0) > 0) continue;
      const lastActivityMs = sessionLastActivityMs.get(sessionId) ?? 0;
      if (nowMs - lastActivityMs < idleTimeoutMs) continue;
      if (closeSession(sessionId, "idle_timeout")) {
        closed.push(sessionId);
      }
    }
    if (closed.length > 0) {
      log.info("idle_sessions_closed", {
        closedCount: closed.length,
        idleTimeoutMs,
        sessionIds: closed,
      });
    }
    return closed;
  };

  const closeSessionsByRuntime = (
    runtimeId: string,
    reason = "runtime_unavailable",
  ): string[] => {
    const closed: string[] = [];
    for (const [sessionId, session] of sessions) {
      if (session.runtimeId !== runtimeId) continue;
      const owner = sessionOwners.get(sessionId);
      if (owner) {
        owner({
          type: "error",
          sessionId,
          message: `Runtime unavailable: ${runtimeId}${reason ? ` (${reason})` : ""}`,
        });
      }
      if (closeSession(sessionId, reason, owner)) {
        closed.push(sessionId);
      }
    }
    if (closed.length > 0) {
      log.warn("runtime_sessions_closed", {
        runtimeId,
        reason,
        closedCount: closed.length,
        sessionIds: closed,
      });
    }
    return closed;
  };

  const handleMessage = (msg: ClientMessage, emit: EventEmitter, context?: RouterMessageContext): void => {
    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit) ?? null;
    log.debug("message_received", {
      connectionId,
      type: msg.type,
      sessionId: "sessionId" in msg ? msg.sessionId : null,
    });
    switch (msg.type) {
      case "session_new":
        return handleSessionNew(msg, emit, context);
      case "auth_proof":
        return handleAuthProof(msg, emit, context);
      case "prompt":
        return handlePrompt(msg, emit, context);
      case "session_list":
        return handleSessionList(msg, emit, context);
      case "cancel":
        return handleCancel(msg, emit, context);
      case "session_close":
        return handleSessionClose(msg, emit, context);
      case "approval_response":
        return handleApprovalResponse(msg, emit, context);
      case "session_replay":
        return handleSessionReplay(msg, emit, context);
      case "session_takeover":
        return handleSessionTakeover(msg, emit, context);
      case "session_transfer_request":
        return handleSessionTransferRequest(msg, emit, context);
      case "session_transfer_accept":
        return handleSessionTransferAccept(msg, emit, context);
      case "session_transfer_dismiss":
        return handleSessionTransferDismiss(msg, emit, context);
      case "memory_query":
        return handleMemoryQuery(msg, emit, context);
      case "usage_query":
        return handleUsageQuery(msg, emit, context);
    }
  };

  return {
    handleMessage,
    registerConnection,
    unregisterConnection,
    setRuntimeHealth,
    getRuntimeHealth,
    closeSessionsByRuntime,
    sweepIdleSessions,
  };
};
