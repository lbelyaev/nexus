import { useState, useCallback } from "react";
import type { ClientMessage, GatewayEvent } from "@nexus/types";

export interface PendingApproval {
  requestId: string;
  tool: string;
  description: string;
  sessionId: string;
}

export interface UseApprovalResult {
  pendingApprovals: PendingApproval[];
  approve: (requestId: string) => void;
  deny: (requestId: string) => void;
  handleEvent: (event: GatewayEvent) => void;
}

export const useApproval = (
  sendMessage: (msg: ClientMessage) => void,
): UseApprovalResult => {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  );

  const handleEvent = useCallback((event: GatewayEvent) => {
    if (event.type === "approval_request") {
      setPendingApprovals((prev) => [
        ...prev,
        {
          requestId: event.requestId,
          tool: event.tool,
          description: event.description,
          sessionId: event.sessionId,
        },
      ]);
    }
  }, []);

  const approve = useCallback(
    (requestId: string) => {
      setPendingApprovals((prev) =>
        prev.filter((a) => a.requestId !== requestId),
      );
      sendMessage({ type: "approval_response", requestId, allow: true });
    },
    [sendMessage],
  );

  const deny = useCallback(
    (requestId: string) => {
      setPendingApprovals((prev) =>
        prev.filter((a) => a.requestId !== requestId),
      );
      sendMessage({ type: "approval_response", requestId, allow: false });
    },
    [sendMessage],
  );

  return {
    pendingApprovals,
    approve,
    deny,
    handleEvent,
  };
};
