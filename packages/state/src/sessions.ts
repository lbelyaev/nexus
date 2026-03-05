import type { DatabaseAdapter } from "./database.js";
import type { SessionRecord, SessionInfo } from "@nexus/types";

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

export interface SessionStore {
  createSession: (session: SessionRecord) => void;
  getSession: (id: string) => SessionRecord | null;
  listSessions: () => SessionInfo[];
  listSessionsPage: (query: SessionListPageQuery) => SessionListPage;
  updateSession: (id: string, patch: Partial<Omit<SessionRecord, "id">>) => void;
  incrementSessionTokenUsage: (id: string, inputDelta: number, outputDelta: number) => void;
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
  createdAt: string;
  lastActivityAt: string;
  tokenInput: number;
  tokenOutput: number;
  model: string;
}

const rowToRecord = (row: SessionRow): SessionRecord => ({
  id: row.id,
  workspaceId: row.workspaceId,
  principalType: row.principalType,
  principalId: row.principalId,
  source: row.source,
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
  principalType: row.principalType,
  principalId: row.principalId,
  source: row.source,
  createdAt: row.createdAt,
  lastActivityAt: row.lastActivityAt,
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
    `INSERT INTO sessions (id, workspaceId, principalType, principalId, source, runtimeId, acpSessionId, status, createdAt, lastActivityAt, tokenInput, tokenOutput, model)
     VALUES (@id, @workspaceId, @principalType, @principalId, @source, @runtimeId, @acpSessionId, @status, @createdAt, @lastActivityAt, @tokenInput, @tokenOutput, @model)`,
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

  const createSession = (session: SessionRecord): void => {
    insertStmt.run({
      id: session.id,
      workspaceId: session.workspaceId,
      principalType: session.principalType,
      principalId: session.principalId,
      source: session.source,
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
    if (patch.principalType !== undefined) {
      setClauses.push("principalType = @principalType");
      params.principalType = patch.principalType;
    }
    if (patch.principalId !== undefined) {
      setClauses.push("principalId = @principalId");
      params.principalId = patch.principalId;
    }
    if (patch.source !== undefined) {
      setClauses.push("source = @source");
      params.source = patch.source;
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

  return {
    createSession,
    getSession,
    listSessions,
    listSessionsPage,
    updateSession,
    incrementSessionTokenUsage,
  };
};
