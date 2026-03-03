import { useState, useCallback, useRef, useEffect } from "react";
import type { ClientMessage, GatewayEvent, TranscriptMessage } from "@nexus/types";

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

export interface MemoryQueryInput {
  action: "stats" | "recent" | "search" | "context" | "clear";
  scope?: "session" | "workspace" | "hybrid";
  query?: string;
  prompt?: string;
  limit?: number;
}

export type MemoryResultEvent = Extract<GatewayEvent, { type: "memory_result" }>;

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
  responseText: string;
  thinkingText: string;
  isStreaming: boolean;
  activeTools: ActiveTool[];
  toolCalls: ToolCall[];
  transcript: TranscriptMessage[];
  memoryResults: MemoryResultEvent[];
  error: string | null;
  sendPrompt: (text: string) => void;
  steer: (text: string) => void;
  cancel: () => void;
  closeSession: () => void;
  requestReplay: (sessionId: string) => void;
  requestMemory: (query: MemoryQueryInput) => void;
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
  const [modelRouting, setModelRouting] = useState<Record<string, string>>({});
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({});
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({});
  const [runtimeDefaults, setRuntimeDefaults] = useState<Record<string, string>>({});
  const [runtimeHealth, setRuntimeHealth] = useState<Record<string, { status: "starting" | "healthy" | "degraded" | "unavailable"; updatedAt: string; reason?: string }>>({});
  const [responseText, setResponseText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [memoryResults, setMemoryResults] = useState<MemoryResultEvent[]>([]);
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

  const sendPromptInternal = useCallback(
    (text: string) => {
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
      sendMessage({ type: "prompt", sessionId, text });
    },
    [sessionId, sendMessage],
  );

  const handleEvent = useCallback((event: GatewayEvent) => {
    switch (event.type) {
      case "session_created":
        setSessionId(event.sessionId);
        setSessionModel(event.model);
        setSessionRuntimeId(event.runtimeId ?? null);
        setSessionWorkspaceId(event.workspaceId ?? "default");
        setSessionPrincipalType(event.principalType ?? "user");
        setSessionPrincipalId(event.principalId ?? "user:local");
        setSessionSource(event.source ?? "interactive");
        setModelRouting(event.modelRouting ?? {});
        setModelAliases(event.modelAliases ?? {});
        setModelCatalog(event.modelCatalog ?? {});
        setRuntimeDefaults(event.runtimeDefaults ?? {});
        break;
      case "session_closed":
        if (event.sessionId === sessionId) {
          setSessionId(null);
          setSessionModel(null);
          setSessionRuntimeId(null);
          setSessionWorkspaceId(null);
          setSessionPrincipalType(null);
          setSessionPrincipalId(null);
          setSessionSource(null);
          setIsStreaming(false);
          setActiveTools([]);
          setToolCalls([]);
        }
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
        break;
      case "memory_result":
        setMemoryResults((prev) => [...prev, event]);
        break;
      case "error":
        ignoreCancelledTurnEndRef.current = false;
        setError(event.message);
        break;
    }
  }, [sessionId, sendPromptInternal]);

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

  const requestMemory = useCallback(
    (query: MemoryQueryInput) => {
      if (!sessionId) return;
      sendMessage({ type: "memory_query", sessionId, ...query });
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
    responseText,
    thinkingText,
    isStreaming,
    activeTools,
    toolCalls,
    transcript,
    memoryResults,
    error,
    sendPrompt,
    steer,
    cancel,
    closeSession,
    requestReplay,
    requestMemory,
    handleEvent,
  };
};
