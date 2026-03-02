import { describe, it, expect } from "vitest";
import { isMemoryItem, isTranscriptMessage } from "../memory.js";

describe("isTranscriptMessage", () => {
  const valid = {
    id: 1,
    sessionId: "sess-1",
    role: "user",
    content: "hello world",
    timestamp: "2026-01-01T00:00:00Z",
    tokenEstimate: 3,
  };

  it("validates a well-formed transcript message", () => {
    expect(isTranscriptMessage(valid)).toBe(true);
  });

  it("validates all roles", () => {
    for (const role of ["user", "assistant", "tool", "system"]) {
      expect(isTranscriptMessage({ ...valid, role })).toBe(true);
    }
  });

  it("accepts optional toolName and toolCallId", () => {
    expect(isTranscriptMessage({ ...valid, role: "tool", toolName: "Read", toolCallId: "tc-1" })).toBe(true);
  });

  it("rejects invalid role", () => {
    expect(isTranscriptMessage({ ...valid, role: "unknown" })).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { content, ...noContent } = valid;
    expect(isTranscriptMessage(noContent)).toBe(false);

    const { sessionId, ...noSession } = valid;
    expect(isTranscriptMessage(noSession)).toBe(false);
  });

  it("rejects non-numeric id", () => {
    expect(isTranscriptMessage({ ...valid, id: "not-a-number" })).toBe(false);
  });

  it("rejects non-numeric tokenEstimate", () => {
    expect(isTranscriptMessage({ ...valid, tokenEstimate: "3" })).toBe(false);
  });

  it("rejects null and primitives", () => {
    expect(isTranscriptMessage(null)).toBe(false);
    expect(isTranscriptMessage("string")).toBe(false);
    expect(isTranscriptMessage(42)).toBe(false);
  });
});

describe("isMemoryItem", () => {
  const valid = {
    id: 1,
    sessionId: "sess-1",
    kind: "fact",
    content: "User prefers concise output.",
    source: "user_prompt",
    confidence: 0.8,
    keywords: ["user", "prefers", "concise", "output"],
    createdAt: "2026-01-01T00:00:00Z",
    lastAccessedAt: "2026-01-01T00:00:00Z",
    tokenEstimate: 6,
  };

  it("accepts a valid memory item", () => {
    expect(isMemoryItem(valid)).toBe(true);
  });

  it("accepts summary kind", () => {
    expect(isMemoryItem({ ...valid, kind: "summary" })).toBe(true);
  });

  it("rejects invalid kind", () => {
    expect(isMemoryItem({ ...valid, kind: "other" })).toBe(false);
  });

  it("rejects confidence out of range", () => {
    expect(isMemoryItem({ ...valid, confidence: -1 })).toBe(false);
    expect(isMemoryItem({ ...valid, confidence: 2 })).toBe(false);
  });

  it("rejects non-string keywords", () => {
    expect(isMemoryItem({ ...valid, keywords: ["ok", 1] })).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { content, ...missingContent } = valid;
    expect(isMemoryItem(missingContent)).toBe(false);
  });
});
