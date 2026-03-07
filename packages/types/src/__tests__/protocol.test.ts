import { describe, it, expect } from "vitest";
import { isClientMessage, isGatewayEvent, parseClientMessage } from "../protocol.js";

describe("isClientMessage", () => {
  it("validates a prompt message", () => {
    expect(isClientMessage({ type: "prompt", sessionId: "s1", text: "hello" })).toBe(true);
    expect(isClientMessage({ type: "prompt", sessionId: "s1", text: "hello", idempotencyKey: "req-123" })).toBe(true);
    expect(isClientMessage({ type: "prompt", sessionId: "s1", text: "hello", parentExecutionId: "exec-parent-1" })).toBe(true);
    expect(isClientMessage({
      type: "prompt",
      sessionId: "s1",
      text: "describe this",
      images: [{ url: "https://example.com/img.png", mediaType: "image/png" }],
    })).toBe(true);
  });

  it("validates an approval_response message", () => {
    expect(isClientMessage({ type: "approval_response", requestId: "r1", allow: true })).toBe(true);
    expect(isClientMessage({ type: "approval_response", requestId: "r1", allow: false })).toBe(true);
    expect(isClientMessage({ type: "approval_response", requestId: "r1", optionId: "allow_always" })).toBe(true);
  });

  it("validates a cancel message", () => {
    expect(isClientMessage({ type: "cancel", sessionId: "s1" })).toBe(true);
  });

  it("validates a session_close message", () => {
    expect(isClientMessage({ type: "session_close", sessionId: "s1" })).toBe(true);
  });

  it("validates a session_new message", () => {
    expect(isClientMessage({ type: "session_new" })).toBe(true);
    expect(isClientMessage({ type: "session_new", runtimeId: "claude-code" })).toBe(true);
    expect(isClientMessage({ type: "session_new", runtimeId: "claude", model: "sonnet" })).toBe(true);
    expect(isClientMessage({ type: "session_new", runtimeId: "claude", model: "sonnet", workspaceId: "acme" })).toBe(true);
    expect(isClientMessage({
      type: "session_new",
      runtimeId: "claude",
      model: "sonnet",
      workspaceId: "acme",
      principalType: "service_account",
      principalId: "svc:nightly",
      source: "schedule",
    })).toBe(true);
  });

  it("validates a session_list message", () => {
    expect(isClientMessage({ type: "session_list" })).toBe(true);
    expect(isClientMessage({ type: "session_list", limit: 20 })).toBe(true);
    expect(isClientMessage({ type: "session_list", limit: 20, cursor: "abc" })).toBe(true);
  });

  it("validates a session_lifecycle_query message", () => {
    expect(isClientMessage({ type: "session_lifecycle_query", sessionId: "s1" })).toBe(true);
    expect(isClientMessage({ type: "session_lifecycle_query", sessionId: "s1", limit: 25 })).toBe(true);
  });

  it("validates a session_rename message", () => {
    expect(isClientMessage({ type: "session_rename", sessionId: "s1", displayName: "Websocket cleanup" })).toBe(true);
    expect(isClientMessage({ type: "session_rename", sessionId: "s1", displayName: null })).toBe(true);
  });

  it("validates a session_replay message", () => {
    expect(isClientMessage({ type: "session_replay", sessionId: "s1" })).toBe(true);
  });

  it("validates a session_takeover message", () => {
    expect(isClientMessage({ type: "session_takeover", sessionId: "s1" })).toBe(true);
  });

  it("validates auth_proof and session transfer messages", () => {
    expect(isClientMessage({
      type: "auth_proof",
      principalId: "user:alice",
      principalType: "user",
      publicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      challengeId: "challenge-1",
      nonce: "nonce-1",
      signature: "sig-1",
      algorithm: "ed25519",
    })).toBe(true);
    expect(isClientMessage({
      type: "session_transfer_request",
      sessionId: "s1",
      targetPrincipalId: "user:bob",
      targetPrincipalType: "user",
      expiresInMs: 30_000,
    })).toBe(true);
    expect(isClientMessage({
      type: "session_transfer_accept",
      sessionId: "s1",
    })).toBe(true);
    expect(isClientMessage({
      type: "session_transfer_dismiss",
      sessionId: "s1",
    })).toBe(true);
  });

  it("validates a memory_query message", () => {
    expect(isClientMessage({ type: "memory_query", sessionId: "s1", action: "stats" })).toBe(true);
    expect(isClientMessage({
      type: "memory_query",
      sessionId: "s1",
      action: "search",
      query: "telegram",
      limit: 5,
      scope: "workspace",
    })).toBe(true);
    expect(isClientMessage({
      type: "memory_query",
      sessionId: "s1",
      action: "context",
      prompt: "What do we know?",
      scope: "hybrid",
    })).toBe(true);
  });

  it("validates a usage_query message", () => {
    expect(isClientMessage({ type: "usage_query", sessionId: "s1" })).toBe(true);
    expect(isClientMessage({
      type: "usage_query",
      sessionId: "s1",
      action: "stats",
      scope: "workspace",
    })).toBe(true);
    expect(isClientMessage({
      type: "usage_query",
      sessionId: "s1",
      action: "search",
      query: "deploy",
      limit: 5,
      scope: "session",
    })).toBe(true);
  });

  it("rejects invalid memory_query message", () => {
    expect(isClientMessage({ type: "memory_query", sessionId: "s1" })).toBe(false);
    expect(isClientMessage({ type: "memory_query", sessionId: "s1", action: "bogus" })).toBe(false);
    expect(isClientMessage({ type: "memory_query", sessionId: "s1", action: "recent", limit: 0 })).toBe(false);
    expect(isClientMessage({ type: "memory_query", sessionId: "s1", action: "recent", scope: "global" })).toBe(false);
  });

  it("rejects invalid usage_query message", () => {
    expect(isClientMessage({ type: "usage_query", sessionId: "s1", action: "bogus" })).toBe(false);
    expect(isClientMessage({ type: "usage_query", sessionId: "s1", action: "stats", limit: 0 })).toBe(false);
    expect(isClientMessage({ type: "usage_query", sessionId: "s1", action: "search", scope: "global" })).toBe(false);
  });

  it("rejects invalid session_list message", () => {
    expect(isClientMessage({ type: "session_list", limit: 0 })).toBe(false);
    expect(isClientMessage({ type: "session_list", limit: "10" })).toBe(false);
    expect(isClientMessage({ type: "session_list", cursor: 123 })).toBe(false);
  });

  it("rejects invalid session_lifecycle_query message", () => {
    expect(isClientMessage({ type: "session_lifecycle_query", sessionId: 123 })).toBe(false);
    expect(isClientMessage({ type: "session_lifecycle_query", sessionId: "s1", limit: 0 })).toBe(false);
  });

  it("rejects invalid session_rename message", () => {
    expect(isClientMessage({ type: "session_rename", sessionId: "s1" })).toBe(false);
    expect(isClientMessage({ type: "session_rename", sessionId: "s1", displayName: 123 })).toBe(false);
  });

  it("rejects session_replay with missing sessionId", () => {
    expect(isClientMessage({ type: "session_replay" })).toBe(false);
  });

  it("rejects session_takeover with missing sessionId", () => {
    expect(isClientMessage({ type: "session_takeover" })).toBe(false);
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
    expect(isClientMessage({ type: "prompt", sessionId: "s1", text: "hello", idempotencyKey: 123 })).toBe(false);
    expect(isClientMessage({ type: "prompt", sessionId: "s1", text: "hello", images: [{ url: "" }] })).toBe(false);
    expect(isClientMessage({ type: "prompt", sessionId: "s1", text: "hello", images: [{ url: "https://x", mediaType: 123 }] })).toBe(false);
  });

  it("rejects approval_response with wrong allow type", () => {
    expect(isClientMessage({ type: "approval_response", requestId: "r1", allow: "yes" })).toBe(false);
    expect(isClientMessage({ type: "approval_response", requestId: "r1" })).toBe(false);
  });

  it("rejects malformed auth_proof and session transfer messages", () => {
    expect(isClientMessage({
      type: "auth_proof",
      principalId: "user:alice",
      challengeId: "challenge-1",
      nonce: "nonce",
      signature: "sig",
    })).toBe(false);
    expect(isClientMessage({
      type: "session_transfer_request",
      sessionId: "s1",
      targetPrincipalId: "user:bob",
      expiresInMs: 0,
    })).toBe(false);
    expect(isClientMessage({ type: "session_transfer_accept" })).toBe(false);
    expect(isClientMessage({ type: "session_transfer_dismiss" })).toBe(false);
  });
});

