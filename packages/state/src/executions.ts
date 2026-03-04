import type { ExecutionRecord, ExecutionState } from "@nexus/types";
import type { DatabaseAdapter } from "./database.js";

export interface ExecutionTransitionPatch {
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface ExecutionStore {
  createExecution: (execution: ExecutionRecord) => void;
  getExecution: (id: string) => ExecutionRecord | null;
  listExecutions: (sessionId: string, limit?: number) => ExecutionRecord[];
  transitionExecutionState: (
    id: string,
    nextState: ExecutionState,
    patch?: ExecutionTransitionPatch,
  ) => ExecutionRecord;
}

interface ExecutionRow {
  id: string;
  sessionId: string;
  turnId: string;
  parentExecutionId: string | null;
  idempotencyKey: string | null;
  workspaceId: string;
  principalType: ExecutionRecord["principalType"];
  principalId: string;
  source: ExecutionRecord["source"];
  runtimeId: string;
  model: string;
  policySnapshotId: string;
  state: ExecutionState;
  stopReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const TRANSITIONS: Record<ExecutionState, ReadonlySet<ExecutionState>> = {
  queued: new Set<ExecutionState>(["running", "failed", "cancelled", "timed_out"]),
  running: new Set<ExecutionState>(["succeeded", "failed", "cancelled", "timed_out"]),
  succeeded: new Set<ExecutionState>(),
  failed: new Set<ExecutionState>(),
  cancelled: new Set<ExecutionState>(),
  timed_out: new Set<ExecutionState>(),
};

const rowToRecord = (row: ExecutionRow): ExecutionRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  turnId: row.turnId,
  ...(row.parentExecutionId ? { parentExecutionId: row.parentExecutionId } : {}),
  ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
  workspaceId: row.workspaceId,
  principalType: row.principalType,
  principalId: row.principalId,
  source: row.source,
  runtimeId: row.runtimeId,
  model: row.model,
  policySnapshotId: row.policySnapshotId,
  state: row.state,
  ...(row.stopReason ? { stopReason: row.stopReason } : {}),
  ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.startedAt ? { startedAt: row.startedAt } : {}),
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
});

const assertTransition = (current: ExecutionState, next: ExecutionState): void => {
  if (current === next) return;
  const allowed = TRANSITIONS[current];
  if (!allowed.has(next)) {
    throw new Error(`Invalid execution state transition: ${current} -> ${next}`);
  }
};

export const createExecutionStore = (db: DatabaseAdapter): ExecutionStore => {
  const insertStmt = db.prepare(
    `INSERT INTO executions (
      id,
      sessionId,
      turnId,
      parentExecutionId,
      idempotencyKey,
      workspaceId,
      principalType,
      principalId,
      source,
      runtimeId,
      model,
      policySnapshotId,
      state,
      stopReason,
      errorMessage,
      createdAt,
      updatedAt,
      startedAt,
      completedAt
    ) VALUES (
      @id,
      @sessionId,
      @turnId,
      @parentExecutionId,
      @idempotencyKey,
      @workspaceId,
      @principalType,
      @principalId,
      @source,
      @runtimeId,
      @model,
      @policySnapshotId,
      @state,
      @stopReason,
      @errorMessage,
      @createdAt,
      @updatedAt,
      @startedAt,
      @completedAt
    )`,
  );

  const getStmt = db.prepare("SELECT * FROM executions WHERE id = ?");
  const listBySessionStmt = db.prepare(
    "SELECT * FROM executions WHERE sessionId = @sessionId ORDER BY createdAt DESC LIMIT @limit",
  );

  const createExecution = (execution: ExecutionRecord): void => {
    insertStmt.run({
      id: execution.id,
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      parentExecutionId: execution.parentExecutionId ?? null,
      idempotencyKey: execution.idempotencyKey ?? null,
      workspaceId: execution.workspaceId,
      principalType: execution.principalType,
      principalId: execution.principalId,
      source: execution.source,
      runtimeId: execution.runtimeId,
      model: execution.model,
      policySnapshotId: execution.policySnapshotId,
      state: execution.state,
      stopReason: execution.stopReason ?? null,
      errorMessage: execution.errorMessage ?? null,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      startedAt: execution.startedAt ?? null,
      completedAt: execution.completedAt ?? null,
    });
  };

  const getExecution = (id: string): ExecutionRecord | null => {
    const row = getStmt.get(id) as ExecutionRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  const listExecutions = (sessionId: string, limit = 50): ExecutionRecord[] => {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = listBySessionStmt.all({
      sessionId,
      limit: safeLimit,
    }) as ExecutionRow[];
    return rows.map(rowToRecord);
  };

  const transitionExecutionState = (
    id: string,
    nextState: ExecutionState,
    patch: ExecutionTransitionPatch = {},
  ): ExecutionRecord => {
    const current = getExecution(id);
    if (!current) {
      throw new Error(`Execution not found: ${id}`);
    }
    assertTransition(current.state, nextState);

    const setClauses = ["state = @state", "updatedAt = @updatedAt"];
    const params: Record<string, unknown> = {
      id,
      state: nextState,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    if (patch.startedAt !== undefined) {
      setClauses.push("startedAt = @startedAt");
      params.startedAt = patch.startedAt;
    }
    if (patch.completedAt !== undefined) {
      setClauses.push("completedAt = @completedAt");
      params.completedAt = patch.completedAt;
    }
    if (patch.stopReason !== undefined) {
      setClauses.push("stopReason = @stopReason");
      params.stopReason = patch.stopReason;
    }
    if (patch.errorMessage !== undefined) {
      setClauses.push("errorMessage = @errorMessage");
      params.errorMessage = patch.errorMessage;
    }

    db.prepare(`UPDATE executions SET ${setClauses.join(", ")} WHERE id = @id`).run(params);
    const updated = getExecution(id);
    if (!updated) {
      throw new Error(`Execution not found after update: ${id}`);
    }
    return updated;
  };

  return {
    createExecution,
    getExecution,
    listExecutions,
    transitionExecutionState,
  };
};
