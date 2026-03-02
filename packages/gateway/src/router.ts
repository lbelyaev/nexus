import type {
  ClientMessage,
  GatewayEvent,
  PolicyConfig,
} from "@nexus/types";
import type { StateStore } from "@nexus/state";
import type { AcpSession } from "@nexus/acp-bridge";

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

export const createRouter = (deps: RouterDeps): Router => {
  const { createAcpSession, stateStore, policyConfig } = deps;
  const sessions = new Map<string, ManagedAcpSession>();

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
    console.log(`[router] handlePrompt: sessionId=${msg.sessionId}, text=${msg.text.slice(0, 50)}`);
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

    // Always bind prompt-time emitter so streaming events (approval/tool/text)
    // are delivered to the same client that initiated this prompt.
    session.onEvent(emit);

    // ACP streaming events flow via session.onEvent → emit
    // prompt() resolves when the turn ends (PromptResponse with stopReason)
    session.prompt(msg.text).then(
      (result) => {
        console.log(`[router] Prompt response: ${JSON.stringify(result ?? null).slice(0, 500)}`);
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
            if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
              emit({
                type: "text_delta",
                sessionId: msg.sessionId,
                delta: b.text,
              });
            }
          }
        } catch (contentErr) {
          console.error(`[router] Error extracting prompt response content:`, contentErr);
        }

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
  };

  const handleApprovalResponse = (
    msg: Extract<ClientMessage, { type: "approval_response" }>,
    emit: EventEmitter,
  ): void => {
    console.log(`[router] Received approval_response: requestId=${msg.requestId}, allow=${String(msg.allow)}, optionId=${msg.optionId ?? "<none>"}`);
    console.log(`[router] Active sessions: ${sessions.size}`);

    const allow = msg.allow ?? msg.optionId?.startsWith("allow_") ?? false;
    const optionId =
      msg.optionId
      ?? (allow ? "allow_once" : "reject_once");

    // Search all sessions for the one with the matching pending permission
    for (const session of sessions.values()) {
      const found = session.respondToPermission(msg.requestId, optionId);
      if (found) {
        stateStore.logEvent({
          sessionId: session.id,
          timestamp: new Date().toISOString(),
          type: allow ? "approval" : "deny",
          detail: `requestId=${msg.requestId}`,
        });
        return;
      }
    }

    console.log(`[router] No session found with pending permission for requestId=${msg.requestId}`);
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
