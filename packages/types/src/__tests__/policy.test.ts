import { describe, it, expect } from "vitest";
import { isPolicyConfig } from "../policy.js";

describe("isPolicyConfig", () => {
  it("validates a well-formed policy config", () => {
    expect(isPolicyConfig({
      rules: [
        { tool: "Read", action: "allow" },
        { tool: "Exec", pattern: "rm -rf", action: "deny" },
        { tool: "*", action: "ask" },
      ],
    })).toBe(true);
  });

  it("validates an empty rules array", () => {
    expect(isPolicyConfig({ rules: [] })).toBe(true);
  });

  it("accepts wildcard tool name", () => {
    expect(isPolicyConfig({ rules: [{ tool: "*", action: "ask" }] })).toBe(true);
  });

  it("rejects missing rules array", () => {
    expect(isPolicyConfig({})).toBe(false);
    expect(isPolicyConfig({ rules: "not array" })).toBe(false);
  });

  it("rejects rules with unknown action", () => {
    expect(isPolicyConfig({ rules: [{ tool: "Read", action: "permit" }] })).toBe(false);
  });

  it("rejects rules with missing tool", () => {
    expect(isPolicyConfig({ rules: [{ action: "allow" }] })).toBe(false);
  });

  it("rejects null", () => {
    expect(isPolicyConfig(null)).toBe(false);
  });
});
