import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  status: "connecting" | "connected" | "disconnected" | "error";
  model?: string;
  isSessionInitializing?: boolean;
}

export const StatusBar = ({ status, model, isSessionInitializing = false }: StatusBarProps) => (
  <Box>
    <Text
      color={
        status === "connected"
          ? "green"
          : status === "error"
            ? "red"
            : "yellow"
      }
    >
      {status === "connecting"
        ? "Connecting..."
        : status === "connected"
          ? `Connected${model ? ` (${model})` : isSessionInitializing ? " (creating session...)" : ""}`
          : status === "disconnected"
            ? "Disconnected"
            : "Error"}
    </Text>
  </Box>
);
