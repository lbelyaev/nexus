import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box } from "ink";
import { useConnection, useSession, useApproval } from "@nexus/client-core";
import type { GatewayEvent } from "@nexus/types";
import { StatusBar } from "./components/StatusBar.js";
import { Chat, type ChatMessage } from "./components/Chat.js";
import { Input } from "./components/Input.js";
import { ToolStatus } from "./components/ToolStatus.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";

export interface AppProps {
  url: string;
  token: string;
}

export const App = ({ url, token }: AppProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Use refs to break the circular dependency between handleEvent and hooks
  const sessionRef = useRef<ReturnType<typeof useSession>>(null!);
  const approvalRef = useRef<ReturnType<typeof useApproval>>(null!);

  const handleEvent = useCallback((event: GatewayEvent) => {
    sessionRef.current?.handleEvent(event);
    approvalRef.current?.handleEvent(event);

    if (event.type === "turn_end") {
      // Finalize streamed text into a message
      setMessages((prev) => {
        // responseText is tracked via the session hook, but we can't access it
        // synchronously here. Instead, we'll handle finalization in an effect.
        return prev;
      });
    }
  }, []);

  const { status, sendMessage } = useConnection({ url, token, onEvent: handleEvent });
  const session = useSession(sendMessage);
  const approval = useApproval(sendMessage);

  // Keep refs current
  sessionRef.current = session;
  approvalRef.current = approval;

  // Finalize response text into a message when streaming stops
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !session.isStreaming && session.responseText) {
      setMessages((prev) => [...prev, { role: "assistant", text: session.responseText }]);
    }
    prevStreamingRef.current = session.isStreaming;
  }, [session.isStreaming, session.responseText]);

  // Auto-create session on connect
  useEffect(() => {
    if (status === "connected" && !session.sessionId) {
      sendMessage({ type: "session_new" });
    }
  }, [status, session.sessionId, sendMessage]);

  const handleSubmit = useCallback(
    (text: string) => {
      setMessages((prev) => [...prev, { role: "user", text }]);
      session.sendPrompt(text);
    },
    [session.sendPrompt],
  );

  const currentApproval = approval.pendingApprovals[0] ?? null;

  const handleApprove = useCallback(() => {
    if (currentApproval) {
      approval.approve(currentApproval.requestId);
    }
  }, [currentApproval, approval.approve]);

  const handleDeny = useCallback(() => {
    if (currentApproval) {
      approval.deny(currentApproval.requestId);
    }
  }, [currentApproval, approval.deny]);

  return (
    <Box flexDirection="column" padding={1}>
      <StatusBar status={status} />
      <Chat
        messages={messages}
        streamingText={session.responseText}
        isStreaming={session.isStreaming}
      />
      <ToolStatus activeTools={session.activeTools} />
      <ApprovalPrompt
        approval={currentApproval}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
      <Input onSubmit={handleSubmit} isDisabled={session.isStreaming} />
    </Box>
  );
};
