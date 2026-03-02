// Client ↔ Gateway protocol types

import type { TranscriptMessage } from "./memory.js";
import { isTranscriptMessage } from "./memory.js";

export interface SessionInfo {
  id: string;
  status: "active" | "idle";
  model: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

export type ClientMessage =
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "approval_response"; requestId: string; allow?: boolean; optionId?: string }
  | { type: "cancel"; sessionId: string }
  | { type: "session_new"; runtimeId?: string; model?: string }
  | { type: "session_list" }
  | { type: "session_replay"; sessionId: string };

export type GatewayEvent =
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "tool_start"; sessionId: string; tool: string; toolCallId?: string; params: unknown }
  | { type: "tool_end"; sessionId: string; tool: string; toolCallId?: string; result?: string }
  | {
      type: "approval_request";
      sessionId: string;
      requestId: string;
      tool: string;
      description: string;
      options?: ApprovalOption[];
    }
  | { type: "turn_end"; sessionId: string; stopReason: string }
  | { type: "error"; sessionId: string; message: string }
  | {
      type: "session_created";
      sessionId: string;
      model: string;
      runtimeId?: string;
      modelRouting?: Record<string, string>;
      modelAliases?: Record<string, string>;
      modelCatalog?: Record<string, string[]>;
      runtimeDefaults?: Record<string, string>;
    }
  | { type: "session_list"; sessions: SessionInfo[] }
  | { type: "transcript"; sessionId: string; messages: TranscriptMessage[] };

const CLIENT_MESSAGE_TYPES = new Set([
  "prompt",
  "approval_response",
  "cancel",
  "session_new",
  "session_list",
  "session_replay",
]);

const GATEWAY_EVENT_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "tool_start",
  "tool_end",
  "approval_request",
  "turn_end",
  "error",
  "session_created",
  "session_list",
  "transcript",
]);

const isStringRecord = (value: unknown): value is Record<string, string> => (
  typeof value === "object"
  && value !== null
  && Object.values(value as Record<string, unknown>).every((v) => typeof v === "string")
);

const isStringArrayRecord = (value: unknown): value is Record<string, string[]> => (
  typeof value === "object"
  && value !== null
  && Object.values(value as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((item) => typeof item === "string"),
  )
);

export const isClientMessage = (value: unknown): value is ClientMessage => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || !CLIENT_MESSAGE_TYPES.has(obj.type)) return false;

  switch (obj.type) {
    case "prompt":
      return typeof obj.sessionId === "string" && typeof obj.text === "string";
    case "approval_response":
      return (
        typeof obj.requestId === "string" &&
        (typeof obj.allow === "boolean" || typeof obj.optionId === "string")
      );
    case "cancel":
      return typeof obj.sessionId === "string";
    case "session_new":
      return (
        (obj.runtimeId === undefined || typeof obj.runtimeId === "string")
        && (obj.model === undefined || typeof obj.model === "string")
      );
    case "session_list":
      return true;
    case "session_replay":
      return typeof obj.sessionId === "string";
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
    case "thinking_delta":
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
        typeof obj.description === "string" &&
        (
          obj.options === undefined
          || (
            Array.isArray(obj.options)
            && obj.options.every(
              (opt) => (
                typeof opt === "object"
                && opt !== null
                && typeof (opt as Record<string, unknown>).optionId === "string"
                && typeof (opt as Record<string, unknown>).name === "string"
                && typeof (opt as Record<string, unknown>).kind === "string"
              ),
            )
          )
        )
      );
    case "turn_end":
      return typeof obj.sessionId === "string" && typeof obj.stopReason === "string";
    case "error":
      return typeof obj.sessionId === "string" && typeof obj.message === "string";
    case "session_created":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.model === "string"
        && (obj.runtimeId === undefined || typeof obj.runtimeId === "string")
        && (obj.modelRouting === undefined || isStringRecord(obj.modelRouting))
        && (obj.modelAliases === undefined || isStringRecord(obj.modelAliases))
        && (obj.modelCatalog === undefined || isStringArrayRecord(obj.modelCatalog))
        && (obj.runtimeDefaults === undefined || isStringRecord(obj.runtimeDefaults))
      );
    case "session_list":
      return Array.isArray(obj.sessions);
    case "transcript":
      return (
        typeof obj.sessionId === "string"
        && Array.isArray(obj.messages)
        && obj.messages.every((message) => isTranscriptMessage(message))
      );
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
