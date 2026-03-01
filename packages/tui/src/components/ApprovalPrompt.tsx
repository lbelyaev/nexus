import React from "react";
import { Box, Text, useInput } from "ink";

export interface ApprovalPromptProps {
  approval: { requestId: string; tool: string; description: string } | null;
  totalPending: number;
  onApprove: () => void;
  onApproveAll: () => void;
  onDeny: () => void;
}

export const ApprovalPrompt = ({
  approval,
  totalPending,
  onApprove,
  onApproveAll,
  onDeny,
}: ApprovalPromptProps) => {
  useInput(
    (input) => {
      const key = input.toLowerCase();
      if (key === "y") onApprove();
      if (key === "a") onApproveAll();
      if (key === "n") onDeny();
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
      <Text color="yellow">[y] approve  {totalPending > 1 ? <Text color="yellow">[a] approve all  </Text> : null}[n] reject</Text>
    </Box>
  );
};
