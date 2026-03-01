import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../evaluate.js";
import type { PolicyConfig } from "@nexus/types";

describe("evaluatePolicy", () => {
  it("returns correct action for exact tool match (allow)", () => {
    const config: PolicyConfig = { rules: [{ tool: "Read", action: "allow" }] };
    expect(evaluatePolicy(config, "Read")).toBe("allow");
  });

  it("returns correct action for exact tool match (deny)", () => {
    const config: PolicyConfig = { rules: [{ tool: "Exec", action: "deny" }] };
    expect(evaluatePolicy(config, "Exec")).toBe("deny");
  });

  it("returns correct action for exact tool match (ask)", () => {
    const config: PolicyConfig = { rules: [{ tool: "WebFetch", action: "ask" }] };
    expect(evaluatePolicy(config, "WebFetch")).toBe("ask");
  });

  it("wildcard '*' matches any tool name", () => {
    const config: PolicyConfig = { rules: [{ tool: "*", action: "ask" }] };
    expect(evaluatePolicy(config, "AnythingAtAll")).toBe("ask");
    expect(evaluatePolicy(config, "Read")).toBe("ask");
  });

  it("first-match-wins: deny Exec with 'rm -rf', ask Exec otherwise", () => {
    const config: PolicyConfig = {
      rules: [
        { tool: "Exec", pattern: "rm -rf", action: "deny" },
        { tool: "Exec", action: "ask" },
      ],
    };
    expect(evaluatePolicy(config, "Exec", "rm -rf /")).toBe("deny");
    expect(evaluatePolicy(config, "Exec", "npm test")).toBe("ask");
  });

  it("pattern is substring match: 'rm -rf' matches 'rm -rf /'", () => {
    const config: PolicyConfig = {
      rules: [{ tool: "Exec", pattern: "rm -rf", action: "deny" }],
    };
    expect(evaluatePolicy(config, "Exec", "rm -rf /")).toBe("deny");
  });

  it("pattern substring: 'sudo' does NOT match 'pseudocode'", () => {
    const config: PolicyConfig = {
      rules: [{ tool: "Exec", pattern: "sudo", action: "deny" }],
    };
    // "pseudocode" does not contain "sudo" as a substring
    expect(evaluatePolicy(config, "Exec", "pseudocode")).not.toBe("deny");
  });

  it("tool names are case-sensitive: 'Read' does not match 'read'", () => {
    const config: PolicyConfig = { rules: [{ tool: "Read", action: "allow" }] };
    expect(evaluatePolicy(config, "read")).not.toBe("allow");
  });

  it("no match defaults to 'ask'", () => {
    const config: PolicyConfig = { rules: [{ tool: "Read", action: "allow" }] };
    expect(evaluatePolicy(config, "UnknownTool")).toBe("ask");
  });

  it("empty rules defaults to 'ask'", () => {
    const config: PolicyConfig = { rules: [] };
    expect(evaluatePolicy(config, "Anything")).toBe("ask");
  });

  it("full default policy scenario", () => {
    const config: PolicyConfig = {
      rules: [
        { tool: "Read", action: "allow" },
        { tool: "Edit", action: "allow" },
        { tool: "Exec", pattern: "rm -rf", action: "deny" },
        { tool: "Exec", pattern: "npm test", action: "ask" },
        { tool: "WebFetch", action: "ask" },
        { tool: "*", action: "ask" },
      ],
    };

    expect(evaluatePolicy(config, "Read")).toBe("allow");
    expect(evaluatePolicy(config, "Edit")).toBe("allow");
    expect(evaluatePolicy(config, "Exec", "rm -rf /")).toBe("deny");
    expect(evaluatePolicy(config, "Exec", "npm test")).toBe("ask");
    expect(evaluatePolicy(config, "WebFetch")).toBe("ask");
    expect(evaluatePolicy(config, "UnknownTool")).toBe("ask");
  });
});
