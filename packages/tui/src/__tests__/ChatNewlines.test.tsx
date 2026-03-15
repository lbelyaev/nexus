import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Chat } from "../components/Chat.js";

describe("Chat newlines", () => {
  it("preserves streaming line breaks in basic markdown mode", () => {
    const { lastFrame } = render(
      <Chat
        messages={[]}
        streamingText={"Line 1\nLine 2"}
        thinkingText=""
        isStreaming={true}
        toolCalls={[]}
        markdownRenderer="basic"
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Line 1");
    expect(frame).toContain("Line 2");
    expect(frame.indexOf("Line 2")).toBeGreaterThan(frame.indexOf("Line 1"));
  });
});
