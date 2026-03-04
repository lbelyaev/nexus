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
      principalType TEXT NOT NULL DEFAULT 'user',
      principalId TEXT NOT NULL DEFAULT 'user:local',
      source TEXT NOT NULL DEFAULT 'interactive',
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

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      turnId TEXT NOT NULL,
      parentExecutionId TEXT,
      idempotencyKey TEXT,
      workspaceId TEXT NOT NULL DEFAULT 'default',
      principalType TEXT NOT NULL DEFAULT 'user',
      principalId TEXT NOT NULL DEFAULT 'user:local',
      source TEXT NOT NULL DEFAULT 'interactive',
      runtimeId TEXT NOT NULL,
      model TEXT NOT NULL,
      policySnapshotId TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      stopReason TEXT,
      errorMessage TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      startedAt TEXT,
      completedAt TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_session_kind_createdAt
      ON memory_items(sessionId, kind, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_session_lastAccessedAt
      ON memory_items(sessionId, lastAccessedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_session_createdAt
      ON executions(sessionId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_parentExecutionId
      ON executions(parentExecutionId);
    CREATE INDEX IF NOT EXISTS idx_executions_state_updatedAt
      ON executions(state, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_session_idempotencyKey
      ON executions(sessionId, idempotencyKey);
  `);

  if (!hasColumn(db, "sessions", "workspaceId")) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default';");
  }
  if (!hasColumn(db, "sessions", "principalType")) {
    db.exec("ALTER TABLE sessions ADD COLUMN principalType TEXT NOT NULL DEFAULT 'user';");
  }
  if (!hasColumn(db, "sessions", "principalId")) {
    db.exec("ALTER TABLE sessions ADD COLUMN principalId TEXT NOT NULL DEFAULT 'user:local';");
  }
  if (!hasColumn(db, "sessions", "source")) {
    db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'interactive';");
  }
  if (!hasColumn(db, "transcript_messages", "workspaceId")) {
    db.exec("ALTER TABLE transcript_messages ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default';");
  }
  if (!hasColumn(db, "memory_items", "workspaceId")) {
    db.exec("ALTER TABLE memory_items ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default';");
  }
  if (!hasColumn(db, "executions", "parentExecutionId")) {
    db.exec("ALTER TABLE executions ADD COLUMN parentExecutionId TEXT;");
  }
  if (!hasColumn(db, "executions", "idempotencyKey")) {
    db.exec("ALTER TABLE executions ADD COLUMN idempotencyKey TEXT;");
  }
  if (!hasColumn(db, "executions", "workspaceId")) {
    db.exec("ALTER TABLE executions ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default';");
  }
  if (!hasColumn(db, "executions", "principalType")) {
    db.exec("ALTER TABLE executions ADD COLUMN principalType TEXT NOT NULL DEFAULT 'user';");
  }
  if (!hasColumn(db, "executions", "principalId")) {
    db.exec("ALTER TABLE executions ADD COLUMN principalId TEXT NOT NULL DEFAULT 'user:local';");
  }
  if (!hasColumn(db, "executions", "source")) {
    db.exec("ALTER TABLE executions ADD COLUMN source TEXT NOT NULL DEFAULT 'interactive';");
  }
  if (!hasColumn(db, "executions", "runtimeId")) {
    db.exec("ALTER TABLE executions ADD COLUMN runtimeId TEXT NOT NULL DEFAULT 'default';");
  }
  if (!hasColumn(db, "executions", "model")) {
    db.exec("ALTER TABLE executions ADD COLUMN model TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, "executions", "policySnapshotId")) {
    db.exec("ALTER TABLE executions ADD COLUMN policySnapshotId TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, "executions", "state")) {
    db.exec("ALTER TABLE executions ADD COLUMN state TEXT NOT NULL DEFAULT 'queued';");
  }
  if (!hasColumn(db, "executions", "stopReason")) {
    db.exec("ALTER TABLE executions ADD COLUMN stopReason TEXT;");
  }
  if (!hasColumn(db, "executions", "errorMessage")) {
    db.exec("ALTER TABLE executions ADD COLUMN errorMessage TEXT;");
  }
  if (!hasColumn(db, "executions", "createdAt")) {
    db.exec("ALTER TABLE executions ADD COLUMN createdAt TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, "executions", "updatedAt")) {
    db.exec("ALTER TABLE executions ADD COLUMN updatedAt TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, "executions", "startedAt")) {
    db.exec("ALTER TABLE executions ADD COLUMN startedAt TEXT;");
  }
  if (!hasColumn(db, "executions", "completedAt")) {
    db.exec("ALTER TABLE executions ADD COLUMN completedAt TEXT;");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_workspaceId
      ON sessions(workspaceId, lastActivityAt DESC);
    CREATE INDEX IF NOT EXISTS idx_transcript_workspaceId_session
      ON transcript_messages(workspaceId, sessionId, id ASC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_kind_createdAt
      ON memory_items(workspaceId, kind, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_session_createdAt
      ON executions(sessionId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_parentExecutionId
      ON executions(parentExecutionId);
    CREATE INDEX IF NOT EXISTS idx_executions_state_updatedAt
      ON executions(state, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_session_idempotencyKey
      ON executions(sessionId, idempotencyKey);
  `);
};
