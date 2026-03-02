import type { DatabaseAdapter } from "./database.js";
import type { TranscriptMessage } from "@nexus/types";

export interface TranscriptStore {
  appendMessage: (msg: Omit<TranscriptMessage, "id">) => void;
  getTranscript: (sessionId: string, opts?: { limit?: number; offset?: number }) => TranscriptMessage[];
  getSessionTokenEstimate: (sessionId: string) => number;
  deleteTranscript: (sessionId: string) => void;
}

interface TranscriptRow {
  id: number;
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
    `INSERT INTO transcript_messages (sessionId, role, content, toolName, toolCallId, timestamp, tokenEstimate)
     VALUES (@sessionId, @role, @content, @toolName, @toolCallId, @timestamp, @tokenEstimate)`,
  );

  const tokenSumStmt = db.prepare(
    "SELECT COALESCE(SUM(tokenEstimate), 0) as total FROM transcript_messages WHERE sessionId = ?",
  );

  const deleteStmt = db.prepare(
    "DELETE FROM transcript_messages WHERE sessionId = ?",
  );

  const appendMessage = (msg: Omit<TranscriptMessage, "id">): void => {
    insertStmt.run({
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

  const deleteTranscript = (sessionId: string): void => {
    deleteStmt.run(sessionId);
  };

  return { appendMessage, getTranscript, getSessionTokenEstimate, deleteTranscript };
};
