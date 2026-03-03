import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import type { SessionRecord } from "@nexus/types";
import { initDatabase } from "../migrations.js";
import { createSessionStore } from "../sessions.js";

const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "sess-1",
  workspaceId: "default",
  runtimeId: "rt-1",
  acpSessionId: "acp-1",
  status: "active",
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

  it("updateSession throws for non-existent session ID", () => {
    expect(() => store.updateSession("no-such-id", { status: "idle" })).toThrow();
  });

  it("createSession throws on duplicate ID", () => {
    store.createSession(makeSession());
    expect(() => store.createSession(makeSession())).toThrow();
  });
});
