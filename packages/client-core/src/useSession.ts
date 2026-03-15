import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ClientMessage,
  GatewayEvent,
  PromptImageInput,
  SessionInfo,
  StoredSessionEvent,
  TranscriptMessage,
} from "@nexus/types";

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
export type SessionTransferUpdatedEvent = Extract<GatewayEvent, { type: "session_transfer_updated" }>;
export type SessionListEvent = Extract<GatewayEvent, { type: "session_list" }>;
export type SessionLifecycleResultEvent = Extract<GatewayEvent, { type: "session_lifecycle_result" }>;
export type SessionHistoryEvent = Extract<GatewayEvent, { type: "session_history" }>;

export interface PendingSessionTransfer {
  sessionId: string;
  fromPrincipalType: "user" | "service_account";
  fromPrincipalId: string;
  targetPrincipalType: "user" | "service_account";
  targetPrincipalId: string;
  expiresAt: string;
}

const sortSessionList = (sessions: SessionInfo[]): SessionInfo[] => (
  [...sessions].sort((left, right) => {
    const byActivity = right.lastActivityAt.localeCompare(left.lastActivityAt);
    if (byActivity !== 0) return byActivity;
    return right.id.localeCompare(left.id);
  })
);

const upsertSessionListEntry = (sessions: SessionInfo[], entry: SessionInfo): SessionInfo[] => (
  sortSessionList([entry, ...sessions.filter((session) => session.id !== entry.id)])
);

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

