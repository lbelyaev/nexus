import React, { useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";

export interface InputProps {
  onSubmit: (text: string) => void;
  isDisabled: boolean;
}

export const Input = ({ onSubmit, isDisabled }: InputProps) => {
  const [value, setValue] = useState("");
  const { isRawModeSupported } = useStdin();

  useInput(
    (input, key) => {
      if (isDisabled) return;

      if (key.return) {
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setValue("");
        }
        return;
      }

      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        return;
      }

      if (input) {
        setValue((prev) => prev + input);
      }
    },
    { isActive: isRawModeSupported },
  );

  if (!isRawModeSupported) {
    return (
      <Box>
        <Text color="gray">
          Input unavailable (no TTY). Run directly: bun run packages/tui/src/index.tsx
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color={isDisabled ? "gray" : "white"} bold>
        {"\u276F "}
      </Text>
      <Text>{isDisabled ? "" : value}</Text>
    </Box>
  );
};
