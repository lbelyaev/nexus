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
      <Chat messages={messages} streamingText="" thinkingText="" isStreaming={false} toolCalls={[]} />
    );
    expect(lastFrame()).toContain("Hello there");
    expect(lastFrame()).toContain("Hi! How can I help?");
  });

  it("shows streaming text", () => {
    const { lastFrame } = render(
      <Chat messages={[]} streamingText="Partial response..." thinkingText="" isStreaming={true} toolCalls={[]} />
    );
    expect(lastFrame()).toContain("Partial response...");
  });

  it("shows '...' when streaming with no text yet", () => {
    const { lastFrame } = render(
      <Chat messages={[]} streamingText="" thinkingText="" isStreaming={true} toolCalls={[]} />
    );
    expect(lastFrame()).toContain("...");
  });

  it("shows Thinking indicator while waiting for response", () => {
    const { lastFrame } = render(
      <Chat messages={[]} streamingText="" thinkingText="Analyzing the problem" isStreaming={true} toolCalls={[]} />
    );
    expect(lastFrame()).toContain("Thinking...");
  });

  it("renders system messages in yellow without role prefix", () => {
    const messages = [
      { role: "system" as const, text: "  Approved: WebSearch" },
    ];
    const { lastFrame } = render(
      <Chat messages={messages} streamingText="" thinkingText="" isStreaming={false} toolCalls={[]} />
    );
    expect(lastFrame()).toContain("Approved: WebSearch");
    expect(lastFrame()).not.toContain("You:");
    expect(lastFrame()).not.toContain("Assistant:");
  });

  it("renders tool call entries with tool names", () => {
    const toolCalls = [
      { tool: "Read /tmp/foo.ts", params: {}, status: "completed" as const },
      { tool: "grep -i 'test'", params: {}, status: "running" as const },
    ];
    const { lastFrame } = render(
      <Chat messages={[]} streamingText="" thinkingText="" isStreaming={true} toolCalls={toolCalls} />
    );
    expect(lastFrame()).toContain("Read /tmp/foo.ts");
    expect(lastFrame()).toContain("grep -i 'test'");
  });

  it("renders markdown formatting in basic mode", () => {
    const messages = [
      {
        role: "assistant" as const,
        text: "# Header\n- item\nwith **bold** text",
      },
    ];
    const { lastFrame } = render(
      <Chat
        messages={messages}
        streamingText=""
        thinkingText=""
        isStreaming={false}
        toolCalls={[]}
        markdownRenderer="basic"
      />,
    );
    expect(lastFrame()).toContain("Header");
    expect(lastFrame()).toContain("• item");
    expect(lastFrame()).toContain("bold");
  });

  it("keeps markdown syntax literal in plain mode", () => {
    const messages = [
      {
        role: "assistant" as const,
        text: "**bold** and `code`",
      },
    ];
    const { lastFrame } = render(
      <Chat
        messages={messages}
        streamingText=""
        thinkingText=""
        isStreaming={false}
        toolCalls={[]}
        markdownRenderer="plain"
      />,
    );
    expect(lastFrame()).toContain("**bold**");
    expect(lastFrame()).toContain("`code`");
  });

  it("renders markdown tables with aligned columns in basic mode", () => {
    const messages = [
      {
        role: "assistant" as const,
        text: [
          "| Name | Stars |",
          "| --- | ---: |",
          "| NanoClaw | 17k |",
          "| IronClaw | 4k |",
        ].join("\n"),
      },
    ];
    const { lastFrame } = render(
      <Chat
        messages={messages}
        streamingText=""
        thinkingText=""
        isStreaming={false}
        toolCalls={[]}
        markdownRenderer="basic"
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("+");
    expect(frame).toContain("| Name");
    expect(frame).toContain("| NanoClaw");
    expect(frame).toContain("| IronClaw");
  });
});
