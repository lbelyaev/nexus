import type { DatabaseAdapter } from "./database.js";
import type { SessionRecord, SessionInfo } from "@nexus/types";

export interface SessionStore {
  createSession: (session: SessionRecord) => void;
  getSession: (id: string) => SessionRecord | null;
  listSessions: () => SessionInfo[];
  updateSession: (id: string, patch: Partial<Omit<SessionRecord, "id">>) => void;
}

interface SessionRow {
  id: string;
  workspaceId: string;
  runtimeId: string;
  acpSessionId: string;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  tokenInput: number;
  tokenOutput: number;
  model: string;
}

const rowToRecord = (row: SessionRow): SessionRecord => ({
  id: row.id,
  workspaceId: row.workspaceId,
  runtimeId: row.runtimeId,
  acpSessionId: row.acpSessionId,
  status: row.status as SessionRecord["status"],
  createdAt: row.createdAt,
  lastActivityAt: row.lastActivityAt,
  tokenUsage: { input: row.tokenInput, output: row.tokenOutput },
  model: row.model,
});

const rowToInfo = (row: SessionRow): SessionInfo => ({
  id: row.id,
  status: row.status as SessionInfo["status"],
  model: row.model,
  workspaceId: row.workspaceId,
  createdAt: row.createdAt,
  lastActivityAt: row.lastActivityAt,
});

export const createSessionStore = (db: DatabaseAdapter): SessionStore => {
  const insertStmt = db.prepare(
    `INSERT INTO sessions (id, workspaceId, runtimeId, acpSessionId, status, createdAt, lastActivityAt, tokenInput, tokenOutput, model)
     VALUES (@id, @workspaceId, @runtimeId, @acpSessionId, @status, @createdAt, @lastActivityAt, @tokenInput, @tokenOutput, @model)`,
  );

  const getStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");

  const listStmt = db.prepare(
    "SELECT * FROM sessions ORDER BY lastActivityAt DESC",
  );

  const createSession = (session: SessionRecord): void => {
    insertStmt.run({
      id: session.id,
      workspaceId: session.workspaceId,
      runtimeId: session.runtimeId,
      acpSessionId: session.acpSessionId,
      status: session.status,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      tokenInput: session.tokenUsage.input,
      tokenOutput: session.tokenUsage.output,
      model: session.model,
    });
  };

  const getSession = (id: string): SessionRecord | null => {
    const row = getStmt.get(id) as SessionRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  const listSessions = (): SessionInfo[] => {
    const rows = listStmt.all() as SessionRow[];
    return rows.map(rowToInfo);
  };

  const updateSession = (
    id: string,
    patch: Partial<Omit<SessionRecord, "id">>,
  ): void => {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (patch.status !== undefined) {
      setClauses.push("status = @status");
      params.status = patch.status;
    }
    if (patch.runtimeId !== undefined) {
      setClauses.push("runtimeId = @runtimeId");
      params.runtimeId = patch.runtimeId;
    }
    if (patch.workspaceId !== undefined) {
      setClauses.push("workspaceId = @workspaceId");
      params.workspaceId = patch.workspaceId;
    }
    if (patch.acpSessionId !== undefined) {
      setClauses.push("acpSessionId = @acpSessionId");
      params.acpSessionId = patch.acpSessionId;
    }
    if (patch.createdAt !== undefined) {
      setClauses.push("createdAt = @createdAt");
      params.createdAt = patch.createdAt;
    }
    if (patch.lastActivityAt !== undefined) {
      setClauses.push("lastActivityAt = @lastActivityAt");
      params.lastActivityAt = patch.lastActivityAt;
    }
    if (patch.model !== undefined) {
      setClauses.push("model = @model");
      params.model = patch.model;
    }
    if (patch.tokenUsage !== undefined) {
      setClauses.push("tokenInput = @tokenInput, tokenOutput = @tokenOutput");
      params.tokenInput = patch.tokenUsage.input;
      params.tokenOutput = patch.tokenUsage.output;
    }

    if (setClauses.length === 0) return;

    const sql = `UPDATE sessions SET ${setClauses.join(", ")} WHERE id = @id`;
    const result = db.prepare(sql).run(params);

    if (result.changes === 0) {
      throw new Error(`Session not found: ${id}`);
    }
  };

  return { createSession, getSession, listSessions, updateSession };
};
