import React from "react";
import { Box, Text, useInput } from "ink";
import type { PendingSessionTransfer } from "@nexus/client-core";

export interface TransferPromptProps {
  transfer: PendingSessionTransfer | null;
  totalPending: number;
  onAccept: () => void;
  onDismiss: () => void;
}

export const TransferPrompt = ({
  transfer,
  totalPending,
  onAccept,
  onDismiss,
}: TransferPromptProps) => {
  useInput(
    (input) => {
      const pressed = input.toLowerCase();
      if (pressed === "y") onAccept();
      if (pressed === "n") onDismiss();
    },
    { isActive: !!transfer },
  );

  if (!transfer) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Session Transfer Requested{totalPending > 1 ? ` (${totalPending} pending)` : ""}
      </Text>
      <Text>
        Session: <Text bold>{transfer.sessionId}</Text>
      </Text>
      <Text>
        From: <Text bold>{transfer.fromPrincipalType}:{transfer.fromPrincipalId}</Text>
      </Text>
      <Text color="yellow">[y] accept  [n] dismiss</Text>
    </Box>
  );
};
