import type { TranscriptMessage } from "@nexus/types";
import type { ChatMessage } from "./chatMerge";

const formatToolTranscript = (message: TranscriptMessage): string => {
  const toolLabel = message.toolName?.trim() || "Tool";
  const content = message.content.trim();
  if (!content) return `[${toolLabel}]`;
  return `[${toolLabel}] ${content}`;
};

export const transcriptToChatMessages = (
  transcript: TranscriptMessage[],
): ChatMessage[] => transcript.map((message) => {
  switch (message.role) {
    case "assistant":
      return {
        id: `transcript-${message.id}`,
        role: "assistant",
        text: message.content,
      };
    case "user":
      return {
        id: `transcript-${message.id}`,
        role: "user",
        text: message.content,
      };
    case "tool":
      return {
        id: `transcript-${message.id}`,
        role: "system",
        text: formatToolTranscript(message),
      };
    case "system":
      return {
        id: `transcript-${message.id}`,
        role: "system",
        text: message.content,
      };
  }
});
