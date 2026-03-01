// Client ↔ Gateway protocol types

export interface SessionInfo {
  id: string;
  status: "active" | "idle";
  model: string;
  createdAt: string;
  lastActivityAt: string;
}

export type ClientMessage =
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "approval_response"; requestId: string; allow: boolean }
  | { type: "cancel"; sessionId: string }
  | { type: "session_new"; runtimeId?: string }
  | { type: "session_list" };

export type GatewayEvent =
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "tool_start"; sessionId: string; tool: string; params: unknown }
  | { type: "tool_end"; sessionId: string; tool: string; result?: string }
  | { type: "approval_request"; sessionId: string; requestId: string; tool: string; description: string }
  | { type: "turn_end"; sessionId: string; stopReason: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "session_created"; sessionId: string; model: string }
  | { type: "session_list"; sessions: SessionInfo[] };

const CLIENT_MESSAGE_TYPES = new Set([
  "prompt",
  "approval_response",
  "cancel",
  "session_new",
  "session_list",
]);

const GATEWAY_EVENT_TYPES = new Set([
  "text_delta",
  "tool_start",
  "tool_end",
  "approval_request",
  "turn_end",
  "error",
  "session_created",
  "session_list",
]);

export const isClientMessage = (value: unknown): value is ClientMessage => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || !CLIENT_MESSAGE_TYPES.has(obj.type)) return false;

  switch (obj.type) {
    case "prompt":
      return typeof obj.sessionId === "string" && typeof obj.text === "string";
    case "approval_response":
      return typeof obj.requestId === "string" && typeof obj.allow === "boolean";
    case "cancel":
      return typeof obj.sessionId === "string";
    case "session_new":
      return obj.runtimeId === undefined || typeof obj.runtimeId === "string";
    case "session_list":
      return true;
    default:
      return false;
  }
};

export const isGatewayEvent = (value: unknown): value is GatewayEvent => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || !GATEWAY_EVENT_TYPES.has(obj.type)) return false;

  switch (obj.type) {
    case "text_delta":
      return typeof obj.sessionId === "string" && typeof obj.delta === "string";
    case "tool_start":
      return typeof obj.sessionId === "string" && typeof obj.tool === "string";
    case "tool_end":
      return typeof obj.sessionId === "string" && typeof obj.tool === "string";
    case "approval_request":
      return (
        typeof obj.sessionId === "string" &&
        typeof obj.requestId === "string" &&
        typeof obj.tool === "string" &&
        typeof obj.description === "string"
      );
    case "turn_end":
      return typeof obj.sessionId === "string" && typeof obj.stopReason === "string";
    case "error":
      return typeof obj.sessionId === "string" && typeof obj.message === "string";
    case "session_created":
      return typeof obj.sessionId === "string" && typeof obj.model === "string";
    case "session_list":
      return Array.isArray(obj.sessions);
    default:
      return false;
  }
};

export const parseClientMessage = (json: string): ClientMessage => {
  const parsed = JSON.parse(json);
  if (!isClientMessage(parsed)) {
    throw new Error(`Invalid client message: ${json}`);
  }
  return parsed;
};
