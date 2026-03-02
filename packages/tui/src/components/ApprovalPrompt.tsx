import React from "react";
import { Box, Text, useInput } from "ink";

export interface ApprovalPromptProps {
  approval: { requestId: string; tool: string; description: string } | null;
  totalPending: number;
  onApprove: () => void;
  onApproveAll: () => void;
  onDeny: () => void;
  onCancel?: () => void;
  canCancel?: boolean;
}

export const ApprovalPrompt = ({
  approval,
  totalPending,
  onApprove,
  onApproveAll,
  onDeny,
  onCancel,
  canCancel = false,
}: ApprovalPromptProps) => {
  useInput(
    (input, inputKey) => {
      if (inputKey.escape && canCancel && onCancel) {
        onCancel();
        return;
      }
      const pressed = input.toLowerCase();
      if (pressed === "y") onApprove();
      if (pressed === "a") onApproveAll();
      if (pressed === "n") onDeny();
    },
    { isActive: !!approval },
  );

  if (!approval) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Approval Required{totalPending > 1 ? ` (${totalPending} pending)` : ""}
      </Text>
      <Text>
        Tool: <Text bold>{approval.tool}</Text>
      </Text>
      <Text>{approval.description}</Text>
      <Text color="yellow">
        [y] approve  {totalPending > 1 ? <Text color="yellow">[a] approve all  </Text> : null}[n] reject
        {canCancel ? <Text color="yellow">  [esc] cancel</Text> : null}
      </Text>
    </Box>
  );
};
