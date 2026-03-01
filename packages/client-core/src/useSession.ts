import { useState, useCallback } from "react";
import type { ClientMessage, GatewayEvent } from "@nexus/types";

export interface ActiveTool {
  tool: string;
  params: unknown;
}

export interface UseSessionResult {
  sessionId: string | null;
  responseText: string;
  isStreaming: boolean;
  activeTools: ActiveTool[];
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
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleEvent = useCallback((event: GatewayEvent) => {
    switch (event.type) {
      case "session_created":
        setSessionId(event.sessionId);
        break;
      case "text_delta":
        setResponseText((prev) => prev + event.delta);
        break;
      case "turn_end":
        setIsStreaming(false);
        break;
      case "tool_start":
        setActiveTools((prev) => [
          ...prev,
          { tool: event.tool, params: event.params },
        ]);
        break;
      case "tool_end":
        setActiveTools((prev) => prev.filter((t) => t.tool !== event.tool));
        break;
      case "error":
        setError(event.message);
        break;
    }
  }, []);

  const sendPrompt = useCallback(
    (text: string) => {
      setResponseText("");
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
    isStreaming,
    activeTools,
    error,
    sendPrompt,
    cancel,
    handleEvent,
  };
};
