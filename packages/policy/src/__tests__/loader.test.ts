import { describe, it, expect } from "vitest";
import { loadPolicyFromString, validatePolicyConfig } from "../loader.js";

describe("loadPolicyFromString", () => {
  it("parses valid JSON into PolicyConfig", () => {
    const json = JSON.stringify({
      rules: [{ tool: "Read", action: "allow" }],
    });
    const config = loadPolicyFromString(json);
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].tool).toBe("Read");
    expect(config.rules[0].action).toBe("allow");
  });

  it("throws on invalid JSON", () => {
    expect(() => loadPolicyFromString("not json at all")).toThrow();
  });

  it("throws on valid JSON but missing rules array", () => {
    expect(() => loadPolicyFromString(JSON.stringify({ foo: "bar" }))).toThrow();
  });

  it("throws on rules with invalid action values", () => {
    const json = JSON.stringify({
      rules: [{ tool: "Read", action: "permit" }],
    });
    expect(() => loadPolicyFromString(json)).toThrow();
  });
});

describe("validatePolicyConfig", () => {
  it("returns empty array for valid config", () => {
    const errors = validatePolicyConfig({
      rules: [{ tool: "Read", action: "allow" }],
    });
    expect(errors).toEqual([]);
  });

  it("returns empty array for valid config with pattern", () => {
    const errors = validatePolicyConfig({
      rules: [{ tool: "Exec", pattern: "rm -rf", action: "deny" }],
    });
    expect(errors).toEqual([]);
  });

  it("returns errors for missing rules", () => {
    const errors = validatePolicyConfig({});
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns errors for non-array rules", () => {
    const errors = validatePolicyConfig({ rules: "not array" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns errors for invalid action values", () => {
    const errors = validatePolicyConfig({
      rules: [{ tool: "Read", action: "permit" }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns errors for rules missing tool field", () => {
    const errors = validatePolicyConfig({
      rules: [{ action: "allow" }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns errors for null input", () => {
    const errors = validatePolicyConfig(null);
    expect(errors.length).toBeGreaterThan(0);
  });
});
