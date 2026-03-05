import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import type { ExecutionRecord } from "@nexus/types";
import { initDatabase } from "../migrations.js";
import { createExecutionStore } from "../executions.js";

const makeExecution = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  id: "exec-1",
  sessionId: "sess-1",
  turnId: "turn-1",
  workspaceId: "default",
  principalType: "user",
  principalId: "user:local",
  source: "interactive",
  runtimeId: "rt-1",
  model: "claude-opus-4-20250514",
  policySnapshotId: "policy-1",
  state: "queued",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("ExecutionStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createExecutionStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    store = createExecutionStore(db);
  });

  it("createExecution inserts and getExecution retrieves it", () => {
    const execution = makeExecution({
      parentExecutionId: "exec-root",
      idempotencyKey: "idem-1",
    });
    store.createExecution(execution);

    const retrieved = store.getExecution("exec-1");
    expect(retrieved).toEqual(execution);
  });

  it("listExecutions returns records ordered by createdAt desc", () => {
    store.createExecution(makeExecution({
      id: "exec-1",
      createdAt: "2026-01-01T00:00:01Z",
      updatedAt: "2026-01-01T00:00:01Z",
    }));
    store.createExecution(makeExecution({
      id: "exec-2",
      createdAt: "2026-01-01T00:00:03Z",
      updatedAt: "2026-01-01T00:00:03Z",
    }));
    store.createExecution(makeExecution({
      id: "exec-3",
      createdAt: "2026-01-01T00:00:02Z",
      updatedAt: "2026-01-01T00:00:02Z",
    }));

    const executions = store.listExecutions("sess-1");
    expect(executions.map((entry) => entry.id)).toEqual(["exec-2", "exec-3", "exec-1"]);
  });

  it("transitionExecutionState enforces lifecycle and writes metadata", () => {
    store.createExecution(makeExecution());

    const running = store.transitionExecutionState("exec-1", "running", {
      updatedAt: "2026-01-01T00:00:01Z",
      startedAt: "2026-01-01T00:00:01Z",
    });
    expect(running.state).toBe("running");
    expect(running.startedAt).toBe("2026-01-01T00:00:01Z");

    const done = store.transitionExecutionState("exec-1", "succeeded", {
      updatedAt: "2026-01-01T00:00:02Z",
      completedAt: "2026-01-01T00:00:02Z",
      stopReason: "end_turn",
    });
    expect(done.state).toBe("succeeded");
    expect(done.completedAt).toBe("2026-01-01T00:00:02Z");
    expect(done.stopReason).toBe("end_turn");
  });

  it("transitionExecutionState rejects invalid transitions", () => {
    store.createExecution(makeExecution());
    expect(() => store.transitionExecutionState("exec-1", "succeeded")).toThrow(
      /Invalid execution state transition/i,
    );
  });

  it("getExecutionStateCounts returns grouped totals", () => {
    store.createExecution(makeExecution({
      id: "exec-queued",
      state: "queued",
      createdAt: "2026-01-01T00:00:01Z",
      updatedAt: "2026-01-01T00:00:01Z",
    }));
    store.createExecution(makeExecution({
      id: "exec-running",
      state: "running",
      createdAt: "2026-01-01T00:00:02Z",
      updatedAt: "2026-01-01T00:00:02Z",
    }));
    store.createExecution(makeExecution({
      id: "exec-success",
      state: "succeeded",
      createdAt: "2026-01-01T00:00:03Z",
      updatedAt: "2026-01-01T00:00:03Z",
    }));
    store.createExecution(makeExecution({
      id: "exec-timeout",
      state: "timed_out",
      createdAt: "2026-01-01T00:00:04Z",
      updatedAt: "2026-01-01T00:00:04Z",
    }));

    expect(store.getExecutionStateCounts("sess-1")).toEqual({
      total: 4,
      queued: 1,
      running: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      timedOut: 1,
    });
  });
});
