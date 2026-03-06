import type { DatabaseAdapter } from "./database.js";
import {
  applySessionLifecycleTransition,
  type SessionLifecycleEventRecord,
  type SessionLifecycleEventType,
  type SessionLifecycleState,
  type SessionParkedReason,
  type SessionRecord,
  type SessionInfo,
} from "@nexus/types";

export interface SessionListPageQuery {
  principalType?: SessionRecord["principalType"];
  principalId?: string;
  limit?: number;
  cursor?: string;
}

export interface SessionListPage {
  sessions: SessionInfo[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ApplySessionLifecycleEventInput {
  eventType: SessionLifecycleEventType;
  at?: string;
  reason?: string;
  parkedReason?: SessionParkedReason;
  actorPrincipalType?: SessionRecord["principalType"];
  actorPrincipalId?: string;
  metadata?: string;
}

export type SessionPatch = Partial<Omit<SessionRecord, "id" | "parkedReason" | "parkedAt">> & {
  parkedReason?: SessionParkedReason | null;
  parkedAt?: string | null;
};

export interface SessionStore {
  createSession: (session: SessionRecord) => void;
  getSession: (id: string) => SessionRecord | null;
  listSessions: () => SessionInfo[];
  listSessionsPage: (query: SessionListPageQuery) => SessionListPage;
  updateSession: (id: string, patch: SessionPatch) => void;
  incrementSessionTokenUsage: (id: string, inputDelta: number, outputDelta: number) => void;
  applySessionLifecycleEvent: (id: string, input: ApplySessionLifecycleEventInput) => SessionRecord;
  listSessionLifecycleEvents: (sessionId: string, limit?: number) => SessionLifecycleEventRecord[];
}

interface SessionRow {
  id: string;
  workspaceId: string;
  principalType: SessionRecord["principalType"];
  principalId: string;
  source: SessionRecord["source"];
  runtimeId: string;
  acpSessionId: string;
  status: string;
  lifecycleState?: string;
  parkedReason?: string | null;
  parkedAt?: string | null;
  lifecycleUpdatedAt?: string;
  lifecycleVersion?: number;
  createdAt: string;
  lastActivityAt: string;
  tokenInput: number;
  tokenOutput: number;
  model: string;
}

interface SessionLifecycleEventRow {
  id: number;
  sessionId: string;
  eventType: string;
  fromState: string;
  toState: string;
  reason?: string | null;
  parkedReason?: string | null;
  actorPrincipalType?: SessionRecord["principalType"] | null;
  actorPrincipalId?: string | null;
  metadata?: string | null;
  createdAt: string;
}

const sessionStatusToLifecycleState = (status: SessionRecord["status"]): SessionLifecycleState => (
  status === "active" ? "live" : "closed"
);

const lifecycleStateToSessionStatus = (state: SessionLifecycleState): SessionRecord["status"] => (
  state === "live" ? "active" : "idle"
);

const rowToRecord = (row: SessionRow): SessionRecord => {
  const lifecycleState =
    row.lifecycleState === "live" || row.lifecycleState === "parked" || row.lifecycleState === "closed"
      ? row.lifecycleState
      : sessionStatusToLifecycleState(row.status as SessionRecord["status"]);
  const lifecycleUpdatedAt = row.lifecycleUpdatedAt && row.lifecycleUpdatedAt.length > 0
    ? row.lifecycleUpdatedAt
    : row.lastActivityAt;
  const lifecycleVersion = typeof row.lifecycleVersion === "number" ? row.lifecycleVersion : 0;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    principalType: row.principalType,
    principalId: row.principalId,
    source: row.source,
    runtimeId: row.runtimeId,
    acpSessionId: row.acpSessionId,
    status: row.status as SessionRecord["status"],
    lifecycleState,
    ...(row.parkedReason ? { parkedReason: row.parkedReason as SessionParkedReason } : {}),
    ...(row.parkedAt ? { parkedAt: row.parkedAt } : {}),
    lifecycleUpdatedAt,
    lifecycleVersion,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    tokenUsage: { input: row.tokenInput, output: row.tokenOutput },
    model: row.model,
  };
};

const rowToInfo = (row: SessionRow): SessionInfo => {
  const lifecycleState =
    row.lifecycleState === "live" || row.lifecycleState === "parked" || row.lifecycleState === "closed"
      ? row.lifecycleState
      : sessionStatusToLifecycleState(row.status as SessionRecord["status"]);
  const lifecycleUpdatedAt = row.lifecycleUpdatedAt && row.lifecycleUpdatedAt.length > 0
    ? row.lifecycleUpdatedAt
    : row.lastActivityAt;
  const lifecycleVersion = typeof row.lifecycleVersion === "number" ? row.lifecycleVersion : 0;

  return {
    id: row.id,
    status: row.status as SessionInfo["status"],
    lifecycleState,
    ...(row.parkedReason ? { parkedReason: row.parkedReason as SessionParkedReason } : {}),
    ...(row.parkedAt ? { parkedAt: row.parkedAt } : {}),
    lifecycleUpdatedAt,
    lifecycleVersion,
    model: row.model,
    workspaceId: row.workspaceId,
    principalType: row.principalType,
    principalId: row.principalId,
    source: row.source,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
  };
};

const rowToLifecycleEventRecord = (row: SessionLifecycleEventRow): SessionLifecycleEventRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  eventType: row.eventType as SessionLifecycleEventType,
  fromState: row.fromState as SessionLifecycleState,
  toState: row.toState as SessionLifecycleState,
  ...(row.reason ? { reason: row.reason } : {}),
  ...(row.parkedReason ? { parkedReason: row.parkedReason as SessionParkedReason } : {}),
  ...(row.actorPrincipalType ? { actorPrincipalType: row.actorPrincipalType } : {}),
  ...(row.actorPrincipalId ? { actorPrincipalId: row.actorPrincipalId } : {}),
  ...(row.metadata ? { metadata: row.metadata } : {}),
  createdAt: row.createdAt,
});

