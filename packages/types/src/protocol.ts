// Client ↔ Gateway protocol types

import type { MemoryItem, TranscriptMessage } from "./memory.js";
import { isMemoryItem, isTranscriptMessage } from "./memory.js";

export interface SessionInfo {
  id: string;
  status: "active" | "idle";
  model: string;
  workspaceId?: string;
  principalType?: PrincipalType;
  principalId?: string;
  source?: PromptSource;
  createdAt: string;
  lastActivityAt: string;
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

export type MemoryQueryAction = "stats" | "recent" | "search" | "context" | "clear";
export type MemoryScope = "session" | "workspace" | "hybrid";
export type UsageQueryAction = "summary" | "stats" | "recent" | "search" | "context" | "clear";
export type RuntimeHealthStatus = "starting" | "healthy" | "degraded" | "unavailable";
export type PrincipalType = "user" | "service_account";
export type PromptSource = "interactive" | "schedule" | "hook" | "api";
export type AuthAlgorithm = "ed25519";

export interface RuntimeHealthInfo {
  runtimeId: string;
  status: RuntimeHealthStatus;
  updatedAt: string;
  reason?: string;
}

export interface EventCorrelation {
  executionId?: string;
  parentExecutionId?: string;
  turnId?: string;
  policySnapshotId?: string;
}

export interface PromptImageInput {
  url: string;
  mediaType?: string;
}

export type ClientMessage =
  | {
      type: "prompt";
      sessionId: string;
      text: string;
      images?: PromptImageInput[];
      idempotencyKey?: string;
      parentExecutionId?: string;
    }
  | { type: "approval_response"; requestId: string; allow?: boolean; optionId?: string }
  | { type: "cancel"; sessionId: string }
  | { type: "session_close"; sessionId: string }
  | {
      type: "session_new";
      runtimeId?: string;
      model?: string;
      workspaceId?: string;
      principalType?: PrincipalType;
      principalId?: string;
      source?: PromptSource;
    }
  | {
      type: "session_list";
      limit?: number;
      cursor?: string;
    }
  | { type: "session_replay"; sessionId: string }
  | {
      type: "auth_proof";
      principalType?: PrincipalType;
      principalId: string;
      publicKey: string;
      challengeId: string;
      nonce: string;
      signature: string;
      algorithm?: AuthAlgorithm;
    }
  | {
      type: "session_transfer_request";
      sessionId: string;
      targetPrincipalId: string;
      targetPrincipalType?: PrincipalType;
      expiresInMs?: number;
    }
  | {
      type: "session_transfer_accept";
      sessionId: string;
    }
  | {
      type: "memory_query";
      sessionId: string;
      action: MemoryQueryAction;
      query?: string;
      prompt?: string;
      limit?: number;
      scope?: MemoryScope;
    }
  | {
      type: "usage_query";
      sessionId: string;
      action?: UsageQueryAction;
      query?: string;
      prompt?: string;
      limit?: number;
      scope?: MemoryScope;
    };

export interface MemoryContextSnapshot {
  budgetTokens: number;
  totalTokens: number;
  hot: TranscriptMessage[];
  warm: MemoryItem[];
  cold: MemoryItem[];
  rendered: string;
}

export interface UsageMemoryStats {
  facts: number;
  summaries: number;
  total: number;
  transcriptMessages: number;
  memoryTokens: number;
  transcriptTokens: number;
}

export interface UsageSummary {
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  executions: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    timedOut: number;
  };
  memory?: {
    session: UsageMemoryStats;
    workspace: UsageMemoryStats;
  };
}

