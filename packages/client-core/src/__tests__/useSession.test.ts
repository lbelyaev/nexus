// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSession } from "../useSession.js";
import type { GatewayEvent } from "@nexus/types";

describe("useSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance timers to flush buffered text deltas */
  const flushTextBuffers = () => {
    act(() => {
      vi.advanceTimersByTime(100);
    });
  };

  it("has correct initial state", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    expect(result.current.sessionId).toBeNull();
    expect(result.current.sessionModel).toBeNull();
    expect(result.current.sessionRuntimeId).toBeNull();
    expect(result.current.sessionWorkspaceId).toBeNull();
    expect(result.current.sessionPrincipalType).toBeNull();
    expect(result.current.sessionPrincipalId).toBeNull();
    expect(result.current.sessionSource).toBeNull();
    expect(result.current.runtimeHealth).toEqual({});
    expect(result.current.responseText).toBe("");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.activeTools).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.usageResults).toEqual([]);
    expect(result.current.pendingSessionTransfers).toEqual([]);
    expect(result.current.sessionList).toEqual([]);
    expect(result.current.sessionListHasMore).toBe(false);
    expect(result.current.sessionListNextCursor).toBeNull();
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
    expect(result.current.sessionModel).toBe("claude-4");
    expect(result.current.sessionRuntimeId).toBeNull();
    expect(result.current.sessionWorkspaceId).toBe("default");
    expect(result.current.sessionPrincipalType).toBe("user");
    expect(result.current.sessionPrincipalId).toBe("user:local");
    expect(result.current.sessionSource).toBe("interactive");
  });

  it("resets streaming state when a new session is created", () => {
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
      result.current.handleEvent({
        type: "text_delta",
        sessionId: "sess-1",
        delta: "partial",
      });
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "Bash",
        params: { command: "sleep 10" },
      });
    });
    flushTextBuffers();
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.responseText).toBe("partial");
    expect(result.current.activeTools).toHaveLength(1);

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-2",
        model: "gpt-5",
      });
    });

    expect(result.current.sessionId).toBe("sess-2");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.responseText).toBe("");
    expect(result.current.activeTools).toEqual([]);
    expect(result.current.toolCalls).toEqual([]);
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

    flushTextBuffers();
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

    flushTextBuffers();
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

  it("error event ends streaming and marks running tools as failed", () => {
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
      result.current.sendPrompt("run");
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "Bash",
        params: { command: "sleep 10" },
      });
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.activeTools).toHaveLength(1);
    expect(result.current.toolCalls[0]?.status).toBe("running");

    act(() => {
      result.current.handleEvent({
        type: "error",
        sessionId: "sess-1",
        message: "runtime failed",
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.activeTools).toEqual([]);
    expect(result.current.toolCalls[0]?.status).toBe("failed");
    expect(result.current.error).toBe("runtime failed");
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

  it("closeSession sends session_close message", () => {
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
      result.current.closeSession();
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "session_close",
      sessionId: "sess-1",
    });
  });

  it("updates runtime health state from runtime_health events", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "runtime_health",
        runtime: {
          runtimeId: "codex",
          status: "degraded",
          updatedAt: "2026-01-01T00:00:00Z",
          reason: "rpc_timeout",
        },
      });
    });

    expect(result.current.runtimeHealth.codex?.status).toBe("degraded");
    expect(result.current.runtimeHealth.codex?.reason).toBe("rpc_timeout");
  });

  it("steer while idle sends a prompt immediately", () => {
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
      result.current.steer("focus on package-level tests");
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "prompt",
      sessionId: "sess-1",
      text: "focus on package-level tests",
    });
    expect(result.current.isStreaming).toBe(true);
  });

  it("steer while streaming cancels and auto-prompts on turn_end", () => {
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
      result.current.sendPrompt("first run");
    });
    sendMessage.mockClear();

    act(() => {
      result.current.handleEvent({
        type: "text_delta",
        sessionId: "sess-1",
        delta: "partial",
      });
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-1",
        tool: "Bash",
        params: { command: "sleep 1" },
      });
    });

    act(() => {
      result.current.steer("new direction");
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "cancel",
      sessionId: "sess-1",
    });

    act(() => {
      result.current.handleEvent({
        type: "turn_end",
        sessionId: "sess-1",
        stopReason: "cancelled",
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "prompt",
      sessionId: "sess-1",
      text: "new direction",
    });
    expect(result.current.responseText).toBe("");
    expect(result.current.activeTools).toEqual([]);
    expect(result.current.toolCalls).toEqual([]);
    expect(result.current.isStreaming).toBe(true);
  });

  it("latest steer replaces queued steer and does not send duplicate cancel", () => {
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
      result.current.sendPrompt("first run");
    });
    sendMessage.mockClear();

    act(() => {
      result.current.steer("first steer");
      result.current.steer("second steer");
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "cancel",
      sessionId: "sess-1",
    });

    act(() => {
      result.current.handleEvent({
        type: "turn_end",
        sessionId: "sess-1",
        stopReason: "cancelled",
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "prompt",
      sessionId: "sess-1",
      text: "second steer",
    });
  });

  it("manual cancel clears queued steer", () => {
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
      result.current.sendPrompt("first run");
    });
    sendMessage.mockClear();

    act(() => {
      result.current.steer("new direction");
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.cancel();
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "cancel",
      sessionId: "sess-1",
    });

    act(() => {
      result.current.handleEvent({
        type: "turn_end",
        sessionId: "sess-1",
        stopReason: "cancelled",
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("requestReplay sends session_replay message", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.requestReplay("sess-42");
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "session_replay",
      sessionId: "sess-42",
    });
  });

  it("requestSessionList sends paginated session_list message", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.requestSessionList({ limit: 15, cursor: "cursor-1" });
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "session_list",
      limit: 15,
      cursor: "cursor-1",
    });
  });

  it("stores session_list page metadata", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_list",
        sessions: [{
          id: "sess-a",
          status: "active",
          model: "claude-4",
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:05:00Z",
        }],
        hasMore: true,
        nextCursor: "cursor-2",
      });
    });

    expect(result.current.sessionList).toHaveLength(1);
    expect(result.current.sessionListHasMore).toBe(true);
    expect(result.current.sessionListNextCursor).toBe("cursor-2");
  });

  it("requestSessionTransfer targets current session by default", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-42",
        model: "claude-4",
      });
    });

    act(() => {
      result.current.requestSessionTransfer("user:tui:abc");
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "session_transfer_request",
      sessionId: "sess-42",
      targetPrincipalId: "user:tui:abc",
      targetPrincipalType: "user",
    });
  });

  it("acceptSessionTransfer uses first pending transfer when explicit session is not provided", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:tui:abc",
      });
      result.current.handleEvent({
        type: "session_transfer_requested",
        sessionId: "sess-xfer",
        fromPrincipalType: "user",
        fromPrincipalId: "user:web:xyz",
        targetPrincipalType: "user",
        targetPrincipalId: "user:tui:abc",
        expiresAt: "2026-01-01T00:00:00Z",
      });
    });

    act(() => {
      result.current.acceptSessionTransfer();
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "session_transfer_accept",
      sessionId: "sess-xfer",
    });
  });

  it("ignores transfer requests for a different authenticated principal", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:tui:abc",
      });
      result.current.handleEvent({
        type: "session_transfer_requested",
        sessionId: "sess-other",
        fromPrincipalType: "user",
        fromPrincipalId: "user:web:xyz",
        targetPrincipalType: "user",
        targetPrincipalId: "user:tui:def",
        expiresAt: "2026-01-01T00:00:00Z",
      });
    });

    expect(result.current.pendingSessionTransfers).toHaveLength(0);
  });

  it("auth_result success prunes pending transfers that target a different principal", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_transfer_requested",
        sessionId: "sess-a",
        fromPrincipalType: "user",
        fromPrincipalId: "user:web:one",
        targetPrincipalType: "user",
        targetPrincipalId: "user:tui:one",
        expiresAt: "2026-01-01T00:00:00Z",
      });
      result.current.handleEvent({
        type: "session_transfer_requested",
        sessionId: "sess-b",
        fromPrincipalType: "user",
        fromPrincipalId: "user:web:two",
        targetPrincipalType: "user",
        targetPrincipalId: "user:tui:two",
        expiresAt: "2026-01-01T00:00:00Z",
      });
    });
    expect(result.current.pendingSessionTransfers).toHaveLength(2);

    act(() => {
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:tui:two",
      });
    });

    expect(result.current.pendingSessionTransfers).toHaveLength(1);
    expect(result.current.pendingSessionTransfers[0].sessionId).toBe("sess-b");
  });

  it("auth_result success rebinds local interactive session principal in client state", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-local",
        model: "claude-4",
        principalType: "user",
        principalId: "user:local",
        source: "interactive",
      });
    });
    expect(result.current.sessionPrincipalId).toBe("user:local");

    act(() => {
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:web:abc",
      });
    });

    expect(result.current.sessionPrincipalType).toBe("user");
    expect(result.current.sessionPrincipalId).toBe("user:web:abc");
  });

  it("auth_result rebinds local interactive session principal when events arrive in one tick", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-race-local",
        model: "claude-4",
        principalType: "user",
        principalId: "user:local",
        source: "interactive",
      });
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:web:race",
      });
    });

    expect(result.current.sessionPrincipalType).toBe("user");
    expect(result.current.sessionPrincipalId).toBe("user:web:race");
  });

  it("session_created uses authenticated principal when local interactive session arrives after auth", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:web:late",
      });
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-race",
        model: "claude-4",
        principalType: "user",
        principalId: "user:local",
        source: "interactive",
      });
    });

    expect(result.current.sessionPrincipalType).toBe("user");
    expect(result.current.sessionPrincipalId).toBe("user:web:late");
  });

  it("session_transferred to authenticated principal switches active session and requests replay", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:tui:abc",
      });
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-old",
        model: "claude-4",
      });
    });
    sendMessage.mockClear();

    act(() => {
      result.current.handleEvent({
        type: "session_transferred",
        sessionId: "sess-new",
        fromPrincipalType: "user",
        fromPrincipalId: "user:web:xyz",
        targetPrincipalType: "user",
        targetPrincipalId: "user:tui:abc",
        transferredAt: "2026-01-01T00:00:01Z",
      });
    });

    expect(result.current.sessionId).toBe("sess-new");
    expect(sendMessage).toHaveBeenCalledWith({
      type: "session_replay",
      sessionId: "sess-new",
    });
  });

  it("session_transferred from authenticated principal detaches active session", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "auth_result",
        ok: true,
        principalType: "user",
        principalId: "user:web:xyz",
      });
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-owned",
        model: "claude-4",
        principalType: "user",
        principalId: "user:web:xyz",
        source: "interactive",
      });
    });
    sendMessage.mockClear();

    act(() => {
      result.current.handleEvent({
        type: "session_transferred",
        sessionId: "sess-owned",
        fromPrincipalType: "user",
        fromPrincipalId: "user:web:xyz",
        targetPrincipalType: "user",
        targetPrincipalId: "user:telegram-main:139038976",
        transferredAt: "2026-01-01T00:00:01Z",
      });
    });

    expect(result.current.sessionId).toBeNull();
    expect(result.current.sessionModel).toBeNull();
    expect(result.current.sessionPrincipalType).toBeNull();
    expect(result.current.sessionPrincipalId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("session_invalidated stops streaming and surfaces cold-recovery message", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-rehydrate",
        model: "claude-4",
      });
      result.current.handleEvent({
        type: "tool_start",
        sessionId: "sess-rehydrate",
        tool: "Bash",
        params: { command: "ls" },
      });
      result.current.handleEvent({
        type: "text_delta",
        sessionId: "sess-rehydrate",
        delta: "hello",
      });
    });

    act(() => {
      result.current.handleEvent({
        type: "session_invalidated",
        sessionId: "sess-rehydrate",
        reason: "runtime_state_lost",
        message: "Session runtime state was lost after restart and cold-restored.",
      });
    });

    expect(result.current.sessionId).toBe("sess-rehydrate");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.activeTools).toEqual([]);
    expect(result.current.toolCalls[0]?.status).toBe("failed");
    expect(result.current.error).toContain("cold-restored");
  });

  it("requestUsage sends usage_query for active session", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "session_created",
        sessionId: "sess-42",
        model: "claude-4",
      });
    });

    act(() => {
      result.current.requestUsage({ action: "search", query: "telegram", limit: 3 });
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: "usage_query",
      sessionId: "sess-42",
      action: "search",
      query: "telegram",
      limit: 3,
    });
  });

  it("sets transcript on transcript event", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    const messages = [
      { id: 1, sessionId: "sess-1", role: "user" as const, content: "hi", timestamp: "2026-01-01T00:00:00Z", tokenEstimate: 1 },
      { id: 2, sessionId: "sess-1", role: "assistant" as const, content: "hello", timestamp: "2026-01-01T00:00:01Z", tokenEstimate: 2 },
    ];

    act(() => {
      result.current.handleEvent({
        type: "transcript",
        sessionId: "sess-1",
        messages,
      });
    });

    expect(result.current.transcript).toEqual(messages);
  });

  it("has empty transcript initially", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    expect(result.current.transcript).toEqual([]);
  });

  it("stores usage_result events", () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useSession(sendMessage));

    act(() => {
      result.current.handleEvent({
        type: "usage_result",
        sessionId: "sess-1",
        action: "stats",
        scope: "session",
        stats: {
          facts: 1,
          summaries: 1,
          total: 2,
          transcriptMessages: 3,
          memoryTokens: 14,
          transcriptTokens: 20,
        },
      });
    });

    expect(result.current.usageResults).toHaveLength(1);
    expect(result.current.usageResults[0].action).toBe("stats");
  });

  it("ignores stale cancelled turn_end after steer reprompt", () => {
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
      result.current.sendPrompt("first run");
    });
    sendMessage.mockClear();

    act(() => {
      result.current.steer("second run");
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "cancel",
      sessionId: "sess-1",
    });

    // Cancelled turn from first run ends and triggers steer reprompt.
    act(() => {
      result.current.handleEvent({
        type: "turn_end",
        sessionId: "sess-1",
        stopReason: "cancelled",
      });
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "prompt",
      sessionId: "sess-1",
      text: "second run",
    });
    expect(result.current.isStreaming).toBe(true);

    // Stale duplicate cancelled completion should not stop current streaming turn.
    act(() => {
      result.current.handleEvent({
        type: "turn_end",
        sessionId: "sess-1",
        stopReason: "cancelled",
      });
    });
    expect(result.current.isStreaming).toBe(true);

    // Current turn still renders output.
    act(() => {
      result.current.handleEvent({
        type: "text_delta",
        sessionId: "sess-1",
        delta: "new output",
      });
    });
    flushTextBuffers();
    expect(result.current.responseText).toBe("new output");

    act(() => {
      result.current.handleEvent({
        type: "turn_end",
        sessionId: "sess-1",
        stopReason: "end_turn",
      });
    });
    expect(result.current.isStreaming).toBe(false);
  });
});
