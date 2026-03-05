import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import { initDatabase } from "../migrations.js";

describe("initDatabase", () => {
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("creates sessions table with correct columns", () => {
    initDatabase(db);

    const columns = db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("workspaceId");
    expect(columnNames).toContain("principalType");
    expect(columnNames).toContain("principalId");
    expect(columnNames).toContain("source");
    expect(columnNames).toContain("runtimeId");
    expect(columnNames).toContain("acpSessionId");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("createdAt");
    expect(columnNames).toContain("lastActivityAt");
    expect(columnNames).toContain("tokenInput");
    expect(columnNames).toContain("tokenOutput");
    expect(columnNames).toContain("model");
  });

  it("creates audit_events table with correct columns", () => {
    initDatabase(db);

    const columns = db
      .prepare("PRAGMA table_info(audit_events)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("sessionId");
    expect(columnNames).toContain("timestamp");
    expect(columnNames).toContain("type");
    expect(columnNames).toContain("tool");
    expect(columnNames).toContain("detail");
  });

  it("creates transcript_messages table with correct columns", () => {
    initDatabase(db);

    const columns = db
      .prepare("PRAGMA table_info(transcript_messages)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("workspaceId");
    expect(columnNames).toContain("sessionId");
    expect(columnNames).toContain("role");
    expect(columnNames).toContain("content");
    expect(columnNames).toContain("toolName");
    expect(columnNames).toContain("toolCallId");
    expect(columnNames).toContain("timestamp");
    expect(columnNames).toContain("tokenEstimate");
  });

  it("creates memory_items table with correct columns", () => {
    initDatabase(db);

    const columns = db
      .prepare("PRAGMA table_info(memory_items)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("sessionId");
    expect(columnNames).toContain("kind");
    expect(columnNames).toContain("content");
    expect(columnNames).toContain("source");
    expect(columnNames).toContain("confidence");
    expect(columnNames).toContain("keywords");
    expect(columnNames).toContain("createdAt");
    expect(columnNames).toContain("lastAccessedAt");
    expect(columnNames).toContain("tokenEstimate");
  });

  it("creates executions table with correct columns", () => {
    initDatabase(db);

    const columns = db
      .prepare("PRAGMA table_info(executions)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("sessionId");
    expect(columnNames).toContain("turnId");
    expect(columnNames).toContain("parentExecutionId");
    expect(columnNames).toContain("idempotencyKey");
    expect(columnNames).toContain("workspaceId");
    expect(columnNames).toContain("principalType");
    expect(columnNames).toContain("principalId");
    expect(columnNames).toContain("source");
    expect(columnNames).toContain("runtimeId");
    expect(columnNames).toContain("model");
    expect(columnNames).toContain("policySnapshotId");
    expect(columnNames).toContain("state");
    expect(columnNames).toContain("stopReason");
    expect(columnNames).toContain("errorMessage");
    expect(columnNames).toContain("createdAt");
    expect(columnNames).toContain("updatedAt");
    expect(columnNames).toContain("startedAt");
    expect(columnNames).toContain("completedAt");
  });

  it("creates channel_bindings table with correct columns", () => {
    initDatabase(db);

    const columns = db
      .prepare("PRAGMA table_info(channel_bindings)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("adapterId");
    expect(columnNames).toContain("conversationId");
    expect(columnNames).toContain("sessionId");
    expect(columnNames).toContain("principalType");
    expect(columnNames).toContain("principalId");
    expect(columnNames).toContain("runtimeId");
    expect(columnNames).toContain("model");
    expect(columnNames).toContain("workspaceId");
    expect(columnNames).toContain("typingIndicator");
    expect(columnNames).toContain("streamingMode");
    expect(columnNames).toContain("steeringMode");
    expect(columnNames).toContain("createdAt");
    expect(columnNames).toContain("updatedAt");
  });

  it("is idempotent (calling twice does not error)", () => {
    initDatabase(db);
    expect(() => initDatabase(db)).not.toThrow();
  });

  it("creates indexes for sessions, audit, transcript, and memory", () => {
    initDatabase(db);

    const indexes = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
      )
      .all() as Array<{ name: string; tbl_name: string }>;

    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_audit_events_sessionId");
    expect(indexNames).toContain("idx_sessions_status");
    expect(indexNames).toContain("idx_sessions_workspaceId");
    expect(indexNames).toContain("idx_transcript_sessionId");
    expect(indexNames).toContain("idx_transcript_workspaceId_session");
    expect(indexNames).toContain("idx_memory_items_session_kind_createdAt");
    expect(indexNames).toContain("idx_memory_items_session_lastAccessedAt");
    expect(indexNames).toContain("idx_memory_items_workspace_kind_createdAt");
    expect(indexNames).toContain("idx_executions_session_createdAt");
    expect(indexNames).toContain("idx_executions_parentExecutionId");
    expect(indexNames).toContain("idx_executions_state_updatedAt");
    expect(indexNames).toContain("idx_executions_session_idempotencyKey");
    expect(indexNames).toContain("idx_channel_bindings_sessionId");
    expect(indexNames).toContain("idx_channel_bindings_principal");
  });
});