export type GatewayEvent =
  | ({ type: "text_delta"; sessionId: string; delta: string } & EventCorrelation)
  | ({ type: "thinking_delta"; sessionId: string; delta: string } & EventCorrelation)
  | ({ type: "tool_start"; sessionId: string; tool: string; toolCallId?: string; params: unknown } & EventCorrelation)
  | ({ type: "tool_end"; sessionId: string; tool: string; toolCallId?: string; result?: string } & EventCorrelation)
  | {
      type: "approval_request";
      sessionId: string;
      requestId: string;
      tool: string;
      description: string;
      options?: ApprovalOption[];
    } & EventCorrelation
  | ({ type: "turn_end"; sessionId: string; stopReason: string } & EventCorrelation)
  | ({ type: "error"; sessionId: string; message: string } & EventCorrelation)
  | {
      type: "session_created";
      sessionId: string;
      model: string;
      runtimeId?: string;
      workspaceId?: string;
      principalType?: PrincipalType;
      principalId?: string;
      source?: PromptSource;
      modelRouting?: Record<string, string>;
      modelAliases?: Record<string, string>;
      modelCatalog?: Record<string, string[]>;
      runtimeDefaults?: Record<string, string>;
    }
  | {
      type: "session_invalidated";
      sessionId: string;
      reason: string;
      message: string;
    }
  | { type: "session_closed"; sessionId: string; reason: string }
  | {
      type: "auth_challenge";
      algorithm: AuthAlgorithm;
      challengeId: string;
      nonce: string;
      issuedAt: string;
      expiresAt: string;
    }
  | {
      type: "auth_result";
      ok: boolean;
      principalType?: PrincipalType;
      principalId?: string;
      message?: string;
    }
  | {
      type: "session_transfer_requested";
      sessionId: string;
      fromPrincipalType: PrincipalType;
      fromPrincipalId: string;
      targetPrincipalType: PrincipalType;
      targetPrincipalId: string;
      expiresAt: string;
    }
  | {
      type: "session_transferred";
      sessionId: string;
      fromPrincipalType: PrincipalType;
      fromPrincipalId: string;
      targetPrincipalType: PrincipalType;
      targetPrincipalId: string;
      transferredAt: string;
    }
  | { type: "runtime_health"; runtime: RuntimeHealthInfo }
  | {
      type: "session_list";
      sessions: SessionInfo[];
      hasMore?: boolean;
      nextCursor?: string;
    }
  | { type: "transcript"; sessionId: string; messages: TranscriptMessage[] }
  | {
      type: "memory_result";
      sessionId: string;
      action: "stats";
      scope: Exclude<MemoryScope, "hybrid">;
      stats: {
        facts: number;
        summaries: number;
        total: number;
        transcriptMessages: number;
        memoryTokens: number;
        transcriptTokens: number;
      };
    }
  | {
      type: "memory_result";
      sessionId: string;
      action: "recent";
      scope: Exclude<MemoryScope, "hybrid">;
      limit: number;
      items: MemoryItem[];
    }
  | {
      type: "memory_result";
      sessionId: string;
      action: "search";
      scope: Exclude<MemoryScope, "hybrid">;
      query: string;
      limit: number;
      items: MemoryItem[];
    }
  | {
      type: "memory_result";
      sessionId: string;
      action: "context";
      scope: MemoryScope;
      prompt: string;
      context: MemoryContextSnapshot;
    }
  | {
      type: "memory_result";
      sessionId: string;
      action: "clear";
      scope: Exclude<MemoryScope, "hybrid">;
      deleted: number;
    }
  | {
      type: "usage_result";
      sessionId: string;
      action: "summary";
      summary: UsageSummary;
    }
  | {
      type: "usage_result";
      sessionId: string;
      action: "stats";
      scope: Exclude<MemoryScope, "hybrid">;
      stats: UsageMemoryStats;
    }
  | {
      type: "usage_result";
      sessionId: string;
      action: "recent";
      scope: Exclude<MemoryScope, "hybrid">;
      limit: number;
      items: MemoryItem[];
    }
  | {
      type: "usage_result";
      sessionId: string;
      action: "search";
      scope: Exclude<MemoryScope, "hybrid">;
      query: string;
      limit: number;
      items: MemoryItem[];
    }
  | {
      type: "usage_result";
      sessionId: string;
      action: "context";
      scope: MemoryScope;
      prompt: string;
      context: MemoryContextSnapshot;
    }
  | {
      type: "usage_result";
      sessionId: string;
      action: "clear";
      scope: Exclude<MemoryScope, "hybrid">;
      deleted: number;
    };

