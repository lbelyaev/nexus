import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import { initDatabase } from "../migrations.js";
import { createSessionStore } from "../sessions.js";
import { createSessionEventStore } from "../sessionEvents.js";
import type { SessionRecord } from "@nexus/types";

const makeSession = (id: string): SessionRecord => ({
  id,
  workspaceId: "default",
  principalType: "user",
  principalId: "user:local",
  source: "interactive",
  runtimeId: "rt-1",
  acpSessionId: "acp-1",
  status: "active",
  lifecycleState: "live",
  lifecycleUpdatedAt: "2025-01-01T00:00:00Z",
  lifecycleVersion: 0,
  createdAt: "2025-01-01T00:00:00Z",
  lastActivityAt: "2025-01-01T00:00:00Z",
  tokenUsage: { input: 0, output: 0 },
  model: "claude-opus-4-20250514",
});

describe("SessionEventStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createSessionEventStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    const sessions = createSessionStore(db);
    sessions.createSession(makeSession("sess-1"));
    sessions.createSession(makeSession("sess-2"));
    store = createSessionEventStore(db);
  });

  it("appendSessionEvent stores events and returns incrementing ids", () => {
    const firstId = store.appendSessionEvent({
      type: "text_delta",
      sessionId: "sess-1",
      delta: "hello",
      executionId: "exec-1",
      turnId: "turn-1",
    });
    const secondId = store.appendSessionEvent({
      type: "turn_end",
      sessionId: "sess-1",
      stopReason: "end_turn",
      executionId: "exec-1",
      turnId: "turn-1",
    });

    expect(firstId).toBe(1);
    expect(secondId).toBe(2);

    const events = store.getSessionEvents("sess-1");
    expect(events).toHaveLength(2);
    expect(events[0]?.payload.type).toBe("text_delta");
    expect(events[0]?.executionId).toBe("exec-1");
    expect(events[0]?.turnId).toBe("turn-1");
    expect(events[1]?.payload.type).toBe("turn_end");
  });

  it("getSessionEvents filters by sessionId and afterId", () => {
    store.appendSessionEvent({
      type: "text_delta",
      sessionId: "sess-1",
      delta: "first",
    });
    const secondId = store.appendSessionEvent({
      type: "text_delta",
      sessionId: "sess-1",
      delta: "second",
    });
    store.appendSessionEvent({
      type: "text_delta",
      sessionId: "sess-2",
      delta: "other-session",
    });

    const events = store.getSessionEvents("sess-1", { afterId: secondId - 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ type: "text_delta", delta: "second" });
  });

  it("getSessionEvents filters by type, executionId, and limit", () => {
    store.appendSessionEvent({
      type: "text_delta",
      sessionId: "sess-1",
      delta: "ignored",
      executionId: "exec-1",
    });
    store.appendSessionEvent({
      type: "tool_start",
      sessionId: "sess-1",
      tool: "Read",
      params: { path: "/tmp/a" },
      executionId: "exec-2",
    });
    store.appendSessionEvent({
      type: "tool_end",
      sessionId: "sess-1",
      tool: "Read",
      result: "ok",
      executionId: "exec-2",
    });

    const events = store.getSessionEvents("sess-1", {
      types: ["tool_start", "tool_end"],
      executionId: "exec-2",
      limit: 1,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload.type).toBe("tool_start");
  });

  it("getLatestSessionEventId and countSessionEvents reflect stored rows", () => {
    expect(store.getLatestSessionEventId("sess-1")).toBeUndefined();
    expect(store.countSessionEvents("sess-1")).toBe(0);

    store.appendSessionEvent({
      type: "session_created",
      sessionId: "sess-1",
      model: "claude",
    });
    const latestId = store.appendSessionEvent({
      type: "session_updated",
      sessionId: "sess-1",
      displayName: "Renamed",
    });

    expect(store.getLatestSessionEventId("sess-1")).toBe(latestId);
    expect(store.countSessionEvents("sess-1")).toBe(2);
  });

  it("deleteSessionEvents removes only the targeted session history", () => {
    store.appendSessionEvent({
      type: "error",
      sessionId: "sess-1",
      message: "boom",
    });
    store.appendSessionEvent({
      type: "error",
      sessionId: "sess-2",
      message: "other",
    });

    store.deleteSessionEvents("sess-1");

    expect(store.getSessionEvents("sess-1")).toEqual([]);
    expect(store.countSessionEvents("sess-2")).toBe(1);
  });
});
