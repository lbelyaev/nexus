import React from "react";
import { Box, Text } from "ink";

export interface ApprovalPromptProps {
  approval: { requestId: string; tool: string; description: string } | null;
  onApprove: () => void;
  onDeny: () => void;
}

export const ApprovalPrompt = ({
  approval,
  onApprove,
  onDeny,
}: ApprovalPromptProps) => {
  if (!approval) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Approval Required
      </Text>
      <Text>
        Tool: <Text bold>{approval.tool}</Text>
      </Text>
      <Text>{approval.description}</Text>
      <Text color="yellow">Approve? [y/n]</Text>
    </Box>
  );
};