const CLIENT_MESSAGE_TYPES = new Set([
  "prompt",
  "approval_response",
  "cancel",
  "session_close",
  "session_new",
  "session_list",
  "session_replay",
  "auth_proof",
  "session_transfer_request",
  "session_transfer_accept",
  "memory_query",
  "usage_query",
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
  "session_invalidated",
  "session_closed",
  "auth_challenge",
  "auth_result",
  "session_transfer_requested",
  "session_transferred",
  "runtime_health",
  "session_list",
  "transcript",
  "memory_result",
  "usage_result",
]);

const MEMORY_QUERY_ACTIONS = new Set<MemoryQueryAction>([
  "stats",
  "recent",
  "search",
  "context",
  "clear",
]);

const MEMORY_SCOPES = new Set<MemoryScope>([
  "session",
  "workspace",
  "hybrid",
]);

const USAGE_QUERY_ACTIONS = new Set<UsageQueryAction>([
  "summary",
  "stats",
  "recent",
  "search",
  "context",
  "clear",
]);

const PRINCIPAL_TYPES = new Set<PrincipalType>([
  "user",
  "service_account",
]);

const PROMPT_SOURCES = new Set<PromptSource>([
  "interactive",
  "schedule",
  "hook",
  "api",
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

const isMemoryContextSnapshot = (value: unknown): value is MemoryContextSnapshot => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.budgetTokens === "number"
    && typeof obj.totalTokens === "number"
    && typeof obj.rendered === "string"
    && Array.isArray(obj.hot)
    && obj.hot.every((entry) => isTranscriptMessage(entry))
    && Array.isArray(obj.warm)
    && obj.warm.every((entry) => isMemoryItem(entry))
    && Array.isArray(obj.cold)
    && obj.cold.every((entry) => isMemoryItem(entry))
  );
};

const hasValidCorrelation = (obj: Record<string, unknown>): boolean => (
  (obj.executionId === undefined || typeof obj.executionId === "string")
  && (obj.parentExecutionId === undefined || typeof obj.parentExecutionId === "string")
  && (obj.turnId === undefined || typeof obj.turnId === "string")
  && (obj.policySnapshotId === undefined || typeof obj.policySnapshotId === "string")
);

const isPromptImageInput = (value: unknown): value is PromptImageInput => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.url === "string"
    && obj.url.trim().length > 0
    && (obj.mediaType === undefined || typeof obj.mediaType === "string")
  );
};

