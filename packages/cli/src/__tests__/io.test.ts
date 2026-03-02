import { describe, it, expect } from "vitest";
import { normalizeClientMessage, serializeGatewayEvent } from "../io.js";

describe("normalizeClientMessage", () => {
  it("injects sessionId into prompt when missing", () => {
    const msg = normalizeClientMessage(
      { type: "prompt", text: "hello" },
      "s1",
    );

    expect(msg).toEqual({
      type: "prompt",
      sessionId: "s1",
      text: "hello",
    });
  });

  it("rejects prompt without sessionId before session exists", () => {
    expect(() => normalizeClientMessage({ type: "prompt", text: "hello" }, undefined)).toThrow(/requires sessionId/);
  });
});

describe("serializeGatewayEvent", () => {
  it("serializes json mode", () => {
    const out = serializeGatewayEvent(
      { type: "turn_end", sessionId: "s1", stopReason: "end_turn" },
      "json",
    );
    expect(out).toContain("\"type\":\"turn_end\"");
  });

  it("serializes pretty mode", () => {
    const out = serializeGatewayEvent(
      { type: "session_created", sessionId: "s1", runtimeId: "codex", model: "gpt-5.2-codex" },
      "pretty",
    );
    expect(out).toContain("session_created");
    expect(out).toContain("codex");
  });
});
