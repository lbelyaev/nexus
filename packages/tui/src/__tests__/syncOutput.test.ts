import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enableSyncOutput } from "../syncOutput.js";

describe("enableSyncOutput", () => {
  let originalWrite: typeof process.stdout.write;
  const written: string[] = [];

  beforeEach(() => {
    originalWrite = process.stdout.write;
    // Replace stdout.write with a spy that records calls
    process.stdout.write = vi.fn(((...args: unknown[]) => {
      written.push(String(args[0]));
      return true;
    }) as typeof process.stdout.write) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    written.length = 0;
  });

  it("wraps writes in DEC 2026 begin/end markers", () => {
    const disable = enableSyncOutput();

    process.stdout.write("hello");

    expect(written).toEqual([
      "\x1b[?2026h",
      "hello",
      "\x1b[?2026l",
    ]);

    disable();
  });

  it("restores original write on disable", () => {
    const writeBefore = process.stdout.write;
    const disable = enableSyncOutput();

    expect(process.stdout.write).not.toBe(writeBefore);

    disable();

    // After disable, write should be the spy we installed in beforeEach
    // (not the sync wrapper)
    process.stdout.write("after");
    expect(written[written.length - 1]).toBe("after");
    // Should NOT have sync markers around it
    expect(written.filter((s) => s === "\x1b[?2026h")).toHaveLength(0);
  });
});
