import { describe, expect, it } from "vitest";
import { inferRuntimeFromModel, parseModelRoutingString, resolveModelAlias } from "../lib/modelRouting";

describe("parseModelRoutingString", () => {
  it("parses a comma-delimited mapping", () => {
    expect(parseModelRoutingString("sonnet=claude,gpt-5=codex")).toEqual({
      sonnet: "claude",
      "gpt-5": "codex",
    });
  });

  it("ignores malformed entries", () => {
    expect(parseModelRoutingString("foo=bar,bad,nope=,=missing")).toEqual({
      foo: "bar",
    });
  });
});

describe("inferRuntimeFromModel", () => {
  it("prefers gateway routing map", () => {
    expect(inferRuntimeFromModel("best-model", { "best-model": "codex" }, undefined)).toBe("codex");
  });

  it("falls back to env routing map", () => {
    expect(inferRuntimeFromModel("sonnet-lab", {}, "sonnet-lab=claude")).toBe("claude");
  });

  it("uses keyword fallback", () => {
    expect(inferRuntimeFromModel("claude-sonnet-4-5", {}, undefined)).toBe("claude");
    expect(inferRuntimeFromModel("gpt-5-codex", {}, undefined)).toBe("codex");
  });
});

describe("resolveModelAlias", () => {
  it("resolves local aliases first", () => {
    expect(resolveModelAlias("fast", { fast: "gpt-5" }, { fast: "claude-sonnet" })).toEqual({
      requested: "fast",
      resolved: "gpt-5",
    });
  });

  it("resolves gateway aliases when local alias is absent", () => {
    expect(resolveModelAlias("sonnet", {}, { sonnet: "claude-sonnet-4-5" })).toEqual({
      requested: "sonnet",
      resolved: "claude-sonnet-4-5",
    });
  });
});
