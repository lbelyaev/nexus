import React from "react";
import { Box, Text } from "ink";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChatProps {
  messages: ChatMessage[];
  streamingText: string;
  isStreaming: boolean;
}

export const Chat = ({ messages, streamingText, isStreaming }: ChatProps) => (
  <Box flexDirection="column">
    {messages.map((msg, i) => (
      <Box key={i}>
        <Text bold color={msg.role === "user" ? "blue" : "green"}>
          {msg.role === "user" ? "You: " : "Assistant: "}
        </Text>
        <Text>{msg.text}</Text>
      </Box>
    ))}
    {isStreaming && (
      <Box>
        <Text bold color="green">
          {"Assistant: "}
        </Text>
        <Text>{streamingText || "Thinking..."}</Text>
      </Box>
    )}
  </Box>
);
