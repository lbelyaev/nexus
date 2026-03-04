import { describe, expect, it } from "vitest";
import { formatMarkdownTablesForDiscord } from "../adapters/discord.js";

describe("formatMarkdownTablesForDiscord", () => {
  it("converts markdown pipe tables into code-block tables", () => {
    const input = [
      "~15,590 lines:",
      "",
      "| Package | Lines |",
      "|---------|------:|",
      "| gateway | 4701 |",
      "| channels | 2065 |",
    ].join("\n");

    const output = formatMarkdownTablesForDiscord(input);
    expect(output).toContain("```text");
    expect(output).toContain("| Package  | Lines |");
    expect(output).toContain("| gateway  |  4701 |");
    expect(output).toContain("| channels |  2065 |");
    expect(output).toContain("```");
  });

  it("leaves non-table text unchanged", () => {
    const input = "No table here.\nJust normal markdown **bold**.";
    expect(formatMarkdownTablesForDiscord(input)).toBe(input);
  });

  it("does not rewrite tables that are already inside fenced blocks", () => {
    const input = [
      "```md",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "```",
    ].join("\n");
    expect(formatMarkdownTablesForDiscord(input)).toBe(input);
  });
});
