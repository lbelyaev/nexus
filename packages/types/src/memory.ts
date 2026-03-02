// Transcript and memory types

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface TranscriptMessage {
  id: number;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolName?: string;
  toolCallId?: string;
  timestamp: string;
  tokenEstimate: number;
}

const MESSAGE_ROLES = new Set(["user", "assistant", "tool", "system"]);

export const isTranscriptMessage = (value: unknown): value is TranscriptMessage => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "number" &&
    typeof obj.sessionId === "string" &&
    typeof obj.role === "string" &&
    MESSAGE_ROLES.has(obj.role) &&
    typeof obj.content === "string" &&
    typeof obj.timestamp === "string" &&
    typeof obj.tokenEstimate === "number" &&
    (obj.toolName === undefined || typeof obj.toolName === "string") &&
    (obj.toolCallId === undefined || typeof obj.toolCallId === "string")
  );
};

/** Rough token estimate: ~4 chars per token for English text. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
