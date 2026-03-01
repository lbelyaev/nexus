// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSession } from "../useSession.js";
import type { GatewayEvent } from "@nexus/types";

describe("useSession", () => {
  it("has correct initial state", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    expect(result.current.sessionId).toBeNull();
    expect(result.current.responseText).toBe("");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.activeTools).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("sets sessionId on session_created event", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-123",
        model: "claude-4",
      });
    });

    expect(result.current.sessionId).toBe("sess-123");
  });

  it("accumulates text_delta into responseText", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-1",
        model: "claude-4",
      });
    });

    act(() => {
      result.current.handleEvent({
        type: "text_delta",
        sessionId: "sess-1",
        delta: "Hello ",
      });
    });

    act(() => {
      result.current.handleEvent({
        type: "text_delta",
        sessionId: "sess-1",
        delta: "world!",
      });
    });

    expect(result.current.responseText).toBe("Hello world!");
  });

  it("sendPrompt sets isStreaming true and clears responseText", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    // Set up session first
    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-1",
        model: "claude-4",
      });
    });

    // Accumulate some text
    act(() => {
      result.current.handleEvent({
        type: "text_delta",
        sessionId: "sess-1",
        delta: "previous response",
      });
    });

    expect(result.current.responseText).toBe("previous response");

    // Send new prompt
    act(() => {
      result.current.sendPrompt("new question");
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.responseText).toBe("");
    expect(result.current.error).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "prompt",
      sessionId: "sess-1",
      text: "new question",
    });
  });

  it("sets isStreaming false on turn_end", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-1",
        model: "claude-4",
      });
    });

    act(() => {
      result.current.sendPrompt("hello");
    });

    expect(result.current.isStreaming).toBe(true);

    act(() => {
      result.current.handleEvent({
        type: "turn_end",
        sessionId: "sess-1",
        stopReason: "end_turn",
      });
    });

    expect(result.current.isStreaming).toBe(false);
  });

  it("adds to activeTools on tool_start", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "file_read",
        params: { path: "/tmp/foo" },
      });
    });

    expect(result.current.activeTools).toEqual([
      { tool: "file_read", params: { path: "/tmp/foo" } },
    ]);
  });

  it("removes from activeTools on tool_end", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "file_read",
        params: { path: "/tmp/foo" },
      });
    });

    act(() => {
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "bash",
        params: { command: "ls" },
      });
    });

    expect(result.current.activeTools).toHaveLength(2);

    act(() => {
      result.current.handleEvent({
        type: "tool_end",
        sessionId: "sess-1",
        tool: "file_read",
        result: "contents",
      });
    });

    expect(result.current.activeTools).toEqual([
      { tool: "bash", params: { command: "ls" } },
    ]);
  });

  it("accumulates toolCalls on tool_start with running status", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "Read /tmp/foo",
        params: { file_path: "/tmp/foo" },
      });
    });

    expect(result.current.toolCalls).toEqual([
      { tool: "Read /tmp/foo", params: { file_path: "/tmp/foo" }, status: "running" },
    ]);
  });

  it("updates toolCalls status on tool_end (entry persists)", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "Read /tmp/foo",
        params: { file_path: "/tmp/foo" },
      });
    });

    act(() => {
      result.current.handleEvent({
        type: "tool_end",
        sessionId: "sess-1",
        tool: "Read /tmp/foo",
        result: "contents",
      });
    });

    expect(result.current.toolCalls).toEqual([
      { tool: "Read /tmp/foo", params: { file_path: "/tmp/foo" }, status: "completed" },
    ]);
    // Active tools should still be empty (removed as before)
    expect(result.current.activeTools).toEqual([]);
  });

  it("completes lone running tool when tool_end arrives without matching id/name", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "Bash",
        toolCallId: "tc-1",
        params: { command: "ls" },
      });
    });

    // Simulate runtime sending inconsistent tool label and missing toolCallId on completion.
    act(() => {
      result.current.handleEvent({
        type: "tool_end",
        sessionId: "sess-1",
        tool: "Terminal",
      });
    });

    expect(result.current.activeTools).toEqual([]);
    expect(result.current.toolCalls).toEqual([
      { tool: "Bash", toolCallId: "tc-1", params: { command: "ls" }, status: "completed" },
    ]);
  });

  it("sets error on error event", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "error",
        sessionId: "sess-1",
        message: "something went wrong",
      });
    });

    expect(result.current.error).toBe("something went wrong");
  });

  it("cancel sends cancel message", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-1",
        model: "claude-4",
      });
    });

    act(() => {
      result.current.cancel();
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "cancel",
      sessionId: "sess-1",
    });
  });
});
