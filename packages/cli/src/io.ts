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
  if ((type === "prompt" || type === "cancel" || type === "session_close") && maybeWithSession.sessionId === undefined) {
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
      return `[session_created] session=${event.sessionId} runtime=${event.runtimeId ?? "default"} model=${event.model} principal=${event.principalType ?? "user"}:${event.principalId ?? "user:local"} source=${event.source ?? "interactive"}`;
    case "session_closed":
      return `[session_closed] session=${event.sessionId} reason=${event.reason}`;
    case "runtime_health":
      return `[runtime_health] runtime=${event.runtime.runtimeId} status=${event.runtime.status}${event.runtime.reason ? ` reason=${event.runtime.reason}` : ""}`;
    case "text_delta":
      return event.delta;
    case "thinking_delta":
      return `[thinking] ${event.delta}`;
    case "tool_start":
      return `[tool_start] ${event.tool}${event.executionId ? ` exec=${event.executionId}` : ""}${event.turnId ? ` turn=${event.turnId}` : ""}`;
    case "tool_end":
      return `[tool_end] ${event.tool}${event.executionId ? ` exec=${event.executionId}` : ""}${event.turnId ? ` turn=${event.turnId}` : ""}`;
    case "approval_request":
      return `[approval_request] requestId=${event.requestId} tool=${event.tool}`;
    case "turn_end":
      return `[turn_end] session=${event.sessionId} stopReason=${event.stopReason}${event.executionId ? ` exec=${event.executionId}` : ""}${event.turnId ? ` turn=${event.turnId}` : ""}`;
    case "error":
      return `[error] session=${event.sessionId} ${event.message}`;
    case "session_list":
      return `[session_list] ${event.sessions.length} session(s)`;
    case "transcript":
      return `[transcript] session=${event.sessionId} messages=${event.messages.length}`;
    case "memory_result":
      switch (event.action) {
        case "stats":
          return `[memory] stats scope=${event.scope} facts=${event.stats.facts} summaries=${event.stats.summaries} total=${event.stats.total}`;
        case "recent":
          return `[memory] recent scope=${event.scope} count=${event.items.length} limit=${event.limit}`;
        case "search":
          return `[memory] search scope=${event.scope} query="${event.query}" count=${event.items.length} limit=${event.limit}`;
        case "context":
          return `[memory] context scope=${event.scope} tokens=${event.context.totalTokens}/${event.context.budgetTokens} hot=${event.context.hot.length} warm=${event.context.warm.length} cold=${event.context.cold.length}`;
        case "clear":
          return `[memory] clear scope=${event.scope} deleted=${event.deleted}`;
      }
    default: {
      const _exhaustive: never = event;
      return `[event] ${JSON.stringify(_exhaustive)}`;
    }
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
