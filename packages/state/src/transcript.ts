import type { DatabaseAdapter } from "./database.js";
import type { TranscriptMessage } from "@nexus/types";

export interface TranscriptStore {
  appendMessage: (msg: Omit<TranscriptMessage, "id"> & { workspaceId?: string }) => void;
  getTranscript: (sessionId: string, opts?: { limit?: number; offset?: number }) => TranscriptMessage[];
  getSessionTokenEstimate: (sessionId: string) => number;
  getWorkspaceTokenEstimate: (workspaceId: string) => number;
  countWorkspaceMessages: (workspaceId: string) => number;
  deleteTranscript: (sessionId: string) => void;
}

interface TranscriptRow {
  id: number;
  workspaceId: string;
  sessionId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  timestamp: string;
  tokenEstimate: number;
}

const rowToMessage = (row: TranscriptRow): TranscriptMessage => ({
  id: row.id,
  sessionId: row.sessionId,
  role: row.role as TranscriptMessage["role"],
  content: row.content,
  ...(row.toolName != null ? { toolName: row.toolName } : {}),
  ...(row.toolCallId != null ? { toolCallId: row.toolCallId } : {}),
  timestamp: row.timestamp,
  tokenEstimate: row.tokenEstimate,
});

export const createTranscriptStore = (db: DatabaseAdapter): TranscriptStore => {
  const insertStmt = db.prepare(
    `INSERT INTO transcript_messages (workspaceId, sessionId, role, content, toolName, toolCallId, timestamp, tokenEstimate)
     VALUES (@workspaceId, @sessionId, @role, @content, @toolName, @toolCallId, @timestamp, @tokenEstimate)`,
  );

  const tokenSumStmt = db.prepare(
    "SELECT COALESCE(SUM(tokenEstimate), 0) as total FROM transcript_messages WHERE sessionId = ?",
  );
  const workspaceTokenSumStmt = db.prepare(
    "SELECT COALESCE(SUM(tokenEstimate), 0) as total FROM transcript_messages WHERE workspaceId = ?",
  );
  const workspaceMessageCountStmt = db.prepare(
    "SELECT COUNT(*) as total FROM transcript_messages WHERE workspaceId = ?",
  );

  const deleteStmt = db.prepare(
    "DELETE FROM transcript_messages WHERE sessionId = ?",
  );

  const appendMessage = (msg: Omit<TranscriptMessage, "id"> & { workspaceId?: string }): void => {
    insertStmt.run({
      workspaceId: msg.workspaceId ?? "default",
      sessionId: msg.sessionId,
      role: msg.role,
      content: msg.content,
      toolName: msg.toolName ?? null,
      toolCallId: msg.toolCallId ?? null,
      timestamp: msg.timestamp,
      tokenEstimate: msg.tokenEstimate,
    });
  };

  const getTranscript = (
    sessionId: string,
    opts?: { limit?: number; offset?: number },
  ): TranscriptMessage[] => {
    let sql = "SELECT * FROM transcript_messages WHERE sessionId = ? ORDER BY id ASC";
    const params: unknown[] = [sessionId];

    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    if (opts?.offset !== undefined) {
      if (opts.limit === undefined) {
        sql += " LIMIT -1";
      }
      sql += " OFFSET ?";
      params.push(opts.offset);
    }

    const rows = db.prepare(sql).all(...params) as TranscriptRow[];
    return rows.map(rowToMessage);
  };

  const getSessionTokenEstimate = (sessionId: string): number => {
    const row = tokenSumStmt.get(sessionId) as { total: number } | undefined;
    return row?.total ?? 0;
  };

  const getWorkspaceTokenEstimate = (workspaceId: string): number => {
    const row = workspaceTokenSumStmt.get(workspaceId) as { total: number } | undefined;
    return row?.total ?? 0;
  };

  const countWorkspaceMessages = (workspaceId: string): number => {
    const row = workspaceMessageCountStmt.get(workspaceId) as { total: number } | undefined;
    return row?.total ?? 0;
  };

  const deleteTranscript = (sessionId: string): void => {
    deleteStmt.run(sessionId);
  };

  return {
    appendMessage,
    getTranscript,
    getSessionTokenEstimate,
    getWorkspaceTokenEstimate,
    countWorkspaceMessages,
    deleteTranscript,
  };
};
