// State record types

export interface SessionRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  acpSessionId: string;
  status: "active" | "idle";
  createdAt: string;
  lastActivityAt: string;
  tokenUsage: { input: number; output: number };
  model: string;
}

export interface AuditEvent {
  id?: number;
  sessionId: string;
  timestamp: string;
  type: "tool_call" | "approval" | "deny" | "error";
  tool?: string;
  detail: string;
}

const SESSION_STATUSES = new Set(["active", "idle"]);
const AUDIT_TYPES = new Set(["tool_call", "approval", "deny", "error"]);

export const isSessionRecord = (value: unknown): value is SessionRecord => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.workspaceId === "string" &&
    typeof obj.runtimeId === "string" &&
    typeof obj.acpSessionId === "string" &&
    typeof obj.status === "string" &&
    SESSION_STATUSES.has(obj.status) &&
    typeof obj.createdAt === "string" &&
    typeof obj.lastActivityAt === "string" &&
    typeof obj.model === "string" &&
    typeof obj.tokenUsage === "object" &&
    obj.tokenUsage !== null &&
    typeof (obj.tokenUsage as Record<string, unknown>).input === "number" &&
    typeof (obj.tokenUsage as Record<string, unknown>).output === "number"
  );
};

export const isAuditEvent = (value: unknown): value is AuditEvent => {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sessionId === "string" &&
    typeof obj.timestamp === "string" &&
    typeof obj.type === "string" &&
    AUDIT_TYPES.has(obj.type) &&
    typeof obj.detail === "string"
  );
};
