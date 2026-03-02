import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import { initDatabase } from "../migrations.js";
import { createMemoryStore } from "../memory.js";
import type { MemoryItem } from "@nexus/types";

type MemoryInput = Omit<MemoryItem, "id" | "lastAccessedAt"> & { lastAccessedAt?: string };

const makeMemoryItem = (overrides: Partial<MemoryInput> = {}): MemoryInput => ({
  sessionId: "sess-1",
  kind: "fact",
  content: "User prefers concise output.",
  source: "user_prompt",
  confidence: 0.7,
  keywords: ["user", "prefers", "concise"],
  createdAt: "2026-01-01T00:00:00Z",
  tokenEstimate: 6,
  ...overrides,
});

describe("MemoryStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    store = createMemoryStore(db);
  });

  it("appendMemoryItem inserts and returns id", () => {
    const id = store.appendMemoryItem(makeMemoryItem());
    expect(id).toBeGreaterThan(0);

    const rows = store.getMemoryItems("sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].content).toBe("User prefers concise output.");
  });

  it("getMemoryItems filters by kind", () => {
    store.appendMemoryItem(makeMemoryItem({ kind: "fact", content: "Fact 1" }));
    store.appendMemoryItem(makeMemoryItem({ kind: "summary", content: "Summary 1" }));

    const facts = store.getMemoryItems("sess-1", { kind: "fact" });
    const summaries = store.getMemoryItems("sess-1", { kind: "summary" });
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Fact 1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toBe("Summary 1");
  });

  it("getMemoryItems supports newestFirst and limit", () => {
    store.appendMemoryItem(makeMemoryItem({ content: "old", createdAt: "2026-01-01T00:00:00Z" }));
    store.appendMemoryItem(makeMemoryItem({ content: "new", createdAt: "2026-01-02T00:00:00Z" }));

    const latest = store.getMemoryItems("sess-1", { newestFirst: true, limit: 1 });
    expect(latest).toHaveLength(1);
    expect(latest[0].content).toBe("new");
  });

  it("searchMemory matches content and keywords", () => {
    store.appendMemoryItem(makeMemoryItem({ content: "Uses Telegram for notifications", keywords: ["telegram", "notify"] }));
    store.appendMemoryItem(makeMemoryItem({ content: "Uses Discord for alerts", keywords: ["discord", "alerts"] }));

    const telegram = store.searchMemory("sess-1", "Telegram");
    expect(telegram).toHaveLength(1);
    expect(telegram[0].content).toContain("Telegram");
  });

  it("touchMemoryItem updates lastAccessedAt", () => {
    const id = store.appendMemoryItem(makeMemoryItem());
    const before = store.getMemoryItems("sess-1")[0].lastAccessedAt;
    store.touchMemoryItem(id, "2026-01-05T00:00:00Z");
    const after = store.getMemoryItems("sess-1")[0].lastAccessedAt;
    expect(after).not.toBe(before);
    expect(after).toBe("2026-01-05T00:00:00Z");
  });

  it("deleteMemory removes memory for a session only", () => {
    store.appendMemoryItem(makeMemoryItem({ sessionId: "sess-1" }));
    store.appendMemoryItem(makeMemoryItem({ sessionId: "sess-2", content: "other" }));

    store.deleteMemory("sess-1");

    expect(store.getMemoryItems("sess-1")).toHaveLength(0);
    expect(store.getMemoryItems("sess-2")).toHaveLength(1);
  });
});
