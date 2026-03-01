import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  status: "connecting" | "connected" | "disconnected" | "error";
  model?: string;
}

export const StatusBar = ({ status, model }: StatusBarProps) => (
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
          ? `Connected${model ? ` (${model})` : ""}`
          : status === "disconnected"
            ? "Disconnected"
            : "Error"}
    </Text>
  </Box>
);