export const isClientMessage = (value: unknown): value is ClientMessage => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || !CLIENT_MESSAGE_TYPES.has(obj.type)) return false;

  switch (obj.type) {
    case "prompt":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.text === "string"
        && (obj.images === undefined || (Array.isArray(obj.images) && obj.images.every((entry) => isPromptImageInput(entry))))
        && (obj.idempotencyKey === undefined || typeof obj.idempotencyKey === "string")
        && (obj.parentExecutionId === undefined || typeof obj.parentExecutionId === "string")
      );
    case "approval_response":
      return (
        typeof obj.requestId === "string" &&
        (typeof obj.allow === "boolean" || typeof obj.optionId === "string")
      );
    case "cancel":
      return typeof obj.sessionId === "string";
    case "session_close":
      return typeof obj.sessionId === "string";
    case "session_new":
      return (
        (obj.runtimeId === undefined || typeof obj.runtimeId === "string")
        && (obj.model === undefined || typeof obj.model === "string")
        && (obj.workspaceId === undefined || typeof obj.workspaceId === "string")
        && (obj.principalType === undefined || (typeof obj.principalType === "string" && PRINCIPAL_TYPES.has(obj.principalType as PrincipalType)))
        && (obj.principalId === undefined || typeof obj.principalId === "string")
        && (obj.source === undefined || (typeof obj.source === "string" && PROMPT_SOURCES.has(obj.source as PromptSource)))
      );
    case "session_list":
      return (
        (
          obj.limit === undefined
          || (typeof obj.limit === "number" && Number.isFinite(obj.limit) && obj.limit > 0)
        )
        && (obj.cursor === undefined || typeof obj.cursor === "string")
      );
    case "session_replay":
      return typeof obj.sessionId === "string";
    case "auth_proof":
      return (
        typeof obj.principalId === "string"
        && typeof obj.publicKey === "string"
        && typeof obj.challengeId === "string"
        && typeof obj.nonce === "string"
        && typeof obj.signature === "string"
        && (obj.principalType === undefined || (typeof obj.principalType === "string" && PRINCIPAL_TYPES.has(obj.principalType as PrincipalType)))
        && (obj.algorithm === undefined || obj.algorithm === "ed25519")
      );
    case "session_transfer_request":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.targetPrincipalId === "string"
        && (obj.targetPrincipalType === undefined || (typeof obj.targetPrincipalType === "string" && PRINCIPAL_TYPES.has(obj.targetPrincipalType as PrincipalType)))
        && (
          obj.expiresInMs === undefined
          || (typeof obj.expiresInMs === "number" && Number.isFinite(obj.expiresInMs) && obj.expiresInMs > 0)
        )
      );
    case "session_transfer_accept":
      return typeof obj.sessionId === "string";
    case "memory_query":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.action === "string"
        && MEMORY_QUERY_ACTIONS.has(obj.action as MemoryQueryAction)
        && (obj.query === undefined || typeof obj.query === "string")
        && (obj.prompt === undefined || typeof obj.prompt === "string")
        && (
          obj.limit === undefined
          || (typeof obj.limit === "number" && Number.isFinite(obj.limit) && obj.limit > 0)
        )
        && (obj.scope === undefined || (typeof obj.scope === "string" && MEMORY_SCOPES.has(obj.scope as MemoryScope)))
      );
    case "usage_query":
      return (
        typeof obj.sessionId === "string"
        && (
          obj.action === undefined
          || (typeof obj.action === "string" && USAGE_QUERY_ACTIONS.has(obj.action as UsageQueryAction))
        )
        && (obj.query === undefined || typeof obj.query === "string")
        && (obj.prompt === undefined || typeof obj.prompt === "string")
        && (
          obj.limit === undefined
          || (typeof obj.limit === "number" && Number.isFinite(obj.limit) && obj.limit > 0)
        )
        && (obj.scope === undefined || (typeof obj.scope === "string" && MEMORY_SCOPES.has(obj.scope as MemoryScope)))
      );
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
      return (
        typeof obj.sessionId === "string"
        && typeof obj.delta === "string"
        && hasValidCorrelation(obj)
      );
    case "tool_start":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.tool === "string"
        && hasValidCorrelation(obj)
      );
    case "tool_end":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.tool === "string"
        && hasValidCorrelation(obj)
      );
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
        && hasValidCorrelation(obj)
      );
    case "turn_end":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.stopReason === "string"
        && hasValidCorrelation(obj)
      );
    case "error":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.message === "string"
        && hasValidCorrelation(obj)
      );
    case "session_created":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.model === "string"
        && (obj.runtimeId === undefined || typeof obj.runtimeId === "string")
        && (obj.workspaceId === undefined || typeof obj.workspaceId === "string")
        && (obj.principalType === undefined || (typeof obj.principalType === "string" && PRINCIPAL_TYPES.has(obj.principalType as PrincipalType)))
        && (obj.principalId === undefined || typeof obj.principalId === "string")
        && (obj.source === undefined || (typeof obj.source === "string" && PROMPT_SOURCES.has(obj.source as PromptSource)))
        && (obj.modelRouting === undefined || isStringRecord(obj.modelRouting))
        && (obj.modelAliases === undefined || isStringRecord(obj.modelAliases))
        && (obj.modelCatalog === undefined || isStringArrayRecord(obj.modelCatalog))
        && (obj.runtimeDefaults === undefined || isStringRecord(obj.runtimeDefaults))
      );
    case "session_invalidated":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.reason === "string"
        && typeof obj.message === "string"
      );
    case "session_closed":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.reason === "string"
      );
    case "auth_challenge":
      return (
        obj.algorithm === "ed25519"
        && typeof obj.challengeId === "string"
        && typeof obj.nonce === "string"
        && typeof obj.issuedAt === "string"
        && typeof obj.expiresAt === "string"
      );
    case "auth_result":
      return (
        typeof obj.ok === "boolean"
        && (obj.principalType === undefined || (typeof obj.principalType === "string" && PRINCIPAL_TYPES.has(obj.principalType as PrincipalType)))
        && (obj.principalId === undefined || typeof obj.principalId === "string")
        && (obj.message === undefined || typeof obj.message === "string")
      );
    case "session_transfer_requested":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.fromPrincipalType === "string"
        && PRINCIPAL_TYPES.has(obj.fromPrincipalType as PrincipalType)
        && typeof obj.fromPrincipalId === "string"
        && typeof obj.targetPrincipalType === "string"
        && PRINCIPAL_TYPES.has(obj.targetPrincipalType as PrincipalType)
        && typeof obj.targetPrincipalId === "string"
        && typeof obj.expiresAt === "string"
      );
    case "session_transferred":
      return (
        typeof obj.sessionId === "string"
        && typeof obj.fromPrincipalType === "string"
        && PRINCIPAL_TYPES.has(obj.fromPrincipalType as PrincipalType)
        && typeof obj.fromPrincipalId === "string"
        && typeof obj.targetPrincipalType === "string"
        && PRINCIPAL_TYPES.has(obj.targetPrincipalType as PrincipalType)
        && typeof obj.targetPrincipalId === "string"
        && typeof obj.transferredAt === "string"
      );
    case "runtime_health":
      return (
        typeof obj.runtime === "object"
        && obj.runtime !== null
        && typeof (obj.runtime as Record<string, unknown>).runtimeId === "string"
        && typeof (obj.runtime as Record<string, unknown>).status === "string"
        && (
          (obj.runtime as Record<string, unknown>).status === "starting"
          || (obj.runtime as Record<string, unknown>).status === "healthy"
          || (obj.runtime as Record<string, unknown>).status === "degraded"
          || (obj.runtime as Record<string, unknown>).status === "unavailable"
        )
        && typeof (obj.runtime as Record<string, unknown>).updatedAt === "string"
        && (
          (obj.runtime as Record<string, unknown>).reason === undefined
          || typeof (obj.runtime as Record<string, unknown>).reason === "string"
        )
      );
    case "session_list":
      return (
        Array.isArray(obj.sessions)
        && (obj.hasMore === undefined || typeof obj.hasMore === "boolean")
        && (obj.nextCursor === undefined || typeof obj.nextCursor === "string")
      );
    case "transcript":
      return (
        typeof obj.sessionId === "string"
        && Array.isArray(obj.messages)
        && obj.messages.every((message) => isTranscriptMessage(message))
      );
    case "memory_result":
      if (typeof obj.sessionId !== "string" || typeof obj.action !== "string") return false;
      switch (obj.action) {
        case "stats":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.stats === "object"
            && obj.stats !== null
            && typeof (obj.stats as Record<string, unknown>).facts === "number"
            && typeof (obj.stats as Record<string, unknown>).summaries === "number"
            && typeof (obj.stats as Record<string, unknown>).total === "number"
            && typeof (obj.stats as Record<string, unknown>).transcriptMessages === "number"
            && typeof (obj.stats as Record<string, unknown>).memoryTokens === "number"
            && typeof (obj.stats as Record<string, unknown>).transcriptTokens === "number"
          );
        case "recent":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.limit === "number"
            && Array.isArray(obj.items)
            && obj.items.every((item) => isMemoryItem(item))
          );
        case "search":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.query === "string"
            && typeof obj.limit === "number"
            && Array.isArray(obj.items)
            && obj.items.every((item) => isMemoryItem(item))
          );
        case "context":
          return (
            typeof obj.scope === "string"
            && MEMORY_SCOPES.has(obj.scope as MemoryScope)
            && typeof obj.prompt === "string"
            && isMemoryContextSnapshot(obj.context)
          );
        case "clear":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.deleted === "number"
          );
        default:
          return false;
      }
    case "usage_result":
      if (typeof obj.sessionId !== "string" || typeof obj.action !== "string") return false;
      switch (obj.action) {
        case "summary":
          return (
            typeof obj.summary === "object"
            && obj.summary !== null
            && typeof (obj.summary as Record<string, unknown>).tokens === "object"
            && (obj.summary as Record<string, unknown>).tokens !== null
            && typeof ((obj.summary as Record<string, unknown>).tokens as Record<string, unknown>).input === "number"
            && typeof ((obj.summary as Record<string, unknown>).tokens as Record<string, unknown>).output === "number"
            && typeof ((obj.summary as Record<string, unknown>).tokens as Record<string, unknown>).total === "number"
            && typeof (obj.summary as Record<string, unknown>).executions === "object"
            && (obj.summary as Record<string, unknown>).executions !== null
            && typeof ((obj.summary as Record<string, unknown>).executions as Record<string, unknown>).total === "number"
            && typeof ((obj.summary as Record<string, unknown>).executions as Record<string, unknown>).queued === "number"
            && typeof ((obj.summary as Record<string, unknown>).executions as Record<string, unknown>).running === "number"
            && typeof ((obj.summary as Record<string, unknown>).executions as Record<string, unknown>).succeeded === "number"
            && typeof ((obj.summary as Record<string, unknown>).executions as Record<string, unknown>).failed === "number"
            && typeof ((obj.summary as Record<string, unknown>).executions as Record<string, unknown>).cancelled === "number"
            && typeof ((obj.summary as Record<string, unknown>).executions as Record<string, unknown>).timedOut === "number"
            && (
              (obj.summary as Record<string, unknown>).memory === undefined
              || (
                typeof (obj.summary as Record<string, unknown>).memory === "object"
                && (obj.summary as Record<string, unknown>).memory !== null
                && typeof ((obj.summary as Record<string, unknown>).memory as Record<string, unknown>).session === "object"
                && typeof ((obj.summary as Record<string, unknown>).memory as Record<string, unknown>).workspace === "object"
              )
            )
          );
        case "stats":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.stats === "object"
            && obj.stats !== null
            && typeof (obj.stats as Record<string, unknown>).facts === "number"
            && typeof (obj.stats as Record<string, unknown>).summaries === "number"
            && typeof (obj.stats as Record<string, unknown>).total === "number"
            && typeof (obj.stats as Record<string, unknown>).transcriptMessages === "number"
            && typeof (obj.stats as Record<string, unknown>).memoryTokens === "number"
            && typeof (obj.stats as Record<string, unknown>).transcriptTokens === "number"
          );
        case "recent":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.limit === "number"
            && Array.isArray(obj.items)
            && obj.items.every((item) => isMemoryItem(item))
          );
        case "search":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.query === "string"
            && typeof obj.limit === "number"
            && Array.isArray(obj.items)
            && obj.items.every((item) => isMemoryItem(item))
          );
        case "context":
          return (
            typeof obj.scope === "string"
            && MEMORY_SCOPES.has(obj.scope as MemoryScope)
            && typeof obj.prompt === "string"
            && isMemoryContextSnapshot(obj.context)
          );
        case "clear":
          return (
            typeof obj.scope === "string"
            && (obj.scope === "session" || obj.scope === "workspace")
            && typeof obj.deleted === "number"
          );
        default:
          return false;
      }
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
