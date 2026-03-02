import { describe, it, expect } from "vitest";
import { parseCliArgs, validateCliArgs } from "../args.js";

describe("parseCliArgs", () => {
  it("uses defaults from env", () => {
    const args = parseCliArgs([], {
      NEXUS_URL: "ws://127.0.0.1:18800/ws",
      NEXUS_TOKEN: "tok",
    });

    expect(args.url).toBe("ws://127.0.0.1:18800/ws");
    expect(args.token).toBe("tok");
    expect(args.outputMode).toBe("json");
  });

  it("parses runtime/model and prompt flags", () => {
    const args = parseCliArgs(
      ["--token", "tok", "--runtime", "codex", "--model", "gpt-5.2-codex", "--prompt", "hello"],
      {},
    );

    expect(args.token).toBe("tok");
    expect(args.runtimeId).toBe("codex");
    expect(args.model).toBe("gpt-5.2-codex");
    expect(args.prompt).toBe("hello");
  });

  it("prefers pretty mode when requested", () => {
    const args = parseCliArgs(["--token", "tok", "--pretty"], {});
    expect(args.outputMode).toBe("pretty");
  });

  it("throws on unknown flags", () => {
    expect(() => parseCliArgs(["--token", "tok", "--bogus"], {})).toThrow(/Unknown argument/);
  });

  it("rejects missing token", () => {
    const args = parseCliArgs([], {});
    expect(() => validateCliArgs(args)).toThrow(/Missing token/);
  });
});
