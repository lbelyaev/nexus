import { describe, it, expect, vi } from "vitest";
import { createAcpSession, translateNotification } from "../session.js";
import type { RpcClient, RequestHandler } from "../rpc.js";
import type { JsonRpcNotification } from "@nexus/types";

const makeMockRpc = (): RpcClient => ({
  sendRequest: vi.fn().mockResolvedValue(undefined),
  sendNotification: vi.fn(),
  sendResponse: vi.fn(),
  sendErrorResponse: vi.fn(),
  onNotification: vi.fn().mockReturnValue(() => {}),
  onRequest: vi.fn().mockReturnValue(() => {}),
  destroy: vi.fn(),
});

describe("createAcpSession", () => {
  it("stores the session IDs", () => {
    const rpc = makeMockRpc();
    const session = createAcpSession(rpc, "acp-123", "gw-456");

    expect(session.id).toBe("gw-456");
    expect(session.acpSessionId).toBe("acp-123");
  });

  it("prompt calls rpc.sendRequest with ContentBlock array", async () => {
    const rpc = makeMockRpc();
    const session = createAcpSession(rpc, "acp-123", "gw-456");

    await session.prompt("Hello agent");

    expect(rpc.sendRequest).toHaveBeenCalledWith("session/prompt", {
      sessionId: "acp-123",
      prompt: [{ type: "text", text: "Hello agent" }],
    });
  });

  it("cancel sends session/cancel notification", () => {
    const rpc = makeMockRpc();
    const session = createAcpSession(rpc, "acp-123", "gw-456");

    session.cancel();

    expect(rpc.sendNotification).toHaveBeenCalledWith("session/cancel", {
      sessionId: "acp-123",
    });
  });

  it("registers onNotification handler on rpc", () => {
    const rpc = makeMockRpc();
    createAcpSession(rpc, "acp-123", "gw-456");

    expect(rpc.onNotification).toHaveBeenCalledOnce();
  });

  it("registers onRequest handler on rpc", () => {
    const rpc = makeMockRpc();
    createAcpSession(rpc, "acp-123", "gw-456");

    expect(rpc.onRequest).toHaveBeenCalledOnce();
  });

  it("onEvent receives translated ACP notifications", () => {
    const rpc = makeMockRpc();
    let capturedHandler: ((n: JsonRpcNotification) => void) | undefined;
    rpc.onNotification = vi.fn((handler) => { capturedHandler = handler; return () => {}; });

    const session = createAcpSession(rpc, "acp-123", "gw-456");
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    capturedHandler!({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello!" },
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "text_delta",
      sessionId: "gw-456",
      delta: "Hello!",
    });
  });

  it("ignores notifications for other sessions", () => {
    const rpc = makeMockRpc();
    let capturedHandler: ((n: JsonRpcNotification) => void) | undefined;
    rpc.onNotification = vi.fn((handler) => { capturedHandler = handler; return () => {}; });

    const session = createAcpSession(rpc, "acp-123", "gw-456");
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    capturedHandler!({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "other-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Nope" },
        },
      },
    });

    expect(events).toHaveLength(0);
  });

  it("handles permission request via onRequest and respondToPermission", async () => {
    const rpc = makeMockRpc();
    let capturedRequestHandler: RequestHandler | undefined;
    rpc.onRequest = vi.fn((handler) => { capturedRequestHandler = handler; return () => {}; });

    const session = createAcpSession(rpc, "acp-123", "gw-456");
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    // Agent sends a permission request
    const permissionPromise = capturedRequestHandler!("session/request_permission", {
      sessionId: "acp-123",
      toolCall: {
        toolCallId: "tc-1",
        title: "Bash",
        rawInput: { command: "rm -rf /" },
      },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    });

    // Should have emitted approval_request
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "approval_request",
      sessionId: "gw-456",
      requestId: "tc-1",
      tool: "Bash",
      description: JSON.stringify({ command: "rm -rf /" }),
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    });

    // User responds
    session.respondToPermission("tc-1", "allow_once");

    // The permission request promise should resolve
    const result = await permissionPromise;
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  it("auto-approves when policy evaluator returns allow", async () => {
    const rpc = makeMockRpc();
    let capturedRequestHandler: RequestHandler | undefined;
    rpc.onRequest = vi.fn((handler) => { capturedRequestHandler = handler; return () => {}; });

    const session = createAcpSession(rpc, "acp-123", "gw-456", {
      policyEvaluator: () => "allow",
    });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    const result = await capturedRequestHandler!("session/request_permission", {
      sessionId: "acp-123",
      toolCall: { toolCallId: "tc-1", title: "Read", rawInput: { file: "test.ts" } },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });

    // Should NOT emit approval_request — auto-approved by policy
    expect(events).toHaveLength(0);
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  it("auto-denies when policy evaluator returns deny", async () => {
    const rpc = makeMockRpc();
    let capturedRequestHandler: RequestHandler | undefined;
    rpc.onRequest = vi.fn((handler) => { capturedRequestHandler = handler; return () => {}; });

    const session = createAcpSession(rpc, "acp-123", "gw-456", {
      policyEvaluator: () => "deny",
    });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    const result = await capturedRequestHandler!("session/request_permission", {
      sessionId: "acp-123",
      toolCall: { toolCallId: "tc-1", title: "Bash", rawInput: { command: "rm -rf /" } },
      options: [{ optionId: "reject_once", name: "Reject", kind: "reject_once" }],
    });

    expect(events).toHaveLength(0);
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  });

  it("forwards to user when policy evaluator returns ask", async () => {
    const rpc = makeMockRpc();
    let capturedRequestHandler: RequestHandler | undefined;
    rpc.onRequest = vi.fn((handler) => { capturedRequestHandler = handler; return () => {}; });

    const session = createAcpSession(rpc, "acp-123", "gw-456", {
      policyEvaluator: () => "ask",
    });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    // Don't await — this will block until respondToPermission
    const permissionPromise = capturedRequestHandler!("session/request_permission", {
      sessionId: "acp-123",
      toolCall: { toolCallId: "tc-1", title: "Bash", rawInput: { command: "ls" } },
      options: [],
    });

    // Should have emitted approval_request
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("approval_request");

    session.respondToPermission("tc-1", "allow_once");
    const result = await permissionPromise;
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });
});

