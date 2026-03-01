import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import type { AuditEvent } from "@nexus/types";
import { initDatabase } from "../migrations.js";
import { createAuditStore } from "../audit.js";

const makeEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  sessionId: "sess-1",
  timestamp: "2025-01-01T00:00:00Z",
  type: "tool_call",
  tool: "Read",
  detail: "Read file /etc/hosts",
  ...overrides,
});

describe("AuditStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createAuditStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    store = createAuditStore(db);
  });

  it("logEvent inserts and getEvents retrieves it", () => {
    const event = makeEvent();
    store.logEvent(event);

    const events = store.getEvents("sess-1");
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("sess-1");
    expect(events[0].detail).toBe("Read file /etc/hosts");
  });

  it("getEvents filters by sessionId", () => {
    store.logEvent(makeEvent({ sessionId: "sess-1" }));
    store.logEvent(makeEvent({ sessionId: "sess-2" }));

    const events = store.getEvents("sess-1");
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("sess-1");
  });

  it("getEvents returns events ordered by timestamp asc", () => {
    store.logEvent(makeEvent({ timestamp: "2025-01-03T00:00:00Z", detail: "third" }));
    store.logEvent(makeEvent({ timestamp: "2025-01-01T00:00:00Z", detail: "first" }));
    store.logEvent(makeEvent({ timestamp: "2025-01-02T00:00:00Z", detail: "second" }));

    const events = store.getEvents("sess-1");
    expect(events.map((e) => e.detail)).toEqual(["first", "second", "third"]);
  });

  it("getEvents returns empty array for session with no events", () => {
    expect(store.getEvents("no-events")).toEqual([]);
  });

  it("logEvent stores all fields correctly", () => {
    const event = makeEvent({
      type: "approval",
      tool: "Bash",
      detail: "Approved command execution",
    });
    store.logEvent(event);

    const events = store.getEvents("sess-1");
    expect(events[0]).toMatchObject({
      sessionId: "sess-1",
      timestamp: "2025-01-01T00:00:00Z",
      type: "approval",
      tool: "Bash",
      detail: "Approved command execution",
    });
    expect(typeof events[0].id).toBe("number");
  });

  it("multiple events across sessions partition correctly", () => {
    store.logEvent(makeEvent({ sessionId: "sess-1", detail: "event-1a" }));
    store.logEvent(makeEvent({ sessionId: "sess-1", detail: "event-1b" }));
    store.logEvent(makeEvent({ sessionId: "sess-2", detail: "event-2a" }));

    const events1 = store.getEvents("sess-1");
    const events2 = store.getEvents("sess-2");

    expect(events1).toHaveLength(2);
    expect(events2).toHaveLength(1);
    expect(events1.map((e) => e.detail)).toEqual(["event-1a", "event-1b"]);
    expect(events2[0].detail).toBe("event-2a");
  });
});
