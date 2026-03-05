import { useState, useCallback, useRef, useEffect } from "react";
import type { ClientMessage, GatewayEvent, PromptImageInput, TranscriptMessage } from "@nexus/types";

export interface ActiveTool {
  tool: string;
  toolCallId?: string;
  params: unknown;
}

export interface ToolCall {
  tool: string;
  toolCallId?: string;
  params: unknown;
  status: "running" | "completed" | "failed";
}

export interface UsageQueryInput {
  action?: "summary" | "stats" | "recent" | "search" | "context" | "clear";
  scope?: "session" | "workspace" | "hybrid";
  query?: string;
  prompt?: string;
  limit?: number;
}

export interface SessionListRequestInput {
  limit?: number;
  cursor?: string;
}

export type UsageResultEvent = Extract<GatewayEvent, { type: "usage_result" }>;
export type SessionTransferRequestedEvent = Extract<GatewayEvent, { type: "session_transfer_requested" }>;
export type SessionListEvent = Extract<GatewayEvent, { type: "session_list" }>;

const createToolMatcher = (
  event: Extract<GatewayEvent, { type: "tool_end" }>,
  running: Array<{ tool: string; toolCallId?: string; status?: "running" | "completed" | "failed" }>,
): ((tool: { tool: string; toolCallId?: string }) => boolean) => {
  if (event.toolCallId) {
    return (tool) => tool.toolCallId === event.toolCallId;
  }

  const runningByName = running.filter((tool) => tool.tool === event.tool);
  if (runningByName.length > 0) {
    return (tool) => tool.tool === event.tool;
  }

  // Some ACP runtimes do not preserve tool name consistency on tool_end.
  // If only one tool is running, treat tool_end as completion for that tool.
  const runningTools = running.filter((tool) => tool.status === undefined || tool.status === "running");
  if (runningTools.length === 1) {
    const loneId = runningTools[0].toolCallId;
    return (tool) => (loneId ? tool.toolCallId === loneId : tool.tool === runningTools[0].tool);
  }

  return () => false;
};

export interface UseSessionResult {
  sessionId: string | null;
  sessionModel: string | null;
  sessionRuntimeId: string | null;
  sessionWorkspaceId: string | null;
  sessionPrincipalType: "user" | "service_account" | null;
  sessionPrincipalId: string | null;
  sessionSource: "interactive" | "schedule" | "hook" | "api" | null;
  modelRouting: Record<string, string>;
  modelAliases: Record<string, string>;
  modelCatalog: Record<string, string[]>;
  runtimeDefaults: Record<string, string>;
  runtimeHealth: Record<string, { status: "starting" | "healthy" | "degraded" | "unavailable"; updatedAt: string; reason?: string }>;
  authStatus: "unverified" | "verifying" | "verified" | "failed";
  authPrincipalType: "user" | "service_account" | null;
  authPrincipalId: string | null;
  pendingSessionTransfers: SessionTransferRequestedEvent[];
  sessionList: SessionListEvent["sessions"];
  sessionListHasMore: boolean;
  sessionListNextCursor: string | null;
  responseText: string;
  thinkingText: string;
  isStreaming: boolean;
  activeTools: ActiveTool[];
  toolCalls: ToolCall[];
  transcript: TranscriptMessage[];
  usageResults: UsageResultEvent[];
  error: string | null;
  sendPrompt: (text: string, images?: PromptImageInput[]) => void;
  steer: (text: string) => void;
  cancel: () => void;
  closeSession: () => void;
  requestReplay: (sessionId: string) => void;
  requestSessionList: (request?: SessionListRequestInput) => void;
  resumeSession: (sessionId: string) => void;
  requestSessionTransfer: (
    targetPrincipalId: string,
    targetPrincipalType?: "user" | "service_account",
    expiresInMs?: number,
    sessionId?: string,
  ) => void;
  acceptSessionTransfer: (sessionId?: string) => void;
  dismissPendingSessionTransfer: (sessionId?: string) => void;
  requestUsage: (query: UsageQueryInput) => void;
  handleEvent: (event: GatewayEvent) => void;
}