const toPendingTransfer = (
  event: SessionTransferRequestedEvent | SessionTransferUpdatedEvent,
): PendingSessionTransfer | null => {
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

const mergeStoredSessionEvents = (
  previous: StoredSessionEvent[],
  incoming: StoredSessionEvent[],
): StoredSessionEvent[] => {
  if (previous.length === 0) return incoming;
  if (incoming.length === 0) return previous;
  const byId = new Map<number, StoredSessionEvent>();
  for (const event of previous) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return Array.from(byId.values()).sort((left, right) => left.id - right.id);
};

export interface UseSessionResult {
  sessionId: string | null;
  sessionDisplayName: string | null;
  sessionModel: string | null;
  sessionRuntimeId: string | null;
  sessionWorkspaceId: string | null;
  sessionOwnerDid: string | null;
  sessionPrincipalType: "user" | "service_account" | null;
  sessionPrincipalId: string | null;
  sessionSource: "interactive" | "schedule" | "hook" | "api" | null;
  sessionAttachmentState: "controller" | "elsewhere" | "detached" | null;
  isSessionController: boolean;
  modelRouting: Record<string, string>;
  modelAliases: Record<string, string>;
  modelCatalog: Record<string, string[]>;
  runtimeDefaults: Record<string, string>;
  runtimeHealth: Record<string, { status: "starting" | "healthy" | "degraded" | "unavailable"; updatedAt: string; reason?: string }>;
  authStatus: "unverified" | "verifying" | "verified" | "failed";
  authOwnerDid: string | null;
  authPrincipalType: "user" | "service_account" | null;
  authPrincipalId: string | null;
  pendingSessionTransfers: PendingSessionTransfer[];
  sessionList: SessionListEvent["sessions"];
  sessionListLoaded: boolean;
  sessionListHasMore: boolean;
  sessionListNextCursor: string | null;
  sessionLifecycleHistory: SessionLifecycleResultEvent["events"];
  sessionHistory: SessionHistoryEvent["events"];
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
  attachSession: (sessionId: string) => void;
  detachSession: (sessionId?: string) => void;
  requestReplay: (sessionId: string) => void;
  requestSessionHistory: (sessionId?: string, afterId?: number, limit?: number) => void;
  requestSessionList: (request?: SessionListRequestInput) => void;
  requestSessionLifecycle: (sessionId?: string, limit?: number) => void;
  renameSession: (sessionId: string, displayName: string | null) => void;
  resumeSession: (sessionId: string) => void;
  takeoverSession: (sessionId: string) => void;
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
  const [sessionDisplayName, setSessionDisplayName] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [sessionRuntimeId, setSessionRuntimeId] = useState<string | null>(null);
  const [sessionWorkspaceId, setSessionWorkspaceId] = useState<string | null>(null);
  const [sessionOwnerDid, setSessionOwnerDid] = useState<string | null>(null);
  const [sessionPrincipalType, setSessionPrincipalType] = useState<"user" | "service_account" | null>(null);
  const [sessionPrincipalId, setSessionPrincipalId] = useState<string | null>(null);
  const [sessionSource, setSessionSource] = useState<"interactive" | "schedule" | "hook" | "api" | null>(null);
  const [sessionAttachmentState, setSessionAttachmentState] = useState<"controller" | "elsewhere" | "detached" | null>(null);
  const sessionOwnerDidRef = useRef(sessionOwnerDid);
  const sessionPrincipalTypeRef = useRef(sessionPrincipalType);
  const sessionPrincipalIdRef = useRef(sessionPrincipalId);
  const sessionSourceRef = useRef(sessionSource);
  const [modelRouting, setModelRouting] = useState<Record<string, string>>({});
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({});
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({});
  const [runtimeDefaults, setRuntimeDefaults] = useState<Record<string, string>>({});
  const [runtimeHealth, setRuntimeHealth] = useState<Record<string, { status: "starting" | "healthy" | "degraded" | "unavailable"; updatedAt: string; reason?: string }>>({});
  const [authStatus, setAuthStatus] = useState<"unverified" | "verifying" | "verified" | "failed">("unverified");
  const [authOwnerDid, setAuthOwnerDid] = useState<string | null>(null);
  const [authPrincipalType, setAuthPrincipalType] = useState<"user" | "service_account" | null>(null);
  const [authPrincipalId, setAuthPrincipalId] = useState<string | null>(null);
  const authStatusRef = useRef(authStatus);
  const authOwnerDidRef = useRef(authOwnerDid);
  const authPrincipalTypeRef = useRef(authPrincipalType);
  const authPrincipalIdRef = useRef(authPrincipalId);
  const [pendingSessionTransfers, setPendingSessionTransfers] = useState<PendingSessionTransfer[]>([]);
  const [sessionList, setSessionList] = useState<SessionListEvent["sessions"]>([]);
  const [sessionListLoaded, setSessionListLoaded] = useState(false);
  const [sessionListHasMore, setSessionListHasMore] = useState(false);
  const [sessionListNextCursor, setSessionListNextCursor] = useState<string | null>(null);
  const [sessionLifecycleHistory, setSessionLifecycleHistory] = useState<SessionLifecycleResultEvent["events"]>([]);
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryEvent["events"]>([]);
  const sessionHistorySessionIdRef = useRef<string | null>(null);
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
    authOwnerDidRef.current = authOwnerDid;
    authPrincipalTypeRef.current = authPrincipalType;
    authPrincipalIdRef.current = authPrincipalId;
  }, [authOwnerDid, authPrincipalId, authPrincipalType, authStatus]);

  useEffect(() => {
    sessionOwnerDidRef.current = sessionOwnerDid;
    sessionPrincipalTypeRef.current = sessionPrincipalType;
    sessionPrincipalIdRef.current = sessionPrincipalId;
    sessionSourceRef.current = sessionSource;
  }, [sessionOwnerDid, sessionPrincipalId, sessionPrincipalType, sessionSource]);

  useEffect(() => {
    sessionListRef.current = sessionList;
  }, [sessionList]);

  const sendPromptInternal = useCallback(
    (text: string, images?: PromptImageInput[]) => {
      if (!sessionId) return;
      if (sessionAttachmentState !== "controller") {
        setError("Session is attached read-only in this client. Reattach to take control before sending a prompt.");
        return;
      }
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
    [sessionAttachmentState, sessionId, sendMessage],
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
        setTranscript([]);
        setSessionHistory([]);
        sessionHistorySessionIdRef.current = null;
        setError(null);
        setSessionId(event.sessionId);
        setSessionDisplayName(event.displayName ?? null);
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
            sessionOwnerDidRef.current = authOwnerDidRef.current;
            sessionPrincipalTypeRef.current = authPrincipalTypeRef.current;
            sessionPrincipalIdRef.current = authPrincipalIdRef.current;
            setSessionOwnerDid(authOwnerDidRef.current);
            setSessionPrincipalType(authPrincipalTypeRef.current);
            setSessionPrincipalId(authPrincipalIdRef.current);
          } else {
            sessionOwnerDidRef.current = event.ownerDid ?? null;
            sessionPrincipalTypeRef.current = createdPrincipalType;
            sessionPrincipalIdRef.current = createdPrincipalId;
            setSessionOwnerDid(event.ownerDid ?? null);
            setSessionPrincipalType(createdPrincipalType);
            setSessionPrincipalId(createdPrincipalId);
          }
        }
        sessionSourceRef.current = event.source ?? "interactive";
        setSessionSource(event.source ?? "interactive");
        setSessionAttachmentState("controller");
        setModelRouting(event.modelRouting ?? {});
        setModelAliases(event.modelAliases ?? {});
        setModelCatalog(event.modelCatalog ?? {});
        setRuntimeDefaults(event.runtimeDefaults ?? {});
        setPendingSessionTransfers([]);
        {
          const now = new Date().toISOString();
          setSessionList((prev) => upsertSessionListEntry(prev, {
            id: event.sessionId,
            status: "active",
            lifecycleState: "live",
            model: event.model,
            attachmentState: "controller",
            workspaceId: event.workspaceId ?? "default",
            ...(event.ownerDid ? { ownerDid: event.ownerDid } : {}),
            ...(event.displayName ? { displayName: event.displayName } : {}),
            principalType: event.principalType ?? "user",
            principalId: event.principalId ?? "user:local",
            source: event.source ?? "interactive",
            createdAt: now,
            lastActivityAt: now,
          }));
        }
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
          setSessionDisplayName(null);
          setSessionModel(null);
          setSessionRuntimeId(null);
          setSessionWorkspaceId(null);
          sessionOwnerDidRef.current = null;
          sessionPrincipalTypeRef.current = null;
          sessionPrincipalIdRef.current = null;
          sessionSourceRef.current = null;
          setSessionOwnerDid(null);
          setSessionPrincipalType(null);
          setSessionPrincipalId(null);
          setSessionSource(null);
          setSessionAttachmentState(null);
          setResponseText("");
          setThinkingText("");
          setIsStreaming(false);
          setActiveTools([]);
          setToolCalls([]);
          setTranscript([]);
          setSessionHistory([]);
          sessionHistorySessionIdRef.current = null;
          setError(null);
        }
        setPendingSessionTransfers((prev) => prev.filter((transfer) => transfer.sessionId !== event.sessionId));
        setSessionList((prev) => prev.map((candidate) => (
          candidate.id === event.sessionId
            ? {
                ...candidate,
                status: "idle",
                lifecycleState: "closed",
              }
            : candidate
        )));
        break;
      case "session_updated":
        if (event.sessionId === sessionId) {
          if (event.displayName !== undefined) {
            setSessionDisplayName(event.displayName);
          }
        }
        setSessionList((prev) => {
          const existing = prev.find((candidate) => candidate.id === event.sessionId);
          if (!existing) return prev;
          return upsertSessionListEntry(prev, {
            ...existing,
            ...(event.displayName !== undefined && event.displayName !== null ? { displayName: event.displayName } : {}),
            ...(event.displayName === null ? { displayName: undefined } : {}),
            ...(event.interruption !== undefined ? { interruption: event.interruption ?? undefined } : {}),
            ...(event.lifecycleState ? { lifecycleState: event.lifecycleState } : {}),
            ...(event.parkedReason !== undefined ? { parkedReason: event.parkedReason ?? undefined } : {}),
          });
        });
        break;
      case "session_attached":
        setSessionId(event.sessionId);
        setSessionAttachmentState(event.controller ? "controller" : "elsewhere");
        setError(null);
        setSessionList((prev) => prev.map((candidate) => (
          candidate.id === event.sessionId
            ? {
                ...candidate,
                attachmentState: event.controller ? "controller" : "elsewhere",
              }
            : candidate
        )));
        break;
      case "session_detached":
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
          setSessionDisplayName(null);
          setSessionModel(null);
          setSessionRuntimeId(null);
          setSessionWorkspaceId(null);
          sessionOwnerDidRef.current = null;
          sessionPrincipalTypeRef.current = null;
          sessionPrincipalIdRef.current = null;
          sessionSourceRef.current = null;
          setSessionOwnerDid(null);
          setSessionPrincipalType(null);
          setSessionPrincipalId(null);
          setSessionSource(null);
          setResponseText("");
          setThinkingText("");
          setSessionAttachmentState("detached");
          setIsStreaming(false);
          setActiveTools([]);
          setToolCalls((prev) => prev.map((tool) => (
            tool.status === "running" ? { ...tool, status: "failed" } : tool
          )));
          setTranscript([]);
          setSessionHistory([]);
          sessionHistorySessionIdRef.current = null;
          setError(null);
        }
        setSessionList((prev) => prev.map((candidate) => (
          candidate.id === event.sessionId
            ? { ...candidate, attachmentState: "detached" }
            : candidate
        )));
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
        setTranscript([]);
        setSessionHistory([]);
        sessionHistorySessionIdRef.current = null;
        setSessionAttachmentState("detached");
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
          const nextOwnerDid = event.ownerDid ?? null;
          authStatusRef.current = "verified";
          authOwnerDidRef.current = nextOwnerDid;
          authPrincipalTypeRef.current = nextType;
          authPrincipalIdRef.current = nextId;
          setAuthOwnerDid(nextOwnerDid);
          setAuthPrincipalType(nextType);
          setAuthPrincipalId(nextId);
          if (
            nextId
            && sessionPrincipalTypeRef.current === "user"
            && sessionPrincipalIdRef.current === "user:local"
            && (sessionSourceRef.current === null || sessionSourceRef.current === "interactive")
          ) {
            sessionOwnerDidRef.current = nextOwnerDid;
            sessionPrincipalTypeRef.current = nextType;
            sessionPrincipalIdRef.current = nextId;
            setSessionOwnerDid(nextOwnerDid);
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
        {
          const pendingTransfer = toPendingTransfer(event);
          if (!pendingTransfer) break;
          setPendingSessionTransfers((prev) => {
            const existingIndex = prev.findIndex((transfer) => transfer.sessionId === event.sessionId);
            if (existingIndex >= 0) {
              const next = [...prev];
              next[existingIndex] = pendingTransfer;
              return next;
            }
            return [...prev, pendingTransfer];
          });
        }
        break;
      case "session_transfer_updated": {
        const pendingTransfer = toPendingTransfer(event);
        if (!pendingTransfer) {
          setPendingSessionTransfers((prev) => prev.filter((transfer) => transfer.sessionId !== event.sessionId));
          break;
        }
        setPendingSessionTransfers((prev) => {
          const existingIndex = prev.findIndex((transfer) => transfer.sessionId === event.sessionId);
          if (existingIndex >= 0) {
            const next = [...prev];
            next[existingIndex] = pendingTransfer;
            return next;
          }
          return [...prev, pendingTransfer];
        });
        break;
      }
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
          const knownSession = sessionListRef.current.find((candidate) => candidate.id === event.sessionId);
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
          setTranscript([]);
          setSessionHistory([]);
          sessionHistorySessionIdRef.current = null;
          setError(null);
          setSessionDisplayName(knownSession?.displayName ?? null);
          setSessionId(event.sessionId);
          sessionOwnerDidRef.current = knownSession?.ownerDid ?? null;
          sessionPrincipalTypeRef.current = event.targetPrincipalType;
          sessionPrincipalIdRef.current = event.targetPrincipalId;
          sessionSourceRef.current = "interactive";
          setSessionOwnerDid(knownSession?.ownerDid ?? null);
          setSessionPrincipalType(event.targetPrincipalType);
          setSessionPrincipalId(event.targetPrincipalId);
          setSessionSource("interactive");
          setSessionAttachmentState("controller");
          sendMessage({ type: "session_replay", sessionId: event.sessionId });
          sendMessage({ type: "session_history", sessionId: event.sessionId });
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
          setSessionDisplayName(null);
          setSessionModel(null);
          setSessionRuntimeId(null);
          setSessionWorkspaceId(null);
          sessionOwnerDidRef.current = null;
          sessionPrincipalTypeRef.current = null;
          sessionPrincipalIdRef.current = null;
          sessionSourceRef.current = null;
          setSessionOwnerDid(null);
          setSessionPrincipalType(null);
          setSessionPrincipalId(null);
          setSessionSource(null);
          setSessionAttachmentState(null);
          setResponseText("");
          setThinkingText("");
          setIsStreaming(false);
          setActiveTools([]);
          setToolCalls([]);
          setTranscript([]);
          setSessionHistory([]);
          sessionHistorySessionIdRef.current = null;
        }
        setSessionList((prev) => {
          if (isSource) {
            return prev.filter((candidate) => candidate.id !== event.sessionId);
          }
          return prev;
        });
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
            setSessionDisplayName(match.displayName ?? null);
            setSessionModel(match.model);
            setSessionWorkspaceId(match.workspaceId ?? "default");
            sessionOwnerDidRef.current = match.ownerDid ?? null;
            setSessionOwnerDid(match.ownerDid ?? null);
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
            setSessionAttachmentState(match.attachmentState ?? "detached");
          }
        }
        break;
      case "session_list":
        setSessionList(event.sessions);
        setSessionListLoaded(true);
        setSessionListHasMore(event.hasMore ?? false);
        setSessionListNextCursor(event.nextCursor ?? null);
        if (sessionId) {
          const current = event.sessions.find((session) => session.id === sessionId);
          if (current) {
            setSessionDisplayName(current.displayName ?? null);
            sessionOwnerDidRef.current = current.ownerDid ?? null;
            setSessionOwnerDid(current.ownerDid ?? null);
            setSessionAttachmentState(current.attachmentState ?? "detached");
          }
        }
        break;
      case "session_lifecycle_result":
        setSessionLifecycleHistory(event.events);
        break;
      case "session_history":
        if (sessionHistorySessionIdRef.current !== event.sessionId) {
          sessionHistorySessionIdRef.current = event.sessionId;
          setSessionId(event.sessionId);
          const match = sessionListRef.current.find((session) => session.id === event.sessionId);
          if (match) {
            setSessionDisplayName(match.displayName ?? null);
            setSessionModel(match.model);
            setSessionWorkspaceId(match.workspaceId ?? "default");
            sessionOwnerDidRef.current = match.ownerDid ?? null;
            setSessionOwnerDid(match.ownerDid ?? null);
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
            setSessionAttachmentState(match.attachmentState ?? "detached");
          }
          setSessionHistory(event.events);
          break;
        }
        setSessionHistory((prev) => mergeStoredSessionEvents(prev, event.events));
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
      if (sessionAttachmentState !== "controller") {
        setError("Session is attached read-only in this client. Reattach to take control before steering.");
        return;
      }

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
    [isStreaming, sendMessage, sendPromptInternal, sessionAttachmentState, sessionId],
  );

  const requestReplay = useCallback(
    (sid: string) => {
      sendMessage({ type: "session_replay", sessionId: sid });
      sendMessage({ type: "session_history", sessionId: sid });
    },
    [sendMessage],
  );

  const requestSessionHistory = useCallback(
    (explicitSessionId?: string, afterId?: number, limit?: number) => {
      const sid = explicitSessionId ?? sessionId;
      if (!sid) return;
      sendMessage({
        type: "session_history",
        sessionId: sid,
        ...(afterId !== undefined ? { afterId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    },
    [sendMessage, sessionId],
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

  const requestSessionLifecycle = useCallback(
    (explicitSessionId?: string, limit?: number) => {
      const sid = explicitSessionId ?? sessionId;
      if (!sid) return;
      sendMessage({
        type: "session_lifecycle_query",
        sessionId: sid,
        ...(limit !== undefined ? { limit } : {}),
      });
    },
    [sendMessage, sessionId],
  );

  const renameSession = useCallback(
    (sid: string, displayName: string | null) => {
      const normalizedSessionId = sid.trim();
      if (!normalizedSessionId) return;
      const normalizedDisplayName = typeof displayName === "string" ? displayName.trim() : null;
      sendMessage({
        type: "session_rename",
        sessionId: normalizedSessionId,
        displayName: normalizedDisplayName && normalizedDisplayName.length > 0 ? normalizedDisplayName : null,
      });
    },
    [sendMessage],
  );

  const attachSession = useCallback(
    (sid: string) => {
      const normalized = sid.trim();
      if (!normalized) return;
      setError(null);
      sendMessage({ type: "session_attach", sessionId: normalized });
    },
    [sendMessage],
  );

  const detachSession = useCallback(
    (explicitSessionId?: string) => {
      const sid = explicitSessionId?.trim() || sessionId || undefined;
      sendMessage({
        type: "session_detach",
        ...(sid ? { sessionId: sid } : {}),
      });
    },
    [sendMessage, sessionId],
  );

  const resumeSession = useCallback(
    (sid: string) => {
      attachSession(sid);
    },
    [attachSession],
  );

  const takeoverSession = useCallback(
    (sid: string) => {
      const normalized = sid.trim();
      if (!normalized) return;
      sendMessage({ type: "session_takeover", sessionId: normalized });
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
      sendMessage({
        type: "session_transfer_dismiss",
        sessionId: sid,
      });
    },
    [pendingSessionTransfers, sendMessage],
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
    if (sessionAttachmentState !== "controller") {
      setError("Session is attached read-only in this client. Reattach to take control before cancelling.");
      return;
    }
    if (sessionId) {
      sendMessage({ type: "cancel", sessionId });
    }
  }, [sessionAttachmentState, sessionId, sendMessage]);

  const closeSession = useCallback(() => {
    queuedSteerRef.current = null;
    ignoreCancelledTurnEndRef.current = false;
    if (sessionAttachmentState !== "controller") {
      setError("Session is attached read-only in this client. Reattach to take control before closing.");
      return;
    }
    if (sessionId) {
      sendMessage({ type: "session_close", sessionId });
    }
  }, [sessionAttachmentState, sessionId, sendMessage]);

  const isSessionController = sessionAttachmentState === "controller";

  return {
    sessionId,
    sessionDisplayName,
    sessionModel,
    sessionRuntimeId,
    sessionWorkspaceId,
    sessionOwnerDid,
    sessionPrincipalType,
    sessionPrincipalId,
    sessionSource,
    sessionAttachmentState,
    isSessionController,
    modelRouting,
    modelAliases,
    modelCatalog,
    runtimeDefaults,
    runtimeHealth,
    authStatus,
    authOwnerDid,
    authPrincipalType,
    authPrincipalId,
    pendingSessionTransfers,
    sessionList,
    sessionListLoaded,
    sessionListHasMore,
    sessionListNextCursor,
    sessionLifecycleHistory,
    sessionHistory,
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
    attachSession,
    detachSession,
    requestReplay,
    requestSessionHistory,
    requestSessionList,
    requestSessionLifecycle,
    renameSession,
    resumeSession,
    takeoverSession,
    requestSessionTransfer,
    acceptSessionTransfer,
    dismissPendingSessionTransfer,
    requestUsage,
    handleEvent,
  };
};
