import { describe, it, expect } from "vitest";
import { isSessionRecord, isAuditEvent } from "../state.js";

describe("isSessionRecord", () => {
  const validSession = {
    id: "sess-1",
    workspaceId: "default",
    principalType: "user",
    principalId: "user:local",
    source: "interactive",
    runtimeId: "claude-code",
    acpSessionId: "acp-123",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:01:00Z",
    tokenUsage: { input: 100, output: 50 },
    model: "claude-4",
  };

  it("validates a well-formed session record", () => {
    expect(isSessionRecord(validSession)).toBe(true);
  });

  it("validates idle status", () => {
    expect(isSessionRecord({ ...validSession, status: "idle" })).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(isSessionRecord({ ...validSession, status: "unknown" })).toBe(false);
  });

  it("rejects missing fields", () => {
    const { id, ...noId } = validSession;
    expect(isSessionRecord(noId)).toBe(false);
  });

  it("rejects null tokenUsage", () => {
    expect(isSessionRecord({ ...validSession, tokenUsage: null })).toBe(false);
  });

  it("rejects non-numeric token counts", () => {
    expect(isSessionRecord({ ...validSession, tokenUsage: { input: "100", output: 50 } })).toBe(false);
  });

  it("rejects null and primitives", () => {
    expect(isSessionRecord(null)).toBe(false);
    expect(isSessionRecord("string")).toBe(false);
  });
});

describe("isAuditEvent", () => {
  const validEvent = {
    sessionId: "sess-1",
    timestamp: "2026-01-01T00:00:00Z",
    type: "tool_call",
    detail: "Called Read on file.ts",
  };

  it("validates a well-formed audit event", () => {
    expect(isAuditEvent(validEvent)).toBe(true);
  });

  it("validates all event types", () => {
    for (const type of ["tool_call", "approval", "deny", "error"]) {
      expect(isAuditEvent({ ...validEvent, type })).toBe(true);
    }
  });

  it("accepts optional tool field", () => {
    expect(isAuditEvent({ ...validEvent, tool: "Read" })).toBe(true);
  });

  it("accepts optional id field", () => {
    expect(isAuditEvent({ ...validEvent, id: 42 })).toBe(true);
  });

  it("rejects invalid type", () => {
    expect(isAuditEvent({ ...validEvent, type: "unknown" })).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { detail, ...noDetail } = validEvent;
    expect(isAuditEvent(noDetail)).toBe(false);
  });
});
