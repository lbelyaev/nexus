import type { PrincipalType } from "@nexus/types";
import type { DatabaseAdapter } from "./database.js";

export interface SessionTransferRecord {
  sessionId: string;
  fromPrincipalType: PrincipalType;
  fromPrincipalId: string;
  targetPrincipalType: PrincipalType;
  targetPrincipalId: string;
  expiresAt: string;
  state: "requested" | "expired";
  createdAt: string;
  updatedAt: string;
}

export interface SessionTransferStore {
  upsertSessionTransfer: (transfer: SessionTransferRecord) => void;
  getSessionTransfer: (sessionId: string) => SessionTransferRecord | null;
  listSessionTransfers: () => SessionTransferRecord[];
  deleteSessionTransfer: (sessionId: string) => void;
}

interface SessionTransferRow {
  sessionId: string;
  fromPrincipalType: PrincipalType;
  fromPrincipalId: string;
  targetPrincipalType: PrincipalType;
  targetPrincipalId: string;
  expiresAt: string;
  state: SessionTransferRecord["state"];
  createdAt: string;
  updatedAt: string;
}

const rowToRecord = (row: SessionTransferRow): SessionTransferRecord => ({
  sessionId: row.sessionId,
  fromPrincipalType: row.fromPrincipalType,
  fromPrincipalId: row.fromPrincipalId,
  targetPrincipalType: row.targetPrincipalType,
  targetPrincipalId: row.targetPrincipalId,
  expiresAt: row.expiresAt,
  state: row.state,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createSessionTransferStore = (
  db: DatabaseAdapter,
): SessionTransferStore => {
  const upsertStmt = db.prepare(`
    INSERT INTO session_transfers (
      sessionId,
      fromPrincipalType,
      fromPrincipalId,
      targetPrincipalType,
      targetPrincipalId,
      expiresAt,
      state,
      createdAt,
      updatedAt
    ) VALUES (
      @sessionId,
      @fromPrincipalType,
      @fromPrincipalId,
      @targetPrincipalType,
      @targetPrincipalId,
      @expiresAt,
      @state,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(sessionId) DO UPDATE SET
      fromPrincipalType = excluded.fromPrincipalType,
      fromPrincipalId = excluded.fromPrincipalId,
      targetPrincipalType = excluded.targetPrincipalType,
      targetPrincipalId = excluded.targetPrincipalId,
      expiresAt = excluded.expiresAt,
      state = excluded.state,
      createdAt = excluded.createdAt,
      updatedAt = excluded.updatedAt
  `);
  const getStmt = db.prepare(
    "SELECT * FROM session_transfers WHERE sessionId = @sessionId",
  );
  const listStmt = db.prepare(
    "SELECT * FROM session_transfers ORDER BY updatedAt DESC, sessionId DESC",
  );
  const deleteStmt = db.prepare(
    "DELETE FROM session_transfers WHERE sessionId = @sessionId",
  );

  const upsertSessionTransfer = (transfer: SessionTransferRecord): void => {
    upsertStmt.run({
      sessionId: transfer.sessionId,
      fromPrincipalType: transfer.fromPrincipalType,
      fromPrincipalId: transfer.fromPrincipalId,
      targetPrincipalType: transfer.targetPrincipalType,
      targetPrincipalId: transfer.targetPrincipalId,
      expiresAt: transfer.expiresAt,
      state: transfer.state,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
    });
  };

  const getSessionTransfer = (sessionId: string): SessionTransferRecord | null => {
    const row = getStmt.get({ sessionId }) as SessionTransferRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  const listSessionTransfers = (): SessionTransferRecord[] => {
    const rows = listStmt.all() as SessionTransferRow[];
    return rows.map(rowToRecord);
  };

  const deleteSessionTransfer = (sessionId: string): void => {
    deleteStmt.run({ sessionId });
  };

  return {
    upsertSessionTransfer,
    getSessionTransfer,
    listSessionTransfers,
    deleteSessionTransfer,
  };
};