const encodeSessionListCursor = (row: Pick<SessionRow, "id" | "lastActivityAt">): string =>
  Buffer.from(JSON.stringify({
    id: row.id,
    lastActivityAt: row.lastActivityAt,
  }), "utf8").toString("base64url");

const decodeSessionListCursor = (cursor: string): { id: string; lastActivityAt: string } => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || typeof parsed.lastActivityAt !== "string") {
      throw new Error("Invalid cursor payload");
    }
    return {
      id: parsed.id,
      lastActivityAt: parsed.lastActivityAt,
    };
  } catch {
    throw new Error("Invalid session list cursor");
  }
};

export const createSessionStore = (db: DatabaseAdapter): SessionStore => {
  const insertStmt = db.prepare(
    `INSERT INTO sessions (
      id,
      workspaceId,
      principalType,
      principalId,
      source,
      runtimeId,
      acpSessionId,
      status,
      lifecycleState,
      parkedReason,
      parkedAt,
      lifecycleUpdatedAt,
      lifecycleVersion,
      createdAt,
      lastActivityAt,
      tokenInput,
      tokenOutput,
      model
    )
    VALUES (
      @id,
      @workspaceId,
      @principalType,
      @principalId,
      @source,
      @runtimeId,
      @acpSessionId,
      @status,
      @lifecycleState,
      @parkedReason,
      @parkedAt,
      @lifecycleUpdatedAt,
      @lifecycleVersion,
      @createdAt,
      @lastActivityAt,
      @tokenInput,
      @tokenOutput,
      @model
    )`,
  );

  const insertLifecycleEventStmt = db.prepare(
    `INSERT INTO session_lifecycle_events (
      sessionId,
      eventType,
      fromState,
      toState,
      reason,
      parkedReason,
      actorPrincipalType,
      actorPrincipalId,
      metadata,
      createdAt
    )
    VALUES (
      @sessionId,
      @eventType,
      @fromState,
      @toState,
      @reason,
      @parkedReason,
      @actorPrincipalType,
      @actorPrincipalId,
      @metadata,
      @createdAt
    )`,
  );

  const getStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");

  const listStmt = db.prepare(
    "SELECT * FROM sessions ORDER BY lastActivityAt DESC",
  );
  const listPageStmt = db.prepare(
    `SELECT * FROM sessions
     WHERE (@principalType IS NULL OR principalType = @principalType)
       AND (@principalId IS NULL OR principalId = @principalId)
       AND (
         @cursorLastActivityAt IS NULL
         OR lastActivityAt < @cursorLastActivityAt
         OR (lastActivityAt = @cursorLastActivityAt AND id < @cursorId)
       )
     ORDER BY lastActivityAt DESC, id DESC
     LIMIT @limitPlusOne`,
  );
  const listLifecycleEventsStmt = db.prepare(
    `SELECT * FROM session_lifecycle_events
     WHERE sessionId = @sessionId
     ORDER BY createdAt DESC, id DESC
     LIMIT @limit`,
  );

  const logLifecycleEvent = (event: Omit<SessionLifecycleEventRecord, "id">): void => {
    insertLifecycleEventStmt.run({
      sessionId: event.sessionId,
      eventType: event.eventType,
      fromState: event.fromState,
      toState: event.toState,
      reason: event.reason ?? null,
      parkedReason: event.parkedReason ?? null,
      actorPrincipalType: event.actorPrincipalType ?? null,
      actorPrincipalId: event.actorPrincipalId ?? null,
      metadata: event.metadata ?? null,
      createdAt: event.createdAt,
    });
  };

  const createSession = (session: SessionRecord): void => {
    const lifecycleState = session.lifecycleState ?? sessionStatusToLifecycleState(session.status);
    const lifecycleUpdatedAt = session.lifecycleUpdatedAt ?? session.lastActivityAt;
    const lifecycleVersion = session.lifecycleVersion ?? 0;
    const parkedReason = lifecycleState === "parked" ? (session.parkedReason ?? null) : null;
    const parkedAt = lifecycleState === "parked" ? (session.parkedAt ?? lifecycleUpdatedAt) : null;

    insertStmt.run({
      id: session.id,
      workspaceId: session.workspaceId,
      principalType: session.principalType,
      principalId: session.principalId,
      source: session.source,
      runtimeId: session.runtimeId,
      acpSessionId: session.acpSessionId,
      status: session.status,
      lifecycleState,
      parkedReason,
      parkedAt,
      lifecycleUpdatedAt,
      lifecycleVersion,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      tokenInput: session.tokenUsage.input,
      tokenOutput: session.tokenUsage.output,
      model: session.model,
    });

    logLifecycleEvent({
      sessionId: session.id,
      eventType: "SESSION_CREATED",
      fromState: lifecycleState,
      toState: lifecycleState,
      ...(parkedReason ? { parkedReason } : {}),
      createdAt: lifecycleUpdatedAt,
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

  const listSessionsPage = (query: SessionListPageQuery): SessionListPage => {
    const safeLimit = Math.max(1, Math.min(Math.floor(query.limit ?? 20), 100));
    const cursor = query.cursor ? decodeSessionListCursor(query.cursor) : null;
    const rows = listPageStmt.all({
      principalType: query.principalType ?? null,
      principalId: query.principalId ?? null,
      cursorLastActivityAt: cursor?.lastActivityAt ?? null,
      cursorId: cursor?.id ?? null,
      limitPlusOne: safeLimit + 1,
    }) as SessionRow[];
    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const sessions = pageRows.map(rowToInfo);
    const nextCursor = hasMore && pageRows.length > 0
      ? encodeSessionListCursor(pageRows[pageRows.length - 1])
      : undefined;
    return {
      sessions,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  };

  const updateSession = (
    id: string,
    patch: SessionPatch,
  ): void => {
    const normalizedPatch: SessionPatch = { ...patch };
    if (normalizedPatch.lifecycleState !== undefined && normalizedPatch.status === undefined) {
      normalizedPatch.status = lifecycleStateToSessionStatus(normalizedPatch.lifecycleState);
    }
    if (normalizedPatch.status !== undefined && normalizedPatch.lifecycleState === undefined) {
      normalizedPatch.lifecycleState = sessionStatusToLifecycleState(normalizedPatch.status);
    }
    if (normalizedPatch.lifecycleState !== undefined && normalizedPatch.lifecycleState !== "parked") {
      if (normalizedPatch.parkedReason === undefined) normalizedPatch.parkedReason = null;
      if (normalizedPatch.parkedAt === undefined) normalizedPatch.parkedAt = null;
    }

    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (normalizedPatch.status !== undefined) {
      setClauses.push("status = @status");
      params.status = normalizedPatch.status;
    }
    if (normalizedPatch.lifecycleState !== undefined) {
      setClauses.push("lifecycleState = @lifecycleState");
      params.lifecycleState = normalizedPatch.lifecycleState;
    }
    if (normalizedPatch.parkedReason !== undefined) {
      setClauses.push("parkedReason = @parkedReason");
      params.parkedReason = normalizedPatch.parkedReason;
    }
    if (normalizedPatch.parkedAt !== undefined) {
      setClauses.push("parkedAt = @parkedAt");
      params.parkedAt = normalizedPatch.parkedAt;
    }
    if (normalizedPatch.lifecycleUpdatedAt !== undefined) {
      setClauses.push("lifecycleUpdatedAt = @lifecycleUpdatedAt");
      params.lifecycleUpdatedAt = normalizedPatch.lifecycleUpdatedAt;
    }
    if (normalizedPatch.lifecycleVersion !== undefined) {
      setClauses.push("lifecycleVersion = @lifecycleVersion");
      params.lifecycleVersion = normalizedPatch.lifecycleVersion;
    }
    if (normalizedPatch.runtimeId !== undefined) {
      setClauses.push("runtimeId = @runtimeId");
      params.runtimeId = normalizedPatch.runtimeId;
    }
    if (normalizedPatch.principalType !== undefined) {
      setClauses.push("principalType = @principalType");
      params.principalType = normalizedPatch.principalType;
    }
    if (normalizedPatch.principalId !== undefined) {
      setClauses.push("principalId = @principalId");
      params.principalId = normalizedPatch.principalId;
    }
    if (normalizedPatch.source !== undefined) {
      setClauses.push("source = @source");
      params.source = normalizedPatch.source;
    }
    if (normalizedPatch.workspaceId !== undefined) {
      setClauses.push("workspaceId = @workspaceId");
      params.workspaceId = normalizedPatch.workspaceId;
    }
    if (normalizedPatch.acpSessionId !== undefined) {
      setClauses.push("acpSessionId = @acpSessionId");
      params.acpSessionId = normalizedPatch.acpSessionId;
    }
    if (normalizedPatch.createdAt !== undefined) {
      setClauses.push("createdAt = @createdAt");
      params.createdAt = normalizedPatch.createdAt;
    }
    if (normalizedPatch.lastActivityAt !== undefined) {
      setClauses.push("lastActivityAt = @lastActivityAt");
      params.lastActivityAt = normalizedPatch.lastActivityAt;
    }
    if (normalizedPatch.model !== undefined) {
      setClauses.push("model = @model");
      params.model = normalizedPatch.model;
    }
    if (normalizedPatch.tokenUsage !== undefined) {
      setClauses.push("tokenInput = @tokenInput, tokenOutput = @tokenOutput");
      params.tokenInput = normalizedPatch.tokenUsage.input;
      params.tokenOutput = normalizedPatch.tokenUsage.output;
    }

    if (setClauses.length === 0) return;

    const sql = `UPDATE sessions SET ${setClauses.join(", ")} WHERE id = @id`;
    const result = db.prepare(sql).run(params);

    if (result.changes === 0) {
      throw new Error(`Session not found: ${id}`);
    }
  };

  const incrementSessionTokenUsage = (
    id: string,
    inputDelta: number,
    outputDelta: number,
  ): void => {
    const normalizedInput = Number.isFinite(inputDelta) ? Math.floor(inputDelta) : 0;
    const normalizedOutput = Number.isFinite(outputDelta) ? Math.floor(outputDelta) : 0;
    if (normalizedInput === 0 && normalizedOutput === 0) return;

    const result = db.prepare(
      `UPDATE sessions
       SET tokenInput = tokenInput + @inputDelta,
           tokenOutput = tokenOutput + @outputDelta
       WHERE id = @id`,
    ).run({
      id,
      inputDelta: normalizedInput,
      outputDelta: normalizedOutput,
    });

    if (result.changes === 0) {
      throw new Error(`Session not found: ${id}`);
    }
  };

  const applySessionLifecycleEvent = (
    id: string,
    input: ApplySessionLifecycleEventInput,
  ): SessionRecord => {
    const current = getSession(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }
    const currentState = current.lifecycleState ?? sessionStatusToLifecycleState(current.status);
    const transition = applySessionLifecycleTransition(currentState, input.eventType, {
      currentParkedReason: current.parkedReason,
      parkedReason: input.parkedReason,
    });
    if (!transition) {
      throw new Error(`Invalid lifecycle transition: ${currentState} -> ${input.eventType}`);
    }

    const at = input.at ?? new Date().toISOString();
    const nextVersion = (current.lifecycleVersion ?? 0) + 1;
    const nextParkedReason =
      transition.toState === "parked"
        ? (transition.parkedReason ?? current.parkedReason ?? "manual")
        : null;
    const nextParkedAt =
      transition.toState === "parked"
        ? (current.parkedAt ?? at)
        : null;

    updateSession(id, {
      status: lifecycleStateToSessionStatus(transition.toState),
      lifecycleState: transition.toState,
      parkedReason: nextParkedReason,
      parkedAt: nextParkedAt,
      lifecycleUpdatedAt: at,
      lifecycleVersion: nextVersion,
    });

    logLifecycleEvent({
      sessionId: id,
      eventType: input.eventType,
      fromState: transition.fromState,
      toState: transition.toState,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(nextParkedReason ? { parkedReason: nextParkedReason } : {}),
      ...(input.actorPrincipalType ? { actorPrincipalType: input.actorPrincipalType } : {}),
      ...(input.actorPrincipalId ? { actorPrincipalId: input.actorPrincipalId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: at,
    });

    return getSession(id)!;
  };

  const listSessionLifecycleEvents = (
    sessionId: string,
    limit = 50,
  ): SessionLifecycleEventRecord[] => {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    const rows = listLifecycleEventsStmt.all({ sessionId, limit: safeLimit }) as SessionLifecycleEventRow[];
    return rows.map(rowToLifecycleEventRecord);
  };

  return {
    createSession,
    getSession,
    listSessions,
    listSessionsPage,
    updateSession,
    incrementSessionTokenUsage,
    applySessionLifecycleEvent,
    listSessionLifecycleEvents,
  };
};
