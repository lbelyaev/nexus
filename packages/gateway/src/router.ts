import type {
  ClientMessage,
  EventCorrelation,
  GatewayEvent,
  PolicyConfig,
  PrincipalType,
  PromptSource,
  RuntimeHealthInfo,
  RuntimeHealthStatus,
} from "@nexus/types";
import { estimateTokens } from "@nexus/types";
import { createHash } from "node:crypto";
import type { StateStore } from "@nexus/state";
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

export interface RouterDeps {
  createAcpSession: (
    runtimeId: string | undefined,
    model: string | undefined,
    onEvent: EventEmitter,
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
  sweepIdleSessions: (now?: Date) => string[];
}

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

const ensureSessionOwner = (
  sessionOwners: Map<string, EventEmitter>,
  sessionId: string,
  emit: EventEmitter,
): boolean => {
  const owner = sessionOwners.get(sessionId);
  if (!owner) {
    sessionOwners.set(sessionId, emit);
    return true;
  }
  return owner === emit;
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
  const sessionLastActivityMs = new Map<string, number>();
  const sessionInFlightTurns = new Map<string, number>();
  const sessionOwners = new Map<string, EventEmitter>();
  const requestToSession = new Map<string, {
    sessionId: string;
    turnId?: string;
    executionId?: string;
    policySnapshotId?: string;
  }>();
  const sessionIdempotency = new Map<string, Map<string, {
    state: "running" | "completed";
    turnId: string;
    executionId: string;
    completedAtMs?: number;
  }>>();
  const sessionToPendingRequests = new Map<string, Set<string>>();
  const activeConnections = new Map<string, EventEmitter>();
  const emitterConnectionIds = new WeakMap<EventEmitter, string>();
  const runtimeHealth = new Map<string, RuntimeHealthInfo>(Object.entries(initialRuntimeHealth));
  const log = createLogger("gateway.router");

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

  const trackPendingApproval = (
    sessionId: string,
    requestId: string,
    turnId?: string,
    executionId?: string,
    correlationPolicySnapshotId?: string,
  ): void => {
    requestToSession.set(requestId, {
      sessionId,
      turnId,
      executionId,
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
    sessionOwners.delete(sessionId);
    sessionLastActivityMs.delete(sessionId);
    sessionInFlightTurns.delete(sessionId);
    sessionIdempotency.delete(sessionId);
    clearSessionPendingApprovals(sessionId);

    try {
      session.cancel();
    } catch {
      // Best-effort cancel on close.
    }

    const nowIso = new Date().toISOString();
    try {
      stateStore.updateSession(sessionId, {
        status: "idle",
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
  ): Map<string, { state: "running" | "completed"; turnId: string; executionId: string; completedAtMs?: number }> => {
    const existing = sessionIdempotency.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, { state: "running" | "completed"; turnId: string; executionId: string; completedAtMs?: number }>();
    sessionIdempotency.set(sessionId, created);
    return created;
  };

  const pruneIdempotencyMap = (entries: Map<string, { state: "running" | "completed"; turnId: string; executionId: string; completedAtMs?: number }>): void => {
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
    const workspaceId = msg.workspaceId?.trim() || defaultWorkspaceId;
    const principalType: PrincipalType = msg.principalType ?? "user";
    const principalId = msg.principalId?.trim() || "user:local";
    const source: PromptSource = msg.source ?? "interactive";
    createAcpSession(msg.runtimeId, msg.model, emit).then(
      (acpSession) => {
        const sessionId = acpSession.id;
        const now = new Date().toISOString();

        stateStore.createSession({
          id: sessionId,
          workspaceId,
          principalType,
          principalId,
          source,
          runtimeId: acpSession.runtimeId,
          acpSessionId: acpSession.acpSessionId,
          status: "active",
          createdAt: now,
          lastActivityAt: now,
          tokenUsage: { input: 0, output: 0 },
          model: acpSession.model,
        });

        sessions.set(sessionId, acpSession);
        sessionWorkspaces.set(sessionId, workspaceId);
        sessionPrincipals.set(sessionId, { principalType, principalId, source });
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
      },
      (err: unknown) => {
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
      },
    );
  };

  const handlePrompt = (
    msg: Extract<ClientMessage, { type: "prompt" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: `Session not found: ${msg.sessionId}`,
      });
      return;
    }
    if (!ensureSessionOwner(sessionOwners, msg.sessionId, emit)) {
      emitSessionOwnershipError(emit, msg.sessionId);
      return;
    }

    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit) ?? null;
    const executionId = `exec-${msg.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const correlation: EventCorrelation = {
      executionId,
      turnId,
      policySnapshotId,
    };
    const principal = sessionPrincipals.get(msg.sessionId) ?? {
      principalType: "user" as const,
      principalId: "user:local",
      source: "interactive" as const,
    };
    const idempotencyKey = msg.idempotencyKey?.trim() || undefined;
    if (idempotencyKey) {
      const dedup = getOrCreateIdempotencyMap(msg.sessionId);
      pruneIdempotencyMap(dedup);
      const existing = dedup.get(idempotencyKey);
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
          turnId: existing.turnId,
          policySnapshotId,
        }));
        return;
      }
      dedup.set(idempotencyKey, {
        state: "running",
        turnId,
        executionId,
      });
    }

    log.info("prompt_received", {
      connectionId,
      sessionId: msg.sessionId,
      executionId,
      turnId,
      policySnapshotId,
      principalType: principal.principalType,
      principalId: principal.principalId,
      source: principal.source,
      idempotencyKey: idempotencyKey ?? null,
      textPreview: msg.text.slice(0, 50),
    });
    touchSession(msg.sessionId);
    const emitWithCorrelation: EventEmitter = (event) => {
      emit(withCorrelation(event, correlation));
    };

    // Record user prompt to transcript
    const workspaceId = sessionWorkspaces.get(msg.sessionId) ?? defaultWorkspaceId;
    stateStore.appendMessage({
      workspaceId,
      sessionId: msg.sessionId,
      role: "user",
      content: msg.text,
      timestamp: new Date().toISOString(),
      tokenEstimate: estimateTokens(msg.text),
    });

    // Wrap emit with recording layer to capture streaming events
    let sawStreamedText = false;
    let assistantMessageForTurn = "";
    let turnCompleted = false;
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
          turnCompleted = true;
          bumpInFlightTurns(msg.sessionId, -1);
        }
      },
      onTextDelta: () => {
        sawStreamedText = true;
      },
      onApprovalRequest: (requestId) => {
        trackPendingApproval(msg.sessionId, requestId, turnId, executionId, policySnapshotId);
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
          prompt: msg.text,
          scope: "hybrid",
        });
        if (context.rendered) {
          promptText = `${context.rendered}\n\n# User Prompt\n${msg.text}`;
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

    // Always bind prompt-time emitter so streaming events (approval/tool/text)
    // are delivered to the same client that initiated this prompt.
    session.onEvent(recordingEmitWithHooks);

    // ACP streaming events flow via session.onEvent → emit
    // prompt() resolves when the turn ends (PromptResponse with stopReason)
    session.prompt(promptText).then(
      (result) => {
        log.info("prompt_response", {
          connectionId,
          sessionId: msg.sessionId,
          runtimeId: session.runtimeId,
          executionId,
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
      },
      (err: unknown) => {
        if (idempotencyKey) {
          sessionIdempotency.get(msg.sessionId)?.delete(idempotencyKey);
        }
        if (!turnCompleted) {
          turnCompleted = true;
          bumpInFlightTurns(msg.sessionId, -1);
        }
        touchSession(msg.sessionId);
        log.error("prompt_failed", {
          connectionId,
          sessionId: msg.sessionId,
          runtimeId: session.runtimeId,
          executionId,
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

  const handleSessionList = (emit: EventEmitter): void => {
    emit({
      type: "session_list",
      sessions: stateStore.listSessions(),
    });
  };

  const handleCancel = (
    msg: Extract<ClientMessage, { type: "cancel" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    const session = sessions.get(msg.sessionId);
    if (!session) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: `Session not found: ${msg.sessionId}`,
      });
      return;
    }
    if (!ensureSessionOwner(sessionOwners, msg.sessionId, emit)) {
      emitSessionOwnershipError(emit, msg.sessionId);
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
    if (!ensureSessionOwner(sessionOwners, msg.sessionId, emit)) {
      emitSessionOwnershipError(emit, msg.sessionId);
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
      log.warn("approval_response_unknown_request", {
        connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
        requestId: msg.requestId,
      });
      emit({
        type: "error",
        sessionId: "",
        message: `No session found for approval request: ${msg.requestId}`,
      });
      return;
    }
    const sessionId = requestMeta.sessionId;
    const principal = sessionPrincipals.get(sessionId) ?? {
      principalType: "user" as const,
      principalId: "user:local",
      source: "interactive" as const,
    };

    if (!ensureSessionOwner(sessionOwners, sessionId, emit)) {
      emitSessionOwnershipError(emit, sessionId);
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      clearPendingApproval(sessionId, msg.requestId);
      emit({
        type: "error",
        sessionId,
        message: `Session not found: ${sessionId}`,
      });
      return;
    }

    const found = session.respondToPermission(msg.requestId, optionId);
    if (!found) {
      log.warn("approval_response_no_pending_permission", {
        connectionId: context?.connectionId ?? emitterConnectionIds.get(emit) ?? null,
        sessionId,
        turnId: requestMeta.turnId ?? null,
        requestId: msg.requestId,
      });
      emit({
        type: "error",
        sessionId,
        message: `No pending approval request: ${msg.requestId}`,
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
    if (!ensureSessionOwner(sessionOwners, msg.sessionId, emit)) {
      emitSessionOwnershipError(emit, msg.sessionId);
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

  const handleMemoryQuery = (
    msg: Extract<ClientMessage, { type: "memory_query" }>,
    emit: EventEmitter,
    context?: RouterMessageContext,
  ): void => {
    if (!memoryProvider) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: "Memory is not enabled for this gateway.",
      });
      return;
    }

    const session = sessions.get(msg.sessionId);
    if (!session) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: `Session not found: ${msg.sessionId}`,
      });
      return;
    }
    if (!ensureSessionOwner(sessionOwners, msg.sessionId, emit)) {
      emitSessionOwnershipError(emit, msg.sessionId);
      return;
    }
    touchSession(msg.sessionId);
    const workspaceId = sessionWorkspaces.get(msg.sessionId) ?? defaultWorkspaceId;
    const connectionId = context?.connectionId ?? emitterConnectionIds.get(emit) ?? null;

    const limit = Math.max(1, Math.min(50, Math.floor(msg.limit ?? 10)));
    const scope = msg.scope ?? "session";

    switch (msg.action) {
      case "stats": {
        const stats = memoryProvider.getStats({ workspaceId, sessionId: msg.sessionId, scope: scope === "workspace" ? "workspace" : "session" });
        emit({
          type: "memory_result",
          sessionId: msg.sessionId,
          action: "stats",
          scope: scope === "workspace" ? "workspace" : "session",
          stats,
        });
        log.debug("memory_query_stats", {
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
          type: "memory_result",
          sessionId: msg.sessionId,
          action: "recent",
          scope: scope === "workspace" ? "workspace" : "session",
          limit,
          items,
        });
        log.debug("memory_query_recent", {
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
          type: "memory_result",
          sessionId: msg.sessionId,
          action: "search",
          scope: scope === "workspace" ? "workspace" : "session",
          query,
          limit,
          items,
        });
        log.debug("memory_query_search", {
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
          type: "memory_result",
          sessionId: msg.sessionId,
          action: "context",
          scope: contextScope === "workspace" || contextScope === "session" || contextScope === "hybrid"
            ? contextScope
            : "hybrid",
          prompt,
          context,
        });
        log.debug("memory_query_context", {
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
        const deleted = memoryProvider.clear({ workspaceId, sessionId: msg.sessionId, scope: effectiveScope });
        emit({
          type: "memory_result",
          sessionId: msg.sessionId,
          action: "clear",
          scope: effectiveScope,
          deleted,
        });
        log.info("memory_query_clear", {
          connectionId,
          sessionId: msg.sessionId,
          scope: effectiveScope,
          deleted,
        });
        return;
      }
    }
  };

  const registerConnection = (connectionId: string, emit: EventEmitter): void => {
    activeConnections.set(connectionId, emit);
    emitterConnectionIds.set(emit, connectionId);
    for (const runtime of listRuntimeHealth()) {
      emitRuntimeHealth(emit, runtime);
    }
    log.info("connection_registered", { connectionId });
  };

  const unregisterConnection = (connectionId: string, emit: EventEmitter): void => {
    activeConnections.delete(connectionId);
    emitterConnectionIds.delete(emit);

    const released: string[] = [];
    for (const [sessionId, owner] of sessionOwners) {
      if (owner === emit) {
        sessionOwners.delete(sessionId);
        released.push(sessionId);
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
      case "prompt":
        return handlePrompt(msg, emit, context);
      case "session_list":
        return handleSessionList(emit);
      case "cancel":
        return handleCancel(msg, emit, context);
      case "session_close":
        return handleSessionClose(msg, emit, context);
      case "approval_response":
        return handleApprovalResponse(msg, emit, context);
      case "session_replay":
        return handleSessionReplay(msg, emit, context);
      case "memory_query":
        return handleMemoryQuery(msg, emit, context);
    }
  };

  return {
    handleMessage,
    registerConnection,
    unregisterConnection,
    setRuntimeHealth,
    getRuntimeHealth,
    sweepIdleSessions,
  };
};
