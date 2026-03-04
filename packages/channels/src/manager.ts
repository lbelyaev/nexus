import type { ClientMessage, GatewayEvent, PrincipalType, PromptSource } from "@nexus/types";
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
  logger?: LoggerLike;
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

const formatChannelError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const isSessionNotFoundMessage = (message: string): boolean =>
  message.startsWith("Session not found:");

const DEFAULT_TYPING_INDICATOR = true;
const DEFAULT_STREAMING_MODE: ChannelStreamingMode = "off";
const DEFAULT_STEERING_MODE: ChannelSteeringMode = "off";
const STREAM_EDIT_FLUSH_MS = 350;
const TYPING_PULSE_MS = 4_000;

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

export const createChannelManager = (options: ChannelManagerOptions): ChannelManager => {
  const {
    gatewayUrl,
    token,
    adapters,
    reconnectDelayMs = 1_500,
    logger = createFallbackLogger(),
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
  const pendingPrompts = new Map<string, PendingPrompt>();
  const pendingApprovalsById = new Map<string, PendingApproval>();
  const runningTurns = new Set<string>();
  const cancelRequested = new Set<string>();
  const queuedSteers = new Map<string, ChannelInboundMessage>();

  let running = false;
  let startedAdapters = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSessionCreate: PendingSessionCreate | null = null;
  let creationLock: Promise<void> = Promise.resolve();

  const gatewayClient: GatewayClient = createGatewayClient(gatewayUrl, token);

  const conversationKeyOf = (adapterId: string, conversationId: string): string => `${adapterId}:${conversationId}`;

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

  const resolveBindingBySession = (sessionId: string): ConversationBinding | undefined => {
    const conversationKey = sessionToConversation.get(sessionId);
    if (!conversationKey) return undefined;
    return conversationBindings.get(conversationKey);
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

  const ensureSession = async (message: ChannelInboundMessage): Promise<string> => {
    const key = conversationKeyOf(message.adapterId, message.conversationId);
    const existing = conversationBindings.get(key);
    if (existing) return existing.sessionId;

    let createdSessionId = "";
    await enqueueSessionCreation(async () => {
      const route = routeByAdapter.get(message.adapterId) ?? {};
      const principalType: PrincipalType = route.principalType ?? "user";
      const rawPrincipalId = `${principalType}:${message.adapterId}:${message.senderId}`;
      const principalId = normalizePrincipalIdInput(rawPrincipalId, principalType);
      const source: PromptSource = route.source ?? "api";
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

      const binding: ConversationBinding = {
        sessionId: createdSessionId,
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        principalType,
        principalId,
        runtimeId: sessionMetadata?.runtimeId ?? route.runtimeId ?? "default",
        model: sessionMetadata?.model ?? route.model,
        workspaceId: sessionMetadata?.workspaceId ?? route.workspaceId ?? "default",
        typingIndicator,
        streamingMode,
        steeringMode,
        createdAt: new Date().toISOString(),
      };
      conversationBindings.set(key, binding);
      sessionToConversation.set(createdSessionId, key);

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

  const sendHelp = async (adapterId: string, conversationId: string): Promise<void> => {
    await sendToConversation(
      adapterId,
      conversationId,
      [
        "Nexus channel commands:",
        "/help",
        "/status",
        "/new",
        "/cancel",
        "/approve <requestId|all>",
        "/deny <requestId>",
      ].join("\n"),
    );
  };

  const handleCommand = async (message: ChannelInboundMessage): Promise<boolean> => {
    const text = message.text.trim();
    if (!text.startsWith("/")) return false;

    const [commandRaw, ...parts] = text.slice(1).split(/\s+/);
    const command = commandRaw?.toLowerCase() ?? "";
    const key = conversationKeyOf(message.adapterId, message.conversationId);
    const binding = conversationBindings.get(key);

    if (command === "help") {
      await sendHelp(message.adapterId, message.conversationId);
      return true;
    }

    if (command === "new") {
      if (binding) {
        clearSessionState(binding.sessionId);
      }
      await sendToConversation(message.adapterId, message.conversationId, "Started a new Nexus session for this conversation.");
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
            ].join("\n")
          : "No active session for this conversation. Send any prompt to create one.",
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
      const approvalsForSession = Array.from(pendingApprovalsById.values()).filter((approval) => approval.sessionId === binding.sessionId);
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
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        `Approved ${compactApprovalTool(pending.tool)}.`,
      );
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
      await sendToConversation(
        message.adapterId,
        message.conversationId,
        `Denied ${compactApprovalTool(pending.tool)}.`,
      );
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
        pendingApprovalsById.set(event.requestId, {
          sessionId: event.sessionId,
          requestId: event.requestId,
          tool: event.tool,
          adapterId: binding.adapterId,
          conversationId: binding.conversationId,
          allowOptionId: event.options?.find((opt) => opt.kind.startsWith("allow"))?.optionId,
          rejectOptionId: event.options?.find((opt) => opt.kind.startsWith("reject"))?.optionId,
        });
        const adapter = adapterById.get(binding.adapterId);
        const supportsQuickActions = adapter?.supportsQuickActions === true;
        const quickActions: ChannelQuickAction[] | undefined = supportsQuickActions
          ? [
              { label: "Approve", command: `/approve ${event.requestId}` },
              { label: "Deny", command: `/deny ${event.requestId}` },
            ]
          : undefined;
        const toolLabel = compactApprovalTool(event.tool);
        const text = supportsQuickActions
          ? `Approval required: ${toolLabel}\nTap Approve or Deny below.`
          : `Approval required for ${toolLabel}\nrequestId=${event.requestId}\nUse /approve ${event.requestId} or /deny ${event.requestId}`;
        await sendToConversation(
          binding.adapterId,
          binding.conversationId,
          text,
          quickActions,
        );
        stopTyping(event.sessionId);
        break;
      }
      case "error": {
        if (!event.sessionId) return;
        const conversationKey = sessionToConversation.get(event.sessionId);
        if (!conversationKey) return;
        const binding = conversationBindings.get(conversationKey);
        if (!binding) return;
        if (isSessionNotFoundMessage(event.message)) {
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
        await sendToConversation(binding.adapterId, binding.conversationId, `Error: ${event.message}`);
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
      const handled = await handleCommand(message);
      if (!handled) {
        await sendPromptOrSteer(message);
      }
    } catch (error) {
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
  });

  gatewayClient.onClose(() => {
    logger.warn("channel_gateway_closed");
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
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
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
