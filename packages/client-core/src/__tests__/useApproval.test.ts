// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useApproval } from "../useApproval.js";

describe("useApproval", () => {
  it("has no pending approvals initially", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useApproval(sendMessage));

    expect(result.current.pendingApprovals).toEqual([]);
  });

  it("adds approval on approval_request event", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useApproval(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "approval_request",
        sessionId: "sess-1",
        requestId: "req-1",
        tool: "bash",
        description: "Run ls command",
      });
    });

    expect(result.current.pendingApprovals).toEqual([
      {
        requestId: "req-1",
        tool: "bash",
        description: "Run ls command",
        sessionId: "sess-1",
      },
    ]);
  });

  it("approve removes from pending and sends allow: true", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useApproval(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "approval_request",
        sessionId: "sess-1",
        requestId: "req-1",
        tool: "bash",
        description: "Run ls command",
      });
    });

    act(() => {
      result.current.approve("req-1");
    });

    expect(result.current.pendingApprovals).toEqual([]);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "approval_response",
      requestId: "req-1",
      allow: true,
    });
  });

  it("deny removes from pending and sends allow: false", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useApproval(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "approval_request",
        sessionId: "sess-1",
        requestId: "req-1",
        tool: "bash",
        description: "Run ls command",
      });
    });

    act(() => {
      result.current.deny("req-1");
    });

    expect(result.current.pendingApprovals).toEqual([]);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "approval_response",
      requestId: "req-1",
      allow: false,
    });
  });

  it("tracks multiple concurrent approvals independently", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useApproval(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "approval_request",
        sessionId: "sess-1",
        requestId: "req-1",
        tool: "bash",
        description: "Run ls",
      });
    });

    act(() => {
      result.current.handleEvent({
        type: "approval_request",
        sessionId: "sess-1",
        requestId: "req-2",
        tool: "file_write",
        description: "Write to /tmp/foo",
      });
    });

    expect(result.current.pendingApprovals).toHaveLength(2);

    // Approve first one
    act(() => {
      result.current.approve("req-1");
    });

    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0].requestId).toBe("req-2");

    // Deny second one
    act(() => {
      result.current.deny("req-2");
    });

    expect(result.current.pendingApprovals).toHaveLength(0);
  });

  it("approveAll prefers allow_always optionId when available", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useApproval(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "approval_request",
        sessionId: "sess-1",
        requestId: "req-1",
        tool: "bash",
        description: "Run ls",
        options: [
          { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
          { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
        ],
      });
    });

    act(() => {
      result.current.approveAll();
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "approval_response",
      requestId: "req-1",
      allow: true,
      optionId: "allow_always",
    });
  });
});
