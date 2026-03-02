import type { DatabaseAdapter } from "./database.js";

export const initDatabase = (db: DatabaseAdapter): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      runtimeId TEXT NOT NULL,
      acpSessionId TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastActivityAt TEXT NOT NULL,
      tokenInput INTEGER NOT NULL DEFAULT 0,
      tokenOutput INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      tool TEXT,
      detail TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_sessionId ON audit_events(sessionId);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE TABLE IF NOT EXISTS transcript_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      toolName TEXT,
      toolCallId TEXT,
      timestamp TEXT NOT NULL,
      tokenEstimate INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_transcript_sessionId ON transcript_messages(sessionId);
  `);
};
