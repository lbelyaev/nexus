import React from "react";
import { Box, Text } from "ink";
import { MarkdownRenderer, type MarkdownRendererName } from "./MarkdownRenderer.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface ToolCallEntry {
  tool: string;
  params: unknown;
  status: "running" | "completed" | "failed";
}

export interface ChatProps {
  messages: ChatMessage[];
  streamingText: string;
  thinkingText: string;
  isStreaming: boolean;
  toolCalls: ToolCallEntry[];
  markdownRenderer?: MarkdownRendererName;
}

export const Chat = ({
  messages,
  streamingText,
  thinkingText,
  isStreaming,
  toolCalls,
  markdownRenderer = "basic",
}: ChatProps) => (
  <Box flexDirection="column">
    {messages.map((msg, i) => (
      <Box key={i}>
        {msg.role === "system" ? (
          <Text color="yellow">{msg.text}</Text>
        ) : msg.role === "assistant" ? (
          <>
            <Text bold color="green">
              {"Assistant: "}
            </Text>
            <MarkdownRenderer text={msg.text} renderer={markdownRenderer} />
          </>
        ) : (
          <>
            <Text bold color="blue">
              {"You: "}
            </Text>
            <Text>{msg.text}</Text>
          </>
        )}
      </Box>
    ))}
    {isStreaming && thinkingText && !streamingText && toolCalls.length === 0 && (
      <Box>
        <Text color="gray">{"  Thinking..."}</Text>
      </Box>
    )}
    {isStreaming && toolCalls.length > 0 && (
      <Box flexDirection="column">
        {toolCalls.map((tc, i) => (
          <Box key={i}>
            <Text color="cyan">{tc.status === "running" ? "  ~ " : "  + "}</Text>
            <Text color="gray">{tc.tool}</Text>
          </Box>
        ))}
      </Box>
    )}
    {isStreaming && streamingText && (
      <Box>
        <Text bold color="green">
          {"Assistant: "}
        </Text>
        <MarkdownRenderer text={streamingText} renderer={markdownRenderer} />
      </Box>
    )}
    {isStreaming && !streamingText && !thinkingText && toolCalls.length === 0 && (
      <Box>
        <Text bold color="green">
          {"Assistant: "}
        </Text>
        <Text>{"..."}</Text>
      </Box>
    )}
  </Box>
);
