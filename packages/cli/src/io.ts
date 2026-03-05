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
  if (
    (type === "prompt"
      || type === "cancel"
      || type === "session_close"
      || type === "memory_query"
      || type === "usage_query")
    && maybeWithSession.sessionId === undefined
  ) {
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
    case "session_invalidated":
      return `[session_invalidated] session=${event.sessionId} reason=${event.reason} message=${event.message}`;
    case "session_closed":
      return `[session_closed] session=${event.sessionId} reason=${event.reason}`;
    case "auth_challenge":
      return `[auth_challenge] alg=${event.algorithm} expiresAt=${event.expiresAt}`;
    case "auth_result":
      return `[auth_result] ok=${event.ok}${event.principalId ? ` principal=${event.principalId}` : ""}${event.message ? ` message=${event.message}` : ""}`;
    case "session_transfer_requested":
      return `[session_transfer_requested] session=${event.sessionId} from=${event.fromPrincipalId} to=${event.targetPrincipalId} expiresAt=${event.expiresAt}`;
    case "session_transferred":
      return `[session_transferred] session=${event.sessionId} from=${event.fromPrincipalId} to=${event.targetPrincipalId} at=${event.transferredAt}`;
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
    case "usage_result":
      switch (event.action) {
        case "summary":
          return `[usage] summary tokens=${event.summary.tokens.total} (in=${event.summary.tokens.input}, out=${event.summary.tokens.output}) executions=total:${event.summary.executions.total},queued:${event.summary.executions.queued},running:${event.summary.executions.running},succeeded:${event.summary.executions.succeeded},failed:${event.summary.executions.failed},cancelled:${event.summary.executions.cancelled},timed_out:${event.summary.executions.timedOut}`;
        case "stats":
          return `[usage] stats scope=${event.scope} facts=${event.stats.facts} summaries=${event.stats.summaries} total=${event.stats.total}`;
        case "recent":
          return `[usage] recent scope=${event.scope} count=${event.items.length} limit=${event.limit}`;
        case "search":
          return `[usage] search scope=${event.scope} query="${event.query}" count=${event.items.length} limit=${event.limit}`;
        case "context":
          return `[usage] context scope=${event.scope} tokens=${event.context.totalTokens}/${event.context.budgetTokens} hot=${event.context.hot.length} warm=${event.context.warm.length} cold=${event.context.cold.length}`;
        case "clear":
          return `[usage] clear scope=${event.scope} deleted=${event.deleted}`;
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
