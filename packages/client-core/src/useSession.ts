import { useState, useCallback } from "react";
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
  responseText: string;
  thinkingText: string;
  isStreaming: boolean;
  activeTools: ActiveTool[];
  toolCalls: ToolCall[];
  error: string | null;
  sendPrompt: (text: string) => void;
  cancel: () => void;
  handleEvent: (event: GatewayEvent) => void;
}

export const useSession = (
  sendMessage: (msg: ClientMessage) => void,
): UseSessionResult => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleEvent = useCallback((event: GatewayEvent) => {
    switch (event.type) {
      case "session_created":
        setSessionId(event.sessionId);
        break;
      case "text_delta":
        setResponseText((prev) => prev + event.delta);
        break;
      case "thinking_delta":
        setThinkingText((prev) => prev + event.delta);
        break;
      case "turn_end":
        setIsStreaming(false);
        break;
      case "tool_start":
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
        setError(event.message);
        break;
    }
  }, []);

  const sendPrompt = useCallback(
    (text: string) => {
      setResponseText("");
      setThinkingText("");
      setToolCalls([]);
      setError(null);
      setIsStreaming(true);
      if (sessionId) {
        sendMessage({ type: "prompt", sessionId, text });
      }
    },
    [sessionId, sendMessage],
  );

  const cancel = useCallback(() => {
    if (sessionId) {
      sendMessage({ type: "cancel", sessionId });
    }
  }, [sessionId, sendMessage]);

  return {
    sessionId,
    responseText,
    thinkingText,
    isStreaming,
    activeTools,
    toolCalls,
    error,
    sendPrompt,
    cancel,
    handleEvent,
  };
};
