import { describe, expect, it } from "vitest";
import { isSessionInterruption, isSessionInterruptionKind } from "../sessionInterruption.js";

describe("session interruption types", () => {
  it("validates interruption kind", () => {
    expect(isSessionInterruptionKind("approval_pending")).toBe(true);
    expect(isSessionInterruptionKind("bogus")).toBe(false);
  });

  it("validates interruption payloads", () => {
    expect(isSessionInterruption({
      kind: "approval_pending",
      createdAt: "2026-01-01T00:00:00Z",
      requestId: "req-1",
      tool: "Bash",
      task: "write a plan",
      stale: true,
    })).toBe(true);
    expect(isSessionInterruption({
      kind: "approval_pending",
      requestId: "req-1",
    })).toBe(false);
  });
});
