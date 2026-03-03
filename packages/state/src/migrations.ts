import type { DatabaseAdapter } from "./database.js";

const hasColumn = (db: DatabaseAdapter, table: string, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
};

export const initDatabase = (db: DatabaseAdapter): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL DEFAULT 'default',
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
      workspaceId TEXT NOT NULL DEFAULT 'default',
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      toolName TEXT,
      toolCallId TEXT,
      timestamp TEXT NOT NULL,
      tokenEstimate INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_transcript_sessionId ON transcript_messages(sessionId);

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspaceId TEXT NOT NULL DEFAULT 'default',
      sessionId TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      keywords TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL,
      lastAccessedAt TEXT NOT NULL,
      tokenEstimate INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_session_kind_createdAt
      ON memory_items(sessionId, kind, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_session_lastAccessedAt
      ON memory_items(sessionId, lastAccessedAt DESC);
  `);

  if (!hasColumn(db, "sessions", "workspaceId")) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default';");
  }
  if (!hasColumn(db, "transcript_messages", "workspaceId")) {
    db.exec("ALTER TABLE transcript_messages ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default';");
  }
  if (!hasColumn(db, "memory_items", "workspaceId")) {
    db.exec("ALTER TABLE memory_items ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default';");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_workspaceId
      ON sessions(workspaceId, lastActivityAt DESC);
    CREATE INDEX IF NOT EXISTS idx_transcript_workspaceId_session
      ON transcript_messages(workspaceId, sessionId, id ASC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_kind_createdAt
      ON memory_items(workspaceId, kind, createdAt DESC);
  `);
};