describe("translateNotification", () => {
  it("translates agent_message_chunk to text_delta", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello world" },
        },
      },
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toEqual({
      type: "text_delta",
      sessionId: "gw-1",
      delta: "Hello world",
    });
  });

  it("translates tool_call to tool_start", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Read",
          rawInput: { file: "test.ts" },
        },
      },
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toEqual({
      type: "tool_start",
      sessionId: "gw-1",
      tool: "Read",
      toolCallId: "tc-1",
      params: { file: "test.ts" },
    });
  });

  it("translates tool_call_update completed to tool_end", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          title: "Read",
          status: "completed",
          rawOutput: "file contents",
        },
      },
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toEqual({
      type: "tool_end",
      sessionId: "gw-1",
      tool: "Read",
      toolCallId: "tc-1",
      result: "file contents",
    });
  });

  it("returns null for tool_call_update with in_progress status", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "in_progress",
        },
      },
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toBeNull();
  });

  it("returns null for unknown notification methods", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "unknown/method",
      params: {},
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toBeNull();
  });

  it("returns null when session ID does not match", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "other-acp",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toBeNull();
  });

  it("falls back to _meta.claudeCode.toolName when title is undefined string", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-2",
          title: '"undefined"',
          rawInput: { query: undefined },
          _meta: { claudeCode: { toolName: "WebSearch" } },
        },
      },
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toEqual({
      type: "tool_start",
      sessionId: "gw-1",
      tool: "WebSearch",
      toolCallId: "tc-2",
      params: { query: undefined },
    });
  });

  it("handles content as array of blocks", () => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      },
    };

    const event = translateNotification(notification, "gw-1", "acp-1");
    expect(event).toEqual({
      type: "text_delta",
      sessionId: "gw-1",
      delta: "Hello world",
    });
  });
});
