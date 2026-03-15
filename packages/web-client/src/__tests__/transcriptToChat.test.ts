import { describe, expect, it } from "vitest";
import { transcriptToChatMessages } from "../lib/transcriptToChat.js";

describe("transcriptToChatMessages", () => {
  it("maps user and assistant transcript messages into chat messages", () => {
    const result = transcriptToChatMessages([
      {
        id: 1,
        sessionId: "sess-1",
        role: "user",
        content: "hello",
        timestamp: "2026-01-01T00:00:00Z",
        tokenEstimate: 1,
      },
      {
        id: 2,
        sessionId: "sess-1",
        role: "assistant",
        content: "hi there",
        timestamp: "2026-01-01T00:00:01Z",
        tokenEstimate: 2,
      },
    ]);

    expect(result).toEqual([
      { id: "transcript-1", role: "user", text: "hello" },
      { id: "transcript-2", role: "assistant", text: "hi there" },
    ]);
  });

  it("renders tool transcript entries as system messages", () => {
    const result = transcriptToChatMessages([
      {
        id: 3,
        sessionId: "sess-1",
        role: "tool",
        content: "README.md",
        toolName: "Read",
        timestamp: "2026-01-01T00:00:02Z",
        tokenEstimate: 1,
      },
    ]);

    expect(result).toEqual([
      { id: "transcript-3", role: "system", text: "[Read] README.md" },
    ]);
  });
});
