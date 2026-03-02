import { useState, useCallback, useRef } from "react";
import type { ClientMessage, GatewayEvent } from "@nexus/types";

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
  modelRouting: Record<string, string>;
  modelAliases: Record<string, string>;
  modelCatalog: Record<string, string[]>;
  runtimeDefaults: Record<string, string>;
  responseText: string;
  thinkingText: string;
  isStreaming: boolean;
  activeTools: ActiveTool[];
  toolCalls: ToolCall[];
  error: string | null;
  sendPrompt: (text: string) => void;
  steer: (text: string) => void;
  cancel: () => void;
  handleEvent: (event: GatewayEvent) => void;
}

export const useSession = (
  sendMessage: (msg: ClientMessage) => void,
): UseSessionResult => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [sessionRuntimeId, setSessionRuntimeId] = useState<string | null>(null);
  const [modelRouting, setModelRouting] = useState<Record<string, string>>({});
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({});
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({});
  const [runtimeDefaults, setRuntimeDefaults] = useState<Record<string, string>>({});
  const [responseText, setResponseText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const queuedSteerRef = useRef<string | null>(null);
  const ignoreCancelledTurnEndRef = useRef(false);

  const sendPromptInternal = useCallback(
    (text: string) => {
      if (!sessionId) return;
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
        setModelRouting(event.modelRouting ?? {});
        setModelAliases(event.modelAliases ?? {});
        setModelCatalog(event.modelCatalog ?? {});
        setRuntimeDefaults(event.runtimeDefaults ?? {});
        break;
      case "text_delta":
        ignoreCancelledTurnEndRef.current = false;
        setResponseText((prev) => prev + event.delta);
        break;
      case "thinking_delta":
        ignoreCancelledTurnEndRef.current = false;
        setThinkingText((prev) => prev + event.delta);
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

  const cancel = useCallback(() => {
    queuedSteerRef.current = null;
    ignoreCancelledTurnEndRef.current = false;
    if (sessionId) {
      sendMessage({ type: "cancel", sessionId });
    }
  }, [sessionId, sendMessage]);

  return {
    sessionId,
    sessionModel,
    sessionRuntimeId,
    modelRouting,
    modelAliases,
    modelCatalog,
    runtimeDefaults,
    responseText,
    thinkingText,
    isStreaming,
    activeTools,
    toolCalls,
    error,
    sendPrompt,
    steer,
    cancel,
    handleEvent,
  };
};
