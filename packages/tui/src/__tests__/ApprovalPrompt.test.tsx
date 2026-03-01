import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";
import { ApprovalPrompt } from "../components/ApprovalPrompt.js";

describe("ApprovalPrompt", () => {
  const noop = () => {};

  it("renders nothing when no approval", () => {
    const { lastFrame } = render(
      <ApprovalPrompt approval={null} onApprove={noop} onDeny={noop} />
    );
    expect(lastFrame()).toBe("");
  });

  it("renders tool and description when approval present", () => {
    const approval = {
      requestId: "req-1",
      tool: "execute_command",
      description: "Run npm install",
    };
    const { lastFrame } = render(
      <ApprovalPrompt approval={approval} onApprove={noop} onDeny={noop} />
    );
    expect(lastFrame()).toContain("execute_command");
    expect(lastFrame()).toContain("Run npm install");
  });

  it("shows [y/n] prompt text", () => {
    const approval = {
      requestId: "req-2",
      tool: "delete_file",
      description: "Delete temp.txt",
    };
    const { lastFrame } = render(
      <ApprovalPrompt approval={approval} onApprove={noop} onDeny={noop} />
    );
    expect(lastFrame()).toContain("[y/n]");
  });
});
