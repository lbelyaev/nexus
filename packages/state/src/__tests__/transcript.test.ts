import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import type { TranscriptMessage } from "@nexus/types";
import { initDatabase } from "../migrations.js";
import { createTranscriptStore } from "../transcript.js";

type TranscriptInput = Omit<TranscriptMessage, "id">;

const makeMessage = (overrides: Partial<TranscriptInput> = {}): TranscriptInput => ({
  sessionId: "sess-1",
  role: "user",
  content: "hello world",
  timestamp: "2026-01-01T00:00:00Z",
  tokenEstimate: 3,
  ...overrides,
});

describe("TranscriptStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createTranscriptStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    store = createTranscriptStore(db);
  });

  it("appendMessage inserts and getTranscript retrieves it", () => {
    store.appendMessage(makeMessage());

    const transcript = store.getTranscript("sess-1");
    expect(transcript).toHaveLength(1);
    expect(transcript[0].sessionId).toBe("sess-1");
    expect(transcript[0].content).toBe("hello world");
    expect(transcript[0].role).toBe("user");
    expect(typeof transcript[0].id).toBe("number");
  });

  it("getTranscript filters by sessionId", () => {
    store.appendMessage(makeMessage({ sessionId: "sess-1" }));
    store.appendMessage(makeMessage({ sessionId: "sess-2", content: "other" }));

    const transcript = store.getTranscript("sess-1");
    expect(transcript).toHaveLength(1);
    expect(transcript[0].content).toBe("hello world");
  });

  it("getTranscript returns messages ordered by id asc", () => {
    store.appendMessage(makeMessage({ content: "first" }));
    store.appendMessage(makeMessage({ content: "second" }));
    store.appendMessage(makeMessage({ content: "third" }));

    const transcript = store.getTranscript("sess-1");
    expect(transcript.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("getTranscript supports limit", () => {
    store.appendMessage(makeMessage({ content: "first" }));
    store.appendMessage(makeMessage({ content: "second" }));
    store.appendMessage(makeMessage({ content: "third" }));

    const transcript = store.getTranscript("sess-1", { limit: 2 });
    expect(transcript).toHaveLength(2);
    expect(transcript.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("getTranscript supports offset", () => {
    store.appendMessage(makeMessage({ content: "first" }));
    store.appendMessage(makeMessage({ content: "second" }));
    store.appendMessage(makeMessage({ content: "third" }));

    const transcript = store.getTranscript("sess-1", { offset: 1 });
    expect(transcript.map((m) => m.content)).toEqual(["second", "third"]);
  });

  it("getTranscript supports limit and offset together", () => {
    store.appendMessage(makeMessage({ content: "first" }));
    store.appendMessage(makeMessage({ content: "second" }));
    store.appendMessage(makeMessage({ content: "third" }));

    const transcript = store.getTranscript("sess-1", { limit: 1, offset: 1 });
    expect(transcript).toHaveLength(1);
    expect(transcript[0].content).toBe("second");
  });

  it("getTranscript returns empty array for unknown session", () => {
    expect(store.getTranscript("unknown")).toEqual([]);
  });

  it("appendMessage stores optional tool fields", () => {
    store.appendMessage(makeMessage({
      role: "tool",
      toolName: "Read",
      toolCallId: "tc-1",
      content: "file contents",
    }));

    const transcript = store.getTranscript("sess-1");
    expect(transcript[0].toolName).toBe("Read");
    expect(transcript[0].toolCallId).toBe("tc-1");
  });

  it("appendMessage stores tokenEstimate", () => {
    store.appendMessage(makeMessage({ tokenEstimate: 42 }));

    const transcript = store.getTranscript("sess-1");
    expect(transcript[0].tokenEstimate).toBe(42);
  });

  it("getSessionTokenEstimate sums token estimates for a session", () => {
    store.appendMessage(makeMessage({ tokenEstimate: 10 }));
    store.appendMessage(makeMessage({ tokenEstimate: 20 }));
    store.appendMessage(makeMessage({ tokenEstimate: 30 }));

    expect(store.getSessionTokenEstimate("sess-1")).toBe(60);
  });

  it("getSessionTokenEstimate returns 0 for unknown session", () => {
    expect(store.getSessionTokenEstimate("unknown")).toBe(0);
  });

  it("deleteTranscript removes all messages for a session", () => {
    store.appendMessage(makeMessage({ sessionId: "sess-1" }));
    store.appendMessage(makeMessage({ sessionId: "sess-1" }));
    store.appendMessage(makeMessage({ sessionId: "sess-2" }));

    store.deleteTranscript("sess-1");

    expect(store.getTranscript("sess-1")).toEqual([]);
    expect(store.getTranscript("sess-2")).toHaveLength(1);
  });

  it("deleteTranscript is a no-op for unknown session", () => {
    store.deleteTranscript("unknown"); // should not throw
  });
});
