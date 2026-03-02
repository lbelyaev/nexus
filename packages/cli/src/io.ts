import {
  isClientMessage,
  type ClientMessage,
  type GatewayEvent,
} from "@nexus/types";

export const parseJsonLine = (line: string): unknown => {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error("Empty input line");
  }
  return JSON.parse(trimmed);
};

export const normalizeClientMessage = (
  input: unknown,
  activeSessionId: string | undefined,
): ClientMessage => {
  if (typeof input !== "object" || input === null) {
    throw new Error("Input must be a JSON object");
  }

  const obj = input as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";

  const maybeWithSession = { ...obj };
  if ((type === "prompt" || type === "cancel") && maybeWithSession.sessionId === undefined) {
    if (!activeSessionId) {
      throw new Error(`${type} message requires sessionId before session is created`);
    }
    maybeWithSession.sessionId = activeSessionId;
  }

  if (!isClientMessage(maybeWithSession)) {
    throw new Error("Invalid ClientMessage payload");
  }

  return maybeWithSession;
};

const serializePrettyEvent = (event: GatewayEvent): string => {
  switch (event.type) {
    case "session_created":
      return `[session_created] session=${event.sessionId} runtime=${event.runtimeId ?? "default"} model=${event.model}`;
    case "text_delta":
      return event.delta;
    case "thinking_delta":
      return `[thinking] ${event.delta}`;
    case "tool_start":
      return `[tool_start] ${event.tool}`;
    case "tool_end":
      return `[tool_end] ${event.tool}`;
    case "approval_request":
      return `[approval_request] requestId=${event.requestId} tool=${event.tool}`;
    case "turn_end":
      return `[turn_end] session=${event.sessionId} stopReason=${event.stopReason}`;
    case "error":
      return `[error] session=${event.sessionId} ${event.message}`;
    case "session_list":
      return `[session_list] ${event.sessions.length} session(s)`;
  }
};

export const serializeGatewayEvent = (
  event: GatewayEvent,
  outputMode: "json" | "pretty",
): string => {
  if (outputMode === "pretty") {
    return serializePrettyEvent(event);
  }
  return JSON.stringify(event);
};
