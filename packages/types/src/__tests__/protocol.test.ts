import { describe, it, expect } from "vitest";
import { isClientMessage, isGatewayEvent, parseClientMessage } from "../protocol.js";

describe("isClientMessage", () => {
  it("validates a prompt message", () => {
    expect(isClientMessage({ type: "prompt", sessionId: "s1", text: "hello" })).toBe(true);
  });

  it("validates an approval_response message", () => {
    expect(isClientMessage({ type: "approval_response", requestId: "r1", allow: true })).toBe(true);
    expect(isClientMessage({ type: "approval_response", requestId: "r1", allow: false })).toBe(true);
    expect(isClientMessage({ type: "approval_response", requestId: "r1", optionId: "allow_always" })).toBe(true);
  });

  it("validates a cancel message", () => {
    expect(isClientMessage({ type: "cancel", sessionId: "s1" })).toBe(true);
  });

  it("validates a session_new message", () => {
    expect(isClientMessage({ type: "session_new" })).toBe(true);
    expect(isClientMessage({ type: "session_new", runtimeId: "claude-code" })).toBe(true);
    expect(isClientMessage({ type: "session_new", runtimeId: "claude", model: "sonnet" })).toBe(true);
  });

  it("validates a session_list message", () => {
    expect(isClientMessage({ type: "session_list" })).toBe(true);
  });

  it("validates a session_replay message", () => {
    expect(isClientMessage({ type: "session_replay", sessionId: "s1" })).toBe(true);
  });

  it("rejects session_replay with missing sessionId", () => {
    expect(isClientMessage({ type: "session_replay" })).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage(undefined)).toBe(false);
    expect(isClientMessage("string")).toBe(false);
    expect(isClientMessage(42)).toBe(false);
  });

  it("rejects objects with missing type", () => {
    expect(isClientMessage({ sessionId: "s1", text: "hello" })).toBe(false);
  });

  it("rejects objects with unknown type", () => {
    expect(isClientMessage({ type: "unknown_type" })).toBe(false);
  });

  it("rejects prompt with missing required fields", () => {
    expect(isClientMessage({ type: "prompt", sessionId: "s1" })).toBe(false);
    expect(isClientMessage({ type: "prompt", text: "hello" })).toBe(false);
  });

  it("rejects approval_response with wrong allow type", () => {
    expect(isClientMessage({ type: "approval_response", requestId: "r1", allow: "yes" })).toBe(false);
    expect(isClientMessage({ type: "approval_response", requestId: "r1" })).toBe(false);
  });
});

describe("isGatewayEvent", () => {
  it("validates text_delta", () => {
    expect(isGatewayEvent({ type: "text_delta", sessionId: "s1", delta: "hi" })).toBe(true);
  });

  it("validates tool_start", () => {
    expect(isGatewayEvent({ type: "tool_start", sessionId: "s1", tool: "Read", params: {} })).toBe(true);
  });

  it("validates tool_end", () => {
    expect(isGatewayEvent({ type: "tool_end", sessionId: "s1", tool: "Read" })).toBe(true);
    expect(isGatewayEvent({ type: "tool_end", sessionId: "s1", tool: "Read", result: "ok" })).toBe(true);
  });

  it("validates approval_request", () => {
    expect(isGatewayEvent({
      type: "approval_request",
      sessionId: "s1",
      requestId: "r1",
      tool: "Exec",
      description: "Run npm test",
    })).toBe(true);
    expect(isGatewayEvent({
      type: "approval_request",
      sessionId: "s1",
      requestId: "r1",
      tool: "Exec",
      description: "Run npm test",
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
      ],
    })).toBe(true);
  });

  it("validates turn_end", () => {
    expect(isGatewayEvent({ type: "turn_end", sessionId: "s1", stopReason: "end_turn" })).toBe(true);
  });

  it("validates error", () => {
    expect(isGatewayEvent({ type: "error", sessionId: "s1", message: "something broke" })).toBe(true);
  });

  it("validates session_created", () => {
    expect(isGatewayEvent({ type: "session_created", sessionId: "s1", model: "claude-4" })).toBe(true);
    expect(isGatewayEvent({ type: "session_created", sessionId: "s1", model: "sonnet", runtimeId: "claude" })).toBe(true);
    expect(isGatewayEvent({
      type: "session_created",
      sessionId: "s1",
      model: "gpt-5.2-codex",
      runtimeId: "codex",
      modelRouting: { "gpt-5": "codex" },
      modelAliases: { fast: "gpt-5.2-codex-mini" },
      modelCatalog: { codex: ["gpt-5.2-codex", "gpt-5.3-codex"] },
      runtimeDefaults: { codex: "gpt-5.2-codex" },
    })).toBe(true);
  });

  it("validates session_list", () => {
    expect(isGatewayEvent({ type: "session_list", sessions: [] })).toBe(true);
  });

  it("validates transcript", () => {
    expect(isGatewayEvent({ type: "transcript", sessionId: "s1", messages: [] })).toBe(true);
    expect(isGatewayEvent({
      type: "transcript",
      sessionId: "s1",
      messages: [{ id: 1, sessionId: "s1", role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z", tokenEstimate: 1 }],
    })).toBe(true);
  });

  it("rejects transcript with missing fields", () => {
    expect(isGatewayEvent({ type: "transcript", sessionId: "s1" })).toBe(false);
    expect(isGatewayEvent({ type: "transcript", messages: [] })).toBe(false);
    expect(isGatewayEvent({
      type: "transcript",
      sessionId: "s1",
      messages: [{ id: "bad-id", role: "user" }],
    })).toBe(false);
  });

  it("rejects malformed events", () => {
    expect(isGatewayEvent(null)).toBe(false);
    expect(isGatewayEvent({ type: "text_delta" })).toBe(false);
    expect(isGatewayEvent({ type: "unknown" })).toBe(false);
  });
});

describe("parseClientMessage", () => {
  it("parses valid JSON into a ClientMessage", () => {
    const msg = parseClientMessage('{"type":"session_list"}');
    expect(msg.type).toBe("session_list");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseClientMessage("not json")).toThrow();
  });

  it("throws on valid JSON but unknown type", () => {
    expect(() => parseClientMessage('{"type":"bogus"}')).toThrow("Invalid client message");
  });

  it("throws on valid JSON but missing fields", () => {
    expect(() => parseClientMessage('{"type":"prompt"}')).toThrow("Invalid client message");
  });
});
