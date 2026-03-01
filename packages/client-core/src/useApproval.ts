import { useState, useCallback, useRef } from "react";
import type { ClientMessage, GatewayEvent } from "@nexus/types";

export interface PendingApproval {
  requestId: string;
  tool: string;
  description: string;
  sessionId: string;
  options?: Array<{ optionId: string; name: string; kind: string }>;
}

export interface UseApprovalResult {
  pendingApprovals: PendingApproval[];
  autoApprove: boolean;
  approve: (requestId: string) => void;
  approveAll: () => void;
  deny: (requestId: string) => void;
  handleEvent: (event: GatewayEvent) => void;
}

export const useApproval = (
  sendMessage: (msg: ClientMessage) => void,
): UseApprovalResult => {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  );
  const [autoApprove, setAutoApprove] = useState(false);
  // Ref so the handleEvent callback always sees the latest value
  const autoApproveRef = useRef(false);

  const pickOptionId = useCallback(
    (
      approval: PendingApproval | undefined,
      preferredKinds: string[],
    ): string | undefined => {
      if (!approval?.options?.length) return undefined;
      for (const kind of preferredKinds) {
        const match = approval.options.find((opt) => opt.kind === kind);
        if (match) return match.optionId;
      }
      return approval.options[0]?.optionId;
    },
    [],
  );

  const sendApprovalResponse = useCallback(
    (requestId: string, allow: boolean, optionId?: string): void => {
      sendMessage({
        type: "approval_response",
        requestId,
        allow,
        ...(optionId ? { optionId } : {}),
      });
    },
    [sendMessage],
  );

  const handleEvent = useCallback((event: GatewayEvent) => {
    if (event.type === "approval_request") {
      // If auto-approve is active, immediately approve without queuing
      if (autoApproveRef.current) {
        const optionId = pickOptionId(
          {
            requestId: event.requestId,
            sessionId: event.sessionId,
            tool: event.tool,
            description: event.description,
            options: event.options,
          },
          ["allow_always", "allow_once"],
        );
        sendApprovalResponse(event.requestId, true, optionId);
        return;
      }
      setPendingApprovals((prev) => [
        ...prev,
        {
          requestId: event.requestId,
          tool: event.tool,
          description: event.description,
          sessionId: event.sessionId,
          options: event.options,
        },
      ]);
    }
    // Reset auto-approve when turn ends or a new session starts
    if (event.type === "turn_end" || event.type === "session_created") {
      autoApproveRef.current = false;
      setAutoApprove(false);
      setPendingApprovals([]);
    }
  }, [pickOptionId, sendApprovalResponse]);

  const approve = useCallback(
    (requestId: string) => {
      setPendingApprovals((prev) => {
        const approval = prev.find((a) => a.requestId === requestId);
        const optionId = pickOptionId(approval, ["allow_once", "allow_always"]);
        sendApprovalResponse(requestId, true, optionId);
        return prev.filter((a) => a.requestId !== requestId);
      });
    },
    [pickOptionId, sendApprovalResponse],
  );

  const approveAll = useCallback(() => {
    autoApproveRef.current = true;
    setAutoApprove(true);
    setPendingApprovals((prev) => {
      for (const a of prev) {
        const optionId = pickOptionId(a, ["allow_always", "allow_once"]);
        sendApprovalResponse(a.requestId, true, optionId);
      }
      return [];
    });
  }, [pickOptionId, sendApprovalResponse]);

  const deny = useCallback(
    (requestId: string) => {
      setPendingApprovals((prev) => {
        const approval = prev.find((a) => a.requestId === requestId);
        const optionId = pickOptionId(approval, ["reject_once", "reject_always"]);
        sendApprovalResponse(requestId, false, optionId);
        return prev.filter((a) => a.requestId !== requestId);
      });
    },
    [pickOptionId, sendApprovalResponse],
  );

  return {
    pendingApprovals,
    autoApprove,
    approve,
    approveAll,
    deny,
    handleEvent,
  };
};
