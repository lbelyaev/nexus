import React from "react";
import { Box, Text } from "ink";

export interface ToolStatusProps {
  activeTools: Array<{ tool: string; params: unknown }>;
}

export const ToolStatus = ({ activeTools }: ToolStatusProps) => {
  if (activeTools.length === 0) return null;

  return (
    <Box flexDirection="column">
      {activeTools.map((t, i) => (
        <Box key={i}>
          <Text color="cyan">{"⟳ "}</Text>
          <Text>{t.tool}</Text>
        </Box>
      ))}
    </Box>
  );
};
