import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { Chat } from "../components/Chat.js";

describe("Chat", () => {
  it("renders message history", () => {
    const messages = [
      { role: "user" as const, text: "Hello there" },
      { role: "assistant" as const, text: "Hi! How can I help?" },
    ];
    const { lastFrame } = render(
      <Chat messages={messages} streamingText="" isStreaming={false} />
    );
    expect(lastFrame()).toContain("Hello there");
    expect(lastFrame()).toContain("Hi! How can I help?");
  });

  it("shows streaming text", () => {
    const { lastFrame } = render(
      <Chat messages={[]} streamingText="Partial response..." isStreaming={true} />
    );
    expect(lastFrame()).toContain("Partial response...");
  });

  it("shows 'Thinking...' when streaming with no text yet", () => {
    const { lastFrame } = render(
      <Chat messages={[]} streamingText="" isStreaming={true} />
    );
    expect(lastFrame()).toContain("Thinking...");
  });
});
