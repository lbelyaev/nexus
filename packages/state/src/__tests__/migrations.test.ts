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

  it("is idempotent (calling twice does not error)", () => {
    initDatabase(db);
    expect(() => initDatabase(db)).not.toThrow();
  });

  it("creates indexes on audit_events.sessionId and sessions.status", () => {
    initDatabase(db);

    const indexes = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
      )
      .all() as Array<{ name: string; tbl_name: string }>;

    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_audit_events_sessionId");
    expect(indexNames).toContain("idx_sessions_status");
  });
});
