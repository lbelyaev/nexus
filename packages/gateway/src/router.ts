import type {
  ClientMessage,
  GatewayEvent,
  PolicyConfig,
} from "@nexus/types";
import { estimateTokens } from "@nexus/types";
import type { StateStore } from "@nexus/state";
import type { AcpSession } from "@nexus/acp-bridge";
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
}

export interface Router {
  handleMessage: (msg: ClientMessage, emit: EventEmitter) => void;
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
  if (!owner) return true;
  return owner === emit;
};

/**
 * Wraps an event emitter to record streaming events into the transcript store.
 * Accumulates text_delta chunks and flushes a single assistant message at turn_end.
 */
export const createRecordingEmitter = (
  sessionId: string,
  stateStore: StateStore,
  downstream: EventEmitter,
  options?: {
    onTextDelta?: () => void;
    onApprovalRequest?: (requestId: string) => void;
  },
): EventEmitter => {
  let assistantBuffer = "";

  return (event: GatewayEvent) => {
    switch (event.type) {
      case "text_delta":
        assistantBuffer += event.delta;
        options?.onTextDelta?.();
        break;
      case "tool_start":
        {
          const content = safeStringify(event.params);
          stateStore.appendMessage({
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
          stateStore.appendMessage({
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
  const { createAcpSession, stateStore, policyConfig } = deps;
  const sessions = new Map<string, ManagedAcpSession>();
  const sessionOwners = new Map<string, EventEmitter>();
  const requestToSessionId = new Map<string, string>();
  const sessionToPendingRequests = new Map<string, Set<string>>();
  const log = createLogger("gateway.router");

  const trackPendingApproval = (sessionId: string, requestId: string): void => {
    requestToSessionId.set(requestId, sessionId);
    const pending = sessionToPendingRequests.get(sessionId) ?? new Set<string>();
    pending.add(requestId);
    sessionToPendingRequests.set(sessionId, pending);
  };

  const clearPendingApproval = (sessionId: string, requestId: string): void => {
    requestToSessionId.delete(requestId);
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
      requestToSessionId.delete(requestId);
    }
    sessionToPendingRequests.delete(sessionId);
  };

  const handleSessionNew = (
    msg: Extract<ClientMessage, { type: "session_new" }>,
    emit: EventEmitter,
  ): void => {
    createAcpSession(msg.runtimeId, msg.model, emit).then(
      (acpSession) => {
        const sessionId = acpSession.id;
        const now = new Date().toISOString();

        stateStore.createSession({
          id: sessionId,
          runtimeId: acpSession.runtimeId,
          acpSessionId: acpSession.acpSessionId,
          status: "active",
          createdAt: now,
          lastActivityAt: now,
          tokenUsage: { input: 0, output: 0 },
          model: acpSession.model,
        });

        sessions.set(sessionId, acpSession);
        sessionOwners.set(sessionId, emit);
        emit({
          type: "session_created",
          sessionId,
          model: acpSession.model,
          runtimeId: acpSession.runtimeId,
          modelRouting: acpSession.modelRouting,
          modelAliases: acpSession.modelAliases,
          modelCatalog: acpSession.modelCatalog,
          runtimeDefaults: acpSession.runtimeDefaults,
        });
      },
      (err: unknown) => {
        log.error("session_create_failed", {
          runtimeId: msg.runtimeId ?? null,
          model: msg.model ?? null,
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
  ): void => {
    log.info("prompt_received", {
      sessionId: msg.sessionId,
      textPreview: msg.text.slice(0, 50),
    });
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

    stateStore.updateSession(msg.sessionId, {
      lastActivityAt: new Date().toISOString(),
    });

    // Record user prompt to transcript
    stateStore.appendMessage({
      sessionId: msg.sessionId,
      role: "user",
      content: msg.text,
      timestamp: new Date().toISOString(),
      tokenEstimate: estimateTokens(msg.text),
    });

    // Wrap emit with recording layer to capture streaming events
    let sawStreamedText = false;
    const recordingEmitWithHooks = createRecordingEmitter(msg.sessionId, stateStore, emit, {
      onTextDelta: () => {
        sawStreamedText = true;
      },
      onApprovalRequest: (requestId) => {
        trackPendingApproval(msg.sessionId, requestId);
      },
    });

    // Always bind prompt-time emitter so streaming events (approval/tool/text)
    // are delivered to the same client that initiated this prompt.
    session.onEvent(recordingEmitWithHooks);

    // ACP streaming events flow via session.onEvent → emit
    // prompt() resolves when the turn ends (PromptResponse with stopReason)
    session.prompt(msg.text).then(
      (result) => {
        log.info("prompt_response", {
          sessionId: msg.sessionId,
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
            sessionId: msg.sessionId,
            error: contentErr instanceof Error ? contentErr.message : String(contentErr),
          });
        }

        recordingEmitWithHooks({
          type: "turn_end",
          sessionId: msg.sessionId,
          stopReason: r?.stopReason ?? "end_turn",
        });
      },
      (err: unknown) => {
        log.error("prompt_failed", {
          sessionId: msg.sessionId,
          error: err instanceof Error ? err.message : "Unknown error",
        });
        emit({
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
    clearSessionPendingApprovals(msg.sessionId);
  };

  const handleApprovalResponse = (
    msg: Extract<ClientMessage, { type: "approval_response" }>,
    emit: EventEmitter,
  ): void => {
    const allow = msg.allow ?? msg.optionId?.startsWith("allow_") ?? false;
    const optionId =
      msg.optionId
      ?? (allow ? "allow_once" : "reject_once");

    const sessionId = requestToSessionId.get(msg.requestId);
    if (!sessionId) {
      log.warn("approval_response_unknown_request", {
        requestId: msg.requestId,
      });
      emit({
        type: "error",
        sessionId: "",
        message: `No session found for approval request: ${msg.requestId}`,
      });
      return;
    }

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
        sessionId,
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
    stateStore.logEvent({
      sessionId,
      timestamp: new Date().toISOString(),
      type: allow ? "approval" : "deny",
      detail: `requestId=${msg.requestId}`,
    });
  };

  const handleSessionReplay = (
    msg: Extract<ClientMessage, { type: "session_replay" }>,
    emit: EventEmitter,
  ): void => {
    if (!ensureSessionOwner(sessionOwners, msg.sessionId, emit)) {
      emitSessionOwnershipError(emit, msg.sessionId);
      return;
    }
    const messages = stateStore.getTranscript(msg.sessionId);
    emit({
      type: "transcript",
      sessionId: msg.sessionId,
      messages,
    });
  };

  const handleMessage = (msg: ClientMessage, emit: EventEmitter): void => {
    switch (msg.type) {
      case "session_new":
        return handleSessionNew(msg, emit);
      case "prompt":
        return handlePrompt(msg, emit);
      case "session_list":
        return handleSessionList(emit);
      case "cancel":
        return handleCancel(msg, emit);
      case "approval_response":
        return handleApprovalResponse(msg, emit);
      case "session_replay":
        return handleSessionReplay(msg, emit);
    }
  };

  return { handleMessage };
};
