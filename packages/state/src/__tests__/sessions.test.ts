import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import type { SessionRecord } from "@nexus/types";
import { initDatabase } from "../migrations.js";
import { createSessionStore } from "../sessions.js";

const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "sess-1",
  workspaceId: "default",
  ownerDid: "did:key:z6Mkowner",
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
  ...overrides,
});

describe("SessionStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    store = createSessionStore(db);
  });

  it("createSession inserts and getSession retrieves it", () => {
    const session = makeSession();
    store.createSession(session);

    const retrieved = store.getSession("sess-1");
    expect(retrieved).toEqual(session);
  });

  it("getSession returns null for non-existent ID", () => {
    expect(store.getSession("does-not-exist")).toBeNull();
  });

  it("listSessions returns all sessions ordered by lastActivityAt desc", () => {
    store.createSession(
      makeSession({
        id: "sess-1",
        lastActivityAt: "2025-01-01T00:00:00Z",
      }),
    );
    store.createSession(
      makeSession({
        id: "sess-2",
        lastActivityAt: "2025-01-03T00:00:00Z",
      }),
    );
    store.createSession(
      makeSession({
        id: "sess-3",
        lastActivityAt: "2025-01-02T00:00:00Z",
      }),
    );

    const sessions = store.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["sess-2", "sess-3", "sess-1"]);
  });

  it("listSessions returns empty array when no sessions", () => {
    expect(store.listSessions()).toEqual([]);
  });

  it("listSessionsPage filters by ownerDid and paginates with cursor", () => {
    store.createSession(makeSession({
      id: "sess-1",
      ownerDid: "did:key:z6Mkowner-a",
      principalId: "user:web:1",
      lastActivityAt: "2025-01-01T00:00:00Z",
    }));
    store.createSession(makeSession({
      id: "sess-2",
      ownerDid: "did:key:z6Mkowner-a",
      principalId: "user:web:1",
      lastActivityAt: "2025-01-03T00:00:00Z",
    }));
    store.createSession(makeSession({
      id: "sess-3",
      ownerDid: "did:key:z6Mkowner-a",
      principalId: "user:web:1",
      lastActivityAt: "2025-01-02T00:00:00Z",
    }));
    store.createSession(makeSession({
      id: "sess-4",
      ownerDid: "did:key:z6Mkowner-b",
      principalId: "user:web:2",
      lastActivityAt: "2025-01-04T00:00:00Z",
    }));

    const page1 = store.listSessionsPage({
      ownerDid: "did:key:z6Mkowner-a",
      limit: 2,
    });
    expect(page1.sessions.map((session) => session.id)).toEqual(["sess-2", "sess-3"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = store.listSessionsPage({
      ownerDid: "did:key:z6Mkowner-a",
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.sessions.map((session) => session.id)).toEqual(["sess-1"]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("listSessionsPage throws on malformed cursor", () => {
    expect(() => store.listSessionsPage({
      ownerDid: "did:key:z6Mkowner-a",
      limit: 5,
      cursor: "bad-cursor",
    })).toThrow(/invalid session list cursor/i);
  });

  it("updateSession patches status field", () => {
    store.createSession(makeSession());
    store.updateSession("sess-1", { status: "idle" });

    const updated = store.getSession("sess-1");
    expect(updated?.status).toBe("idle");
  });

  it("updateSession patches lastActivityAt", () => {
    store.createSession(makeSession());
    store.updateSession("sess-1", { lastActivityAt: "2025-06-01T00:00:00Z" });

    const updated = store.getSession("sess-1");
    expect(updated?.lastActivityAt).toBe("2025-06-01T00:00:00Z");
  });

  it("updateSession patches tokenUsage (input, output)", () => {
    store.createSession(makeSession());
    store.updateSession("sess-1", { tokenUsage: { input: 100, output: 50 } });

    const updated = store.getSession("sess-1");
    expect(updated?.tokenUsage).toEqual({ input: 100, output: 50 });
  });

  it("createSession and updateSession persist displayName", () => {
    store.createSession(makeSession({ displayName: "Initial title" }));
    expect(store.getSession("sess-1")?.displayName).toBe("Initial title");

    store.updateSession("sess-1", { displayName: "Renamed session" });
    expect(store.getSession("sess-1")?.displayName).toBe("Renamed session");
    expect(store.listSessions()[0]?.displayName).toBe("Renamed session");

    store.updateSession("sess-1", { displayName: null });
    expect(store.getSession("sess-1")?.displayName).toBeUndefined();
  });

  it("createSession and updateSession persist interruption metadata", () => {
    store.createSession(makeSession({
      interruption: {
        kind: "approval_pending",
        createdAt: "2025-01-01T00:00:00Z",
        requestId: "req-1",
        tool: "Bash",
        task: "write the plan",
      },
    }));
    expect(store.getSession("sess-1")?.interruption?.requestId).toBe("req-1");

    store.updateSession("sess-1", {
      interruption: {
        kind: "approval_pending",
        createdAt: "2025-01-01T00:00:00Z",
        requestId: "req-2",
        tool: "Edit",
        task: "update the plan",
        stale: true,
      },
    });
    expect(store.getSession("sess-1")?.interruption?.requestId).toBe("req-2");
    expect(store.listSessions()[0]?.interruption?.stale).toBe(true);

    store.updateSession("sess-1", { interruption: null });
    expect(store.getSession("sess-1")?.interruption).toBeUndefined();
  });

  it("updateSession throws for non-existent session ID", () => {
    expect(() => store.updateSession("no-such-id", { status: "idle" })).toThrow();
  });

  it("incrementSessionTokenUsage applies deltas atomically", () => {
    store.createSession(makeSession({
      tokenUsage: { input: 10, output: 5 },
    }));

    store.incrementSessionTokenUsage("sess-1", 7, 3);
    store.incrementSessionTokenUsage("sess-1", 2, 9);

    const updated = store.getSession("sess-1");
    expect(updated?.tokenUsage).toEqual({ input: 19, output: 17 });
  });

  it("incrementSessionTokenUsage throws for non-existent session ID", () => {
    expect(() => store.incrementSessionTokenUsage("no-such-id", 1, 1)).toThrow();
  });

  it("createSession throws on duplicate ID", () => {
    store.createSession(makeSession());
    expect(() => store.createSession(makeSession())).toThrow();
  });

  it("applySessionLifecycleEvent parks and resumes session with persisted metadata", () => {
    store.createSession(makeSession());

    const parked = store.applySessionLifecycleEvent("sess-1", {
      eventType: "TRANSFER_REQUESTED",
      parkedReason: "transfer_pending",
      reason: "owner_requested_transfer",
      actorPrincipalType: "user",
      actorPrincipalId: "user:web:alice",
      at: "2025-01-01T00:01:00Z",
    });
    expect(parked.lifecycleState).toBe("parked");
    expect(parked.parkedReason).toBe("transfer_pending");
    expect(parked.parkedAt).toBe("2025-01-01T00:01:00Z");
    expect(parked.lifecycleVersion).toBe(1);
    expect(parked.status).toBe("idle");

    const resumed = store.applySessionLifecycleEvent("sess-1", {
      eventType: "OWNER_RESUMED",
      reason: "owner_sent_prompt",
      at: "2025-01-01T00:02:00Z",
    });
    expect(resumed.lifecycleState).toBe("live");
    expect(resumed.parkedReason).toBeUndefined();
    expect(resumed.parkedAt).toBeUndefined();
    expect(resumed.lifecycleVersion).toBe(2);
    expect(resumed.status).toBe("active");
  });

  it("applySessionLifecycleEvent rejects invalid transitions", () => {
    store.createSession(makeSession());
    expect(() => store.applySessionLifecycleEvent("sess-1", {
      eventType: "TRANSFER_ACCEPTED",
      at: "2025-01-01T00:01:00Z",
    })).toThrow(/invalid lifecycle transition/i);
  });

  it("listSessionLifecycleEvents returns newest-first lifecycle records", () => {
    store.createSession(makeSession());
    store.applySessionLifecycleEvent("sess-1", {
      eventType: "TRANSFER_REQUESTED",
      parkedReason: "transfer_pending",
      at: "2025-01-01T00:01:00Z",
    });
    store.applySessionLifecycleEvent("sess-1", {
      eventType: "TRANSFER_EXPIRED",
      at: "2025-01-01T00:02:00Z",
    });

    const events = store.listSessionLifecycleEvents("sess-1", 5);
    expect(events[0]?.eventType).toBe("TRANSFER_EXPIRED");
    expect(events[1]?.eventType).toBe("TRANSFER_REQUESTED");
    expect(events.some((event) => event.eventType === "SESSION_CREATED")).toBe(true);
  });
});
