import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";
import { ApprovalPrompt } from "../components/ApprovalPrompt.js";

describe("ApprovalPrompt", () => {
  const noop = () => {};

  it("renders nothing when no approval", () => {
    const { lastFrame } = render(
      <ApprovalPrompt approval={null} totalPending={1} onApprove={noop} onApproveAll={noop} onDeny={noop} />
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
      <ApprovalPrompt approval={approval} totalPending={1} onApprove={noop} onApproveAll={noop} onDeny={noop} />
    );
    expect(lastFrame()).toContain("execute_command");
    expect(lastFrame()).toContain("Run npm install");
  });

  it("shows [y] approve and [n] reject prompt text", () => {
    const approval = {
      requestId: "req-2",
      tool: "delete_file",
      description: "Delete temp.txt",
    };
    const { lastFrame } = render(
      <ApprovalPrompt approval={approval} totalPending={1} onApprove={noop} onApproveAll={noop} onDeny={noop} />
    );
    expect(lastFrame()).toContain("[y] approve");
    expect(lastFrame()).toContain("[n] reject");
  });

  it("shows [a] approve all when multiple pending", () => {
    const approval = {
      requestId: "req-2",
      tool: "delete_file",
      description: "Delete temp.txt",
    };
    const { lastFrame } = render(
      <ApprovalPrompt approval={approval} totalPending={3} onApprove={noop} onApproveAll={noop} onDeny={noop} />
    );
    expect(lastFrame()).toContain("[a] approve all");
    expect(lastFrame()).toContain("3 pending");
  });

  it("hides [a] approve all when only one pending", () => {
    const approval = {
      requestId: "req-2",
      tool: "delete_file",
      description: "Delete temp.txt",
    };
    const { lastFrame } = render(
      <ApprovalPrompt approval={approval} totalPending={1} onApprove={noop} onApproveAll={noop} onDeny={noop} />
    );
    expect(lastFrame()).not.toContain("[a]");
  });

  it("calls onApprove when y is pressed", async () => {
    const onApprove = vi.fn();
    const approval = {
      requestId: "req-3",
      tool: "bash",
      description: "Run ls",
    };
    const { stdin } = render(
      <ApprovalPrompt approval={approval} totalPending={1} onApprove={onApprove} onApproveAll={noop} onDeny={noop} />
    );
    await new Promise((r) => setTimeout(r, 0));
    stdin.write("y");
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("calls onApproveAll when a is pressed", async () => {
    const onApproveAll = vi.fn();
    const approval = {
      requestId: "req-5",
      tool: "bash",
      description: "Run tests",
    };
    const { stdin } = render(
      <ApprovalPrompt approval={approval} totalPending={2} onApprove={noop} onApproveAll={onApproveAll} onDeny={noop} />
    );
    await new Promise((r) => setTimeout(r, 0));
    stdin.write("a");
    expect(onApproveAll).toHaveBeenCalledOnce();
  });

  it("calls onDeny when n is pressed", async () => {
    const onDeny = vi.fn();
    const approval = {
      requestId: "req-4",
      tool: "bash",
      description: "Run rm -rf /",
    };
    const { stdin } = render(
      <ApprovalPrompt approval={approval} totalPending={1} onApprove={noop} onApproveAll={noop} onDeny={onDeny} />
    );
    await new Promise((r) => setTimeout(r, 0));
    stdin.write("n");
    expect(onDeny).toHaveBeenCalledOnce();
  });
});
