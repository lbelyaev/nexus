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
      displayName TEXT,
      runtimeId TEXT NOT NULL,
      acpSessionId TEXT NOT NULL,
      status TEXT NOT NULL,
      lifecycleState TEXT NOT NULL DEFAULT 'live',
      parkedReason TEXT,
      parkedAt TEXT,
      lifecycleUpdatedAt TEXT NOT NULL DEFAULT '',
      lifecycleVersion INTEGER NOT NULL DEFAULT 0,
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
    CREATE INDEX IF NOT EXISTS idx_sessions_lastActivity_id
      ON sessions(lastActivityAt DESC, id DESC);

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

    CREATE TABLE IF NOT EXISTS channel_bindings (
      adapterId TEXT NOT NULL,
      conversationId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      principalType TEXT NOT NULL DEFAULT 'user',
      principalId TEXT NOT NULL DEFAULT 'user:local',
      runtimeId TEXT,
      model TEXT,
      workspaceId TEXT,
      typingIndicator INTEGER NOT NULL DEFAULT 1,
      streamingMode TEXT NOT NULL DEFAULT 'off',
      steeringMode TEXT NOT NULL DEFAULT 'off',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (adapterId, conversationId)
    );

    CREATE TABLE IF NOT EXISTS session_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      eventType TEXT NOT NULL,
      fromState TEXT NOT NULL,
      toState TEXT NOT NULL,
      reason TEXT,
      parkedReason TEXT,
      actorPrincipalType TEXT,
      actorPrincipalId TEXT,
      metadata TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_transfers (
      sessionId TEXT PRIMARY KEY,
      fromPrincipalType TEXT NOT NULL,
      fromPrincipalId TEXT NOT NULL,
      targetPrincipalType TEXT NOT NULL,
      targetPrincipalId TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      state TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_sessionId
      ON channel_bindings(sessionId);
    CREATE INDEX IF NOT EXISTS idx_session_lifecycle_events_session_createdAt
      ON session_lifecycle_events(sessionId, createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_lifecycle_events_eventType_createdAt
      ON session_lifecycle_events(eventType, createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_transfers_target_updatedAt
      ON session_transfers(targetPrincipalType, targetPrincipalId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_session_transfers_state_expiresAt
      ON session_transfers(state, expiresAt ASC);
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
  if (!hasColumn(db, "sessions", "displayName")) {
    db.exec("ALTER TABLE sessions ADD COLUMN displayName TEXT;");
  }
  if (!hasColumn(db, "sessions", "lifecycleState")) {
    db.exec("ALTER TABLE sessions ADD COLUMN lifecycleState TEXT NOT NULL DEFAULT 'live';");
  }
  if (!hasColumn(db, "sessions", "parkedReason")) {
    db.exec("ALTER TABLE sessions ADD COLUMN parkedReason TEXT;");
  }
  if (!hasColumn(db, "sessions", "parkedAt")) {
    db.exec("ALTER TABLE sessions ADD COLUMN parkedAt TEXT;");
  }
  if (!hasColumn(db, "sessions", "lifecycleUpdatedAt")) {
    db.exec("ALTER TABLE sessions ADD COLUMN lifecycleUpdatedAt TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, "sessions", "lifecycleVersion")) {
    db.exec("ALTER TABLE sessions ADD COLUMN lifecycleVersion INTEGER NOT NULL DEFAULT 0;");
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
    UPDATE sessions
    SET lifecycleState = CASE
      WHEN status = 'active' THEN 'live'
      ELSE 'closed'
    END
    WHERE lifecycleState IS NULL OR lifecycleState = '';
  `);
  db.exec(`
    UPDATE sessions
    SET lifecycleUpdatedAt = lastActivityAt
    WHERE lifecycleUpdatedAt IS NULL OR lifecycleUpdatedAt = '';
  `);
  db.exec(`
    UPDATE sessions
    SET lifecycleVersion = 0
    WHERE lifecycleVersion IS NULL;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_workspaceId
      ON sessions(workspaceId, lastActivityAt DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_lifecycleState
      ON sessions(lifecycleState);
    CREATE INDEX IF NOT EXISTS idx_sessions_lastActivity_id
      ON sessions(lastActivityAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_principal_lastActivity_id
      ON sessions(principalType, principalId, lastActivityAt DESC, id DESC);
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
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_sessionId
      ON channel_bindings(sessionId);
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_principal
      ON channel_bindings(principalType, principalId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_session_lifecycle_events_session_createdAt
      ON session_lifecycle_events(sessionId, createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_lifecycle_events_eventType_createdAt
      ON session_lifecycle_events(eventType, createdAt DESC, id DESC);
  `);
};