describe("isGatewayEvent", () => {
  it("validates text_delta", () => {
    expect(isGatewayEvent({ type: "text_delta", sessionId: "s1", delta: "hi" })).toBe(true);
    expect(isGatewayEvent({ type: "text_delta", sessionId: "s1", delta: "hi", executionId: "exec-1", turnId: "turn-1" })).toBe(true);
    expect(isGatewayEvent({
      type: "text_delta",
      sessionId: "s1",
      delta: "hi",
      executionId: "exec-1",
      parentExecutionId: "exec-root",
      turnId: "turn-1",
      policySnapshotId: "policy-1",
    })).toBe(true);
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
    expect(isGatewayEvent({ type: "session_created", sessionId: "s1", model: "sonnet", runtimeId: "claude", workspaceId: "acme" })).toBe(true);
    expect(isGatewayEvent({ type: "session_created", sessionId: "s1", model: "sonnet", displayName: "Gateway hardening" })).toBe(true);
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

  it("validates session_updated", () => {
    expect(isGatewayEvent({ type: "session_updated", sessionId: "s1", displayName: "FSM cleanup" })).toBe(true);
    expect(isGatewayEvent({ type: "session_updated", sessionId: "s1", displayName: null })).toBe(true);
  });

  it("validates session_lifecycle", () => {
    expect(isGatewayEvent({
      type: "session_lifecycle",
      sessionId: "s1",
      eventType: "TRANSFER_REQUESTED",
      fromState: "live",
      toState: "parked",
      at: "2026-01-01T00:00:00Z",
      parkedReason: "transfer_pending",
      actorPrincipalType: "user",
      actorPrincipalId: "user:alice",
    })).toBe(true);
    expect(isGatewayEvent({
      type: "session_lifecycle",
      sessionId: "s1",
      eventType: "UNKNOWN",
      fromState: "live",
      toState: "parked",
      at: "2026-01-01T00:00:00Z",
    })).toBe(false);
  });

  it("validates session_closed", () => {
    expect(isGatewayEvent({ type: "session_closed", sessionId: "s1", reason: "client_close" })).toBe(true);
  });

  it("validates session_invalidated", () => {
    expect(isGatewayEvent({
      type: "session_invalidated",
      sessionId: "s1",
      reason: "runtime_state_lost",
      message: "Session runtime state was lost and cold-restored.",
    })).toBe(true);
  });

  it("validates auth and transfer gateway events", () => {
    expect(isGatewayEvent({
      type: "auth_challenge",
      algorithm: "ed25519",
      challengeId: "challenge-1",
      nonce: "nonce-1",
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-01T00:01:00Z",
    })).toBe(true);
    expect(isGatewayEvent({
      type: "auth_result",
      ok: true,
      principalType: "user",
      principalId: "user:alice",
    })).toBe(true);
    expect(isGatewayEvent({
      type: "session_transfer_requested",
      sessionId: "s1",
      fromPrincipalType: "user",
      fromPrincipalId: "user:alice",
      targetPrincipalType: "user",
      targetPrincipalId: "user:bob",
      expiresAt: "2026-01-01T00:01:00Z",
    })).toBe(true);
    expect(isGatewayEvent({
      type: "session_transfer_updated",
      sessionId: "s1",
      fromPrincipalType: "user",
      fromPrincipalId: "user:alice",
      targetPrincipalType: "user",
      targetPrincipalId: "user:bob",
      state: "dismissed",
      updatedAt: "2026-01-01T00:00:20Z",
      reason: "target_dismissed",
    })).toBe(true);
    expect(isGatewayEvent({
      type: "session_transferred",
      sessionId: "s1",
      fromPrincipalType: "user",
      fromPrincipalId: "user:alice",
      targetPrincipalType: "user",
      targetPrincipalId: "user:bob",
      transferredAt: "2026-01-01T00:00:30Z",
    })).toBe(true);
    expect(isGatewayEvent({
      type: "session_transfer_updated",
      sessionId: "s1",
      fromPrincipalType: "user",
      fromPrincipalId: "user:alice",
      targetPrincipalType: "user",
      targetPrincipalId: "user:bob",
      state: "unknown",
      updatedAt: "2026-01-01T00:00:20Z",
    })).toBe(false);
  });

  it("validates runtime_health", () => {
    expect(isGatewayEvent({
      type: "runtime_health",
      runtime: {
        runtimeId: "codex",
        status: "healthy",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    })).toBe(true);
  });

  it("validates session_list", () => {
    expect(isGatewayEvent({ type: "session_list", sessions: [] })).toBe(true);
    expect(isGatewayEvent({ type: "session_list", sessions: [], hasMore: false })).toBe(true);
    expect(isGatewayEvent({ type: "session_list", sessions: [], hasMore: true, nextCursor: "abc" })).toBe(true);
  });

  it("validates session_lifecycle_result", () => {
    expect(isGatewayEvent({
      type: "session_lifecycle_result",
      sessionId: "s1",
      events: [
        {
          sessionId: "s1",
          eventType: "TRANSFER_REQUESTED",
          fromState: "live",
          toState: "parked",
          parkedReason: "transfer_pending",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    })).toBe(true);
  });

  it("validates transcript", () => {
    expect(isGatewayEvent({ type: "transcript", sessionId: "s1", messages: [] })).toBe(true);
    expect(isGatewayEvent({
      type: "transcript",
      sessionId: "s1",
      messages: [{ id: 1, sessionId: "s1", role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z", tokenEstimate: 1 }],
    })).toBe(true);
  });

  it("validates memory_result stats", () => {
    expect(isGatewayEvent({
      type: "memory_result",
      sessionId: "s1",
      action: "stats",
      scope: "workspace",
      stats: {
        facts: 3,
        summaries: 1,
        total: 4,
        transcriptMessages: 6,
        memoryTokens: 48,
        transcriptTokens: 120,
      },
    })).toBe(true);
  });

  it("validates memory_result context", () => {
    expect(isGatewayEvent({
      type: "memory_result",
      sessionId: "s1",
      action: "context",
      scope: "hybrid",
      prompt: "deploy day",
      context: {
        budgetTokens: 500,
        totalTokens: 120,
        hot: [{ id: 1, sessionId: "s1", role: "user", content: "When do we deploy?", timestamp: "2026-01-01T00:00:00Z", tokenEstimate: 6 }],
        warm: [{
          id: 1,
          sessionId: "s1",
          kind: "summary",
          content: "deploy day is friday",
          source: "turn_summary",
          confidence: 0.9,
          keywords: ["deploy", "friday"],
          createdAt: "2026-01-01T00:00:00Z",
          lastAccessedAt: "2026-01-01T00:00:00Z",
          tokenEstimate: 8,
        }],
        cold: [],
        rendered: "# Memory Context",
      },
    })).toBe(true);
  });

  it("validates usage_result summary", () => {
    expect(isGatewayEvent({
      type: "usage_result",
      sessionId: "s1",
      action: "summary",
      summary: {
        tokens: { input: 10, output: 5, total: 15 },
        executions: {
          total: 3,
          queued: 0,
          running: 1,
          succeeded: 1,
          failed: 1,
          cancelled: 0,
          timedOut: 0,
        },
      },
    })).toBe(true);
  });

  it("validates usage_result stats", () => {
    expect(isGatewayEvent({
      type: "usage_result",
      sessionId: "s1",
      action: "stats",
      scope: "workspace",
      stats: {
        facts: 1,
        summaries: 2,
        total: 3,
        transcriptMessages: 4,
        memoryTokens: 30,
        transcriptTokens: 50,
      },
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
