import { describe, expect, it } from "vitest";
import { mergeContiguousMessages, type ChatMessage } from "../lib/chatMerge";

const msg = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({ id, role, text });

describe("mergeContiguousMessages", () => {
  it("merges contiguous system messages", () => {
    const merged = mergeContiguousMessages(
      [msg("1", "system", "line 1")],
      [msg("2", "system", "line 2")],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("line 1\nline 2");
  });

  it("merges contiguous assistant messages", () => {
    const merged = mergeContiguousMessages(
      [msg("1", "assistant", "chunk 1")],
      [msg("2", "assistant", "chunk 2")],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("chunk 1\nchunk 2");
  });

  it("does not merge user messages", () => {
    const merged = mergeContiguousMessages(
      [msg("1", "user", "u1")],
      [msg("2", "user", "u2")],
    );

    expect(merged).toHaveLength(2);
  });

  it("respects role boundaries", () => {
    const merged = mergeContiguousMessages(
      [msg("1", "system", "s1")],
      [msg("2", "assistant", "a1"), msg("3", "assistant", "a2")],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]?.text).toBe("s1");
    expect(merged[1]?.text).toBe("a1\na2");
  });
});
