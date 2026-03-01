import type {
  ClientMessage,
  GatewayEvent,
  PolicyConfig,
} from "@nexus/types";
import type { StateStore } from "@nexus/state";
import type { AcpSession } from "@nexus/acp-bridge";

export type EventEmitter = (event: GatewayEvent) => void;

export interface RouterDeps {
  createAcpSession: (onEvent: EventEmitter) => Promise<AcpSession>;
  stateStore: StateStore;
  policyConfig: PolicyConfig;
}

export interface Router {
  handleMessage: (msg: ClientMessage, emit: EventEmitter) => void;
}

export const createRouter = (deps: RouterDeps): Router => {
  const { createAcpSession, stateStore, policyConfig } = deps;
  const sessions = new Map<string, AcpSession>();

  const handleSessionNew = (
    msg: Extract<ClientMessage, { type: "session_new" }>,
    emit: EventEmitter,
  ): void => {
    createAcpSession(emit).then(
      (acpSession) => {
        const sessionId = acpSession.id;
        const now = new Date().toISOString();

        stateStore.createSession({
          id: sessionId,
          runtimeId: msg.runtimeId ?? "default",
          acpSessionId: acpSession.acpSessionId,
          status: "active",
          createdAt: now,
          lastActivityAt: now,
          tokenUsage: { input: 0, output: 0 },
          model: "claude",
        });

        sessions.set(sessionId, acpSession);
        emit({ type: "session_created", sessionId, model: "claude" });
      },
      (err: unknown) => {
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
    const session = sessions.get(msg.sessionId);
    if (!session) {
      emit({
        type: "error",
        sessionId: msg.sessionId,
        message: `Session not found: ${msg.sessionId}`,
      });
      return;
    }

    stateStore.updateSession(msg.sessionId, {
      lastActivityAt: new Date().toISOString(),
    });

    // ACP streaming events flow via session.onEvent → emit
    // prompt() resolves when the turn ends (PromptResponse with stopReason)
    session.prompt(msg.text).then(
      (result) => {
        const r = result as { stopReason?: string } | undefined;
        emit({
          type: "turn_end",
          sessionId: msg.sessionId,
          stopReason: r?.stopReason ?? "end_turn",
        });
      },
      (err: unknown) => {
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

    session.cancel();

    emit({
      type: "turn_end",
      sessionId: msg.sessionId,
      stopReason: "cancelled",
    });
  };

  const handleApprovalResponse = (
    msg: Extract<ClientMessage, { type: "approval_response" }>,
    emit: EventEmitter,
  ): void => {
    for (const session of sessions.values()) {
      const optionId = msg.allow ? "allow_once" : "reject_once";
      session.respondToPermission(msg.requestId, optionId);

      stateStore.logEvent({
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        type: msg.allow ? "approval" : "deny",
        detail: `requestId=${msg.requestId}`,
      });
      return;
    }

    emit({
      type: "error",
      sessionId: "",
      message: `No session found for approval request: ${msg.requestId}`,
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
    }
  };

  return { handleMessage };
};