export const useSession = (
  sendMessage: (msg: ClientMessage) => void,
): UseSessionResult => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [sessionRuntimeId, setSessionRuntimeId] = useState<string | null>(null);
  const [sessionWorkspaceId, setSessionWorkspaceId] = useState<string | null>(null);
  const [sessionPrincipalType, setSessionPrincipalType] = useState<"user" | "service_account" | null>(null);
  const [sessionPrincipalId, setSessionPrincipalId] = useState<string | null>(null);
  const [sessionSource, setSessionSource] = useState<"interactive" | "schedule" | "hook" | "api" | null>(null);
  const sessionPrincipalTypeRef = useRef(sessionPrincipalType);
  const sessionPrincipalIdRef = useRef(sessionPrincipalId);
  const sessionSourceRef = useRef(sessionSource);
  const [modelRouting, setModelRouting] = useState<Record<string, string>>({});
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({});
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({});
  const [runtimeDefaults, setRuntimeDefaults] = useState<Record<string, string>>({});
  const [runtimeHealth, setRuntimeHealth] = useState<Record<string, { status: "starting" | "healthy" | "degraded" | "unavailable"; updatedAt: string; reason?: string }>>({});
  const [authStatus, setAuthStatus] = useState<"unverified" | "verifying" | "verified" | "failed">("unverified");
  const [authPrincipalType, setAuthPrincipalType] = useState<"user" | "service_account" | null>(null);
  const [authPrincipalId, setAuthPrincipalId] = useState<string | null>(null);
  const authStatusRef = useRef(authStatus);
  const authPrincipalTypeRef = useRef(authPrincipalType);
  const authPrincipalIdRef = useRef(authPrincipalId);
  const [pendingSessionTransfers, setPendingSessionTransfers] = useState<SessionTransferRequestedEvent[]>([]);
  const [sessionList, setSessionList] = useState<SessionListEvent["sessions"]>([]);
  const [sessionListHasMore, setSessionListHasMore] = useState(false);
  const [sessionListNextCursor, setSessionListNextCursor] = useState<string | null>(null);
  const sessionListRef = useRef<SessionListEvent["sessions"]>([]);
  const [responseText, setResponseText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [usageResults, setUsageResults] = useState<UsageResultEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const queuedSteerRef = useRef<string | null>(null);
  const ignoreCancelledTurnEndRef = useRef(false);

  // Buffer text/thinking deltas to reduce re-renders during fast streaming.
  // Deltas accumulate in refs and flush to state every FLUSH_INTERVAL_MS.
  const FLUSH_INTERVAL_MS = 50;
  const textBufferRef = useRef("");
  const thinkingBufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushBuffers = useCallback(() => {
    flushTimerRef.current = null;
    if (textBufferRef.current) {
      const chunk = textBufferRef.current;
      textBufferRef.current = "";
      setResponseText((prev) => prev + chunk);
    }
    if (thinkingBufferRef.current) {
      const chunk = thinkingBufferRef.current;
      thinkingBufferRef.current = "";
      setThinkingText((prev) => prev + chunk);
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushBuffers, FLUSH_INTERVAL_MS);
    }
  }, [flushBuffers]);

  // Clean up flush timer on unmount
  useEffect(() => () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  useEffect(() => {
    authStatusRef.current = authStatus;
    authPrincipalTypeRef.current = authPrincipalType;
    authPrincipalIdRef.current = authPrincipalId;
  }, [authPrincipalId, authPrincipalType, authStatus]);

  useEffect(() => {
    sessionPrincipalTypeRef.current = sessionPrincipalType;
    sessionPrincipalIdRef.current = sessionPrincipalId;
    sessionSourceRef.current = sessionSource;
  }, [sessionPrincipalId, sessionPrincipalType, sessionSource]);

  useEffect(() => {
    sessionListRef.current = sessionList;
  }, [sessionList]);

  const sendPromptInternal = useCallback(
    (text: string, images?: PromptImageInput[]) => {
      if (!sessionId) return;
      // Clear buffers and state
      textBufferRef.current = "";
      thinkingBufferRef.current = "";
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      setResponseText("");
      setThinkingText("");
      setActiveTools([]);
      setToolCalls([]);
      setError(null);
      setIsStreaming(true);
      sendMessage({
        type: "prompt",
        sessionId,
        text,
        ...(images && images.length > 0 ? { images } : {}),
      });
    },
    [sessionId, sendMessage],
  );

  const handleEvent = useCallback((event: GatewayEvent) => {
    switch (event.type) {
      case "session_created":
        queuedSteerRef.current = null;
        ignoreCancelledTurnEndRef.current = false;
        textBufferRef.current = "";
        thinkingBufferRef.current = "";
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        setResponseText("");
        setThinkingText("");
        setIsStreaming(false);
        setActiveTools([]);
        setToolCalls([]);
        setError(null);
        setSessionId(event.sessionId);
        setSessionModel(event.model);
        setSessionRuntimeId(event.runtimeId ?? null);
        setSessionWorkspaceId(event.workspaceId ?? "default");
        {
          const createdPrincipalType = event.principalType ?? "user";
          const createdPrincipalId = event.principalId ?? "user:local";
          const shouldUseAuthenticatedPrincipal =
            authStatusRef.current === "verified"
            && authPrincipalIdRef.current !== null
            && authPrincipalTypeRef.current !== null
            && createdPrincipalType === "user"
            && createdPrincipalId === "user:local"
            && (event.source === undefined || event.source === "interactive");
          if (shouldUseAuthenticatedPrincipal) {
            sessionPrincipalTypeRef.current = authPrincipalTypeRef.current;
            sessionPrincipalIdRef.current = authPrincipalIdRef.current;
            setSessionPrincipalType(authPrincipalTypeRef.current);
            setSessionPrincipalId(authPrincipalIdRef.current);
          } else {
            sessionPrincipalTypeRef.current = createdPrincipalType;
            sessionPrincipalIdRef.current = createdPrincipalId;
            setSessionPrincipalType(createdPrincipalType);
            setSessionPrincipalId(createdPrincipalId);
          }
        }
        sessionSourceRef.current = event.source ?? "interactive";
        setSessionSource(event.source ?? "interactive");
        setModelRouting(event.modelRouting ?? {});
        setModelAliases(event.modelAliases ?? {});
        setModelCatalog(event.modelCatalog ?? {});
        setRuntimeDefaults(event.runtimeDefaults ?? {});
        setPendingSessionTransfers([]);
        break;
      case "session_closed":
        if (event.sessionId === sessionId) {
          queuedSteerRef.current = null;
          ignoreCancelledTurnEndRef.current = false;
          textBufferRef.current = "";
          thinkingBufferRef.current = "";
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          setSessionId(null);
          setSessionModel(null);
          setSessionRuntimeId(null);
          setSessionWorkspaceId(null);
          sessionPrincipalTypeRef.current = null;
          sessionPrincipalIdRef.current = null;
          sessionSourceRef.current = null;
          setSessionPrincipalType(null);
          setSessionPrincipalId(null);
          setSessionSource(null);
          setResponseText("");
          setThinkingText("");
          setIsStreaming(false);
          setActiveTools([]);
          setToolCalls([]);
          setError(null);
        }
        setPendingSessionTransfers((prev) => prev.filter((transfer) => transfer.sessionId !== event.sessionId));
        break;
      case "session_invalidated":
        if (event.sessionId !== sessionId) break;
        queuedSteerRef.current = null;
        ignoreCancelledTurnEndRef.current = false;
        textBufferRef.current = "";
        thinkingBufferRef.current = "";
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        setResponseText("");
        setThinkingText("");
        setIsStreaming(false);
        setActiveTools([]);
        setToolCalls((prev) => prev.map((tool) => (
          tool.status === "running" ? { ...tool, status: "failed" } : tool
        )));
        setError(event.message);
        break;
      case "runtime_health":
        setRuntimeHealth((prev) => ({
          ...prev,
          [event.runtime.runtimeId]: {
            status: event.runtime.status,
            updatedAt: event.runtime.updatedAt,
            ...(event.runtime.reason ? { reason: event.runtime.reason } : {}),
          },
        }));
        break;
      case "auth_challenge":
        setAuthStatus("verifying");
        authStatusRef.current = "verifying";
        break;
      case "auth_result":
        if (event.ok) {
          setAuthStatus("verified");
          const nextType = event.principalType ?? "user";
          const nextId = event.principalId ?? null;
          authStatusRef.current = "verified";
          authPrincipalTypeRef.current = nextType;
          authPrincipalIdRef.current = nextId;
          setAuthPrincipalType(nextType);
          setAuthPrincipalId(nextId);
          if (
            nextId
            && sessionPrincipalTypeRef.current === "user"
            && sessionPrincipalIdRef.current === "user:local"
            && (sessionSourceRef.current === null || sessionSourceRef.current === "interactive")
          ) {
            sessionPrincipalTypeRef.current = nextType;
            sessionPrincipalIdRef.current = nextId;
            setSessionPrincipalType(nextType);
            setSessionPrincipalId(nextId);
          }
          if (nextId) {
            setPendingSessionTransfers((prev) => prev.filter((transfer) => (
              transfer.targetPrincipalType === nextType
              && transfer.targetPrincipalId === nextId
            )));
          } else {
            setPendingSessionTransfers([]);
          }
        } else {
          setAuthStatus("failed");
          authStatusRef.current = "failed";
        }
        break;
      case "session_transfer_requested":
        if (
          authStatusRef.current === "verified"
          && authPrincipalIdRef.current !== null
          && authPrincipalTypeRef.current !== null
          && (
            event.targetPrincipalId !== authPrincipalIdRef.current
            || event.targetPrincipalType !== authPrincipalTypeRef.current
          )
        ) {
          break;
        }
        setPendingSessionTransfers((prev) => {
          const existingIndex = prev.findIndex((transfer) => transfer.sessionId === event.sessionId);
          if (existingIndex >= 0) {
            const next = [...prev];
            next[existingIndex] = event;
            return next;
          }
          return [...prev, event];
        });
        break;
      case "session_transferred": {
        setPendingSessionTransfers((prev) => prev.filter((transfer) => transfer.sessionId !== event.sessionId));
        const isTarget =
          authStatusRef.current === "verified"
          && authPrincipalIdRef.current !== null
          && authPrincipalTypeRef.current !== null
          && event.targetPrincipalId === authPrincipalIdRef.current
          && event.targetPrincipalType === authPrincipalTypeRef.current;
        const isSource =
          authStatusRef.current === "verified"
          && authPrincipalIdRef.current !== null
          && authPrincipalTypeRef.current !== null
          && event.fromPrincipalId === authPrincipalIdRef.current
          && event.fromPrincipalType === authPrincipalTypeRef.current;

        if (isTarget) {
          queuedSteerRef.current = null;
          ignoreCancelledTurnEndRef.current = false;
          textBufferRef.current = "";
          thinkingBufferRef.current = "";
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          setResponseText("");
          setThinkingText("");
          setIsStreaming(false);
          setActiveTools([]);
          setToolCalls([]);
          setError(null);
          setSessionId(event.sessionId);
          sessionPrincipalTypeRef.current = event.targetPrincipalType;
          sessionPrincipalIdRef.current = event.targetPrincipalId;
          sessionSourceRef.current = "interactive";
          setSessionPrincipalType(event.targetPrincipalType);
          setSessionPrincipalId(event.targetPrincipalId);
          setSessionSource("interactive");
          sendMessage({ type: "session_replay", sessionId: event.sessionId });
        } else if (isSource && sessionId === event.sessionId) {
          // Session ownership moved away from this client; detach local active session pointer.
          queuedSteerRef.current = null;
          ignoreCancelledTurnEndRef.current = false;
          textBufferRef.current = "";
          thinkingBufferRef.current = "";
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          setSessionId(null);
          setSessionModel(null);
          setSessionRuntimeId(null);
          setSessionWorkspaceId(null);
          sessionPrincipalTypeRef.current = null;
          sessionPrincipalIdRef.current = null;
          sessionSourceRef.current = null;
          setSessionPrincipalType(null);
          setSessionPrincipalId(null);
          setSessionSource(null);
          setResponseText("");
          setThinkingText("");
          setIsStreaming(false);
          setActiveTools([]);
          setToolCalls([]);
        }
        break;
      }
      case "text_delta":
        ignoreCancelledTurnEndRef.current = false;
        textBufferRef.current += event.delta;
        scheduleFlush();
        break;
      case "thinking_delta":
        ignoreCancelledTurnEndRef.current = false;
        thinkingBufferRef.current += event.delta;
        scheduleFlush();
        break;
      case "turn_end": {
        if (queuedSteerRef.current && sessionId && event.sessionId === sessionId) {
          const steerText = queuedSteerRef.current;
          queuedSteerRef.current = null;
          // Some runtimes can surface an extra cancelled turn_end from the previous turn
          // after we have already reprompted. Ignore that stale cancel completion once.
          ignoreCancelledTurnEndRef.current = true;
          sendPromptInternal(steerText);
          break;
        }

        if (
          ignoreCancelledTurnEndRef.current
          && event.sessionId === sessionId
          && event.stopReason === "cancelled"
        ) {
          break;
        }

        ignoreCancelledTurnEndRef.current = false;
        // Flush any remaining buffered text before ending the turn
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushBuffers();
        setIsStreaming(false);
        break;
      }
      case "tool_start":
        ignoreCancelledTurnEndRef.current = false;
        setActiveTools((prev) => [
          ...prev,
          { tool: event.tool, toolCallId: event.toolCallId, params: event.params },
        ]);
        setToolCalls((prev) => [
          ...prev,
          { tool: event.tool, toolCallId: event.toolCallId, params: event.params, status: "running" },
        ]);
        break;
      case "tool_end": {
        ignoreCancelledTurnEndRef.current = false;
        setActiveTools((prev) => {
          const matchTool = createToolMatcher(event, prev);
          return prev.filter((t) => !matchTool(t));
        });
        setToolCalls((prev) => {
          const matchTool = createToolMatcher(event, prev);
          return prev.map((tc) =>
            matchTool(tc) && tc.status === "running"
              ? { ...tc, status: "completed" }
              : tc,
          );
        });
        break;
      }
      case "transcript":
        setTranscript(event.messages);
        setSessionId(event.sessionId);
        {
          const match = sessionListRef.current.find((session) => session.id === event.sessionId);
          if (match) {
            setSessionModel(match.model);
            setSessionWorkspaceId(match.workspaceId ?? "default");
            if (match.principalType) {
              sessionPrincipalTypeRef.current = match.principalType;
              setSessionPrincipalType(match.principalType);
            }
            if (match.principalId) {
              sessionPrincipalIdRef.current = match.principalId;
              setSessionPrincipalId(match.principalId);
            }
            if (match.source) {
              sessionSourceRef.current = match.source;
              setSessionSource(match.source);
            }
          }
        }
        break;
      case "session_list":
        setSessionList(event.sessions);
        setSessionListHasMore(event.hasMore ?? false);
        setSessionListNextCursor(event.nextCursor ?? null);
        break;
      case "usage_result":
        setUsageResults((prev) => [...prev, event]);
        break;
      case "memory_result":
        setUsageResults((prev) => [...prev, { ...event, type: "usage_result" }]);
        break;
      case "error":
        ignoreCancelledTurnEndRef.current = false;
        queuedSteerRef.current = null;
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushBuffers();
        setIsStreaming(false);
        setActiveTools([]);
        setToolCalls((prev) => prev.map((tool) => (
          tool.status === "running" ? { ...tool, status: "failed" } : tool
        )));
        setError(event.message);
        break;
    }
  }, [
    flushBuffers,
    scheduleFlush,
    sendMessage,
    sendPromptInternal,
    sessionId,
  ]);

  const sendPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      sendPromptInternal(trimmed);
    },
    [sendPromptInternal],
  );

  const steer = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId) return;

      if (!isStreaming) {
        sendPromptInternal(trimmed);
        return;
      }

      const hadQueuedSteer = queuedSteerRef.current !== null;
      queuedSteerRef.current = trimmed;

      if (!hadQueuedSteer) {
        sendMessage({ type: "cancel", sessionId });
      }
    },
    [isStreaming, sendMessage, sendPromptInternal, sessionId],
  );

  const requestReplay = useCallback(
    (sid: string) => {
      sendMessage({ type: "session_replay", sessionId: sid });
    },
    [sendMessage],
  );

  const requestSessionList = useCallback(
    (request?: SessionListRequestInput) => {
      sendMessage({
        type: "session_list",
        ...(request?.limit !== undefined ? { limit: request.limit } : {}),
        ...(request?.cursor ? { cursor: request.cursor } : {}),
      });
    },
    [sendMessage],
  );

  const resumeSession = useCallback(
    (sid: string) => {
      const normalized = sid.trim();
      if (!normalized) return;
      sendMessage({ type: "session_replay", sessionId: normalized });
    },
    [sendMessage],
  );

  const requestSessionTransfer = useCallback(
    (
      targetPrincipalId: string,
      targetPrincipalType: "user" | "service_account" = "user",
      expiresInMs?: number,
      explicitSessionId?: string,
    ) => {
      const sid = explicitSessionId ?? sessionId;
      const target = targetPrincipalId.trim();
      if (!sid || !target) return;
      sendMessage({
        type: "session_transfer_request",
        sessionId: sid,
        targetPrincipalId: target,
        targetPrincipalType,
        ...(expiresInMs !== undefined ? { expiresInMs } : {}),
      });
    },
    [sendMessage, sessionId],
  );

  const acceptSessionTransfer = useCallback(
    (explicitSessionId?: string) => {
      const sid = explicitSessionId ?? pendingSessionTransfers[0]?.sessionId ?? sessionId;
      if (!sid) return;
      sendMessage({
        type: "session_transfer_accept",
        sessionId: sid,
      });
    },
    [pendingSessionTransfers, sendMessage, sessionId],
  );

  const dismissPendingSessionTransfer = useCallback(
    (explicitSessionId?: string) => {
      const sid = explicitSessionId ?? pendingSessionTransfers[0]?.sessionId;
      if (!sid) return;
      setPendingSessionTransfers((prev) => prev.filter((transfer) => transfer.sessionId !== sid));
    },
    [pendingSessionTransfers],
  );

  const requestUsage = useCallback(
    (query: UsageQueryInput) => {
      if (!sessionId) return;
      sendMessage({ type: "usage_query", sessionId, ...query });
    },
    [sendMessage, sessionId],
  );

  const cancel = useCallback(() => {
    queuedSteerRef.current = null;
    ignoreCancelledTurnEndRef.current = false;
    if (sessionId) {
      sendMessage({ type: "cancel", sessionId });
    }
  }, [sessionId, sendMessage]);

  const closeSession = useCallback(() => {
    queuedSteerRef.current = null;
    ignoreCancelledTurnEndRef.current = false;
    if (sessionId) {
      sendMessage({ type: "session_close", sessionId });
    }
  }, [sessionId, sendMessage]);

  return {
    sessionId,
    sessionModel,
    sessionRuntimeId,
    sessionWorkspaceId,
    sessionPrincipalType,
    sessionPrincipalId,
    sessionSource,
    modelRouting,
    modelAliases,
    modelCatalog,
    runtimeDefaults,
    runtimeHealth,
    authStatus,
    authPrincipalType,
    authPrincipalId,
    pendingSessionTransfers,
    sessionList,
    sessionListHasMore,
    sessionListNextCursor,
    responseText,
    thinkingText,
    isStreaming,
    activeTools,
    toolCalls,
    transcript,
    usageResults,
    error,
    sendPrompt,
    steer,
    cancel,
    closeSession,
    requestReplay,
    requestSessionList,
    resumeSession,
    requestSessionTransfer,
    acceptSessionTransfer,
    dismissPendingSessionTransfer,
    requestUsage,
    handleEvent,
  };
};
