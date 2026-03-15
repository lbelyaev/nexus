import type { DatabaseAdapter } from "./database.js";
import { isGatewayEvent, type GatewayEvent, type StoredSessionEvent } from "@nexus/types";

export interface SessionEventQueryOptions {
  afterId?: number;
  types?: string[];
  executionId?: string;
  limit?: number;
}

export interface SessionEventStore {
  appendSessionEvent: (event: Extract<GatewayEvent, { sessionId: string }>) => number;
  getSessionEvents: (sessionId: string, opts?: SessionEventQueryOptions) => StoredSessionEvent[];
  getLatestSessionEventId: (sessionId: string) => number | undefined;
  deleteSessionEvents: (sessionId: string) => void;
  countSessionEvents: (sessionId: string) => number;
}

interface SessionEventRow {
  id: number;
  sessionId: string;
  type: string;
  payload: string;
  timestamp: string;
  executionId: string | null;
  turnId: string | null;
}

const parseStoredPayload = (payload: string): GatewayEvent => {
  const parsed = JSON.parse(payload) as unknown;
  if (!isGatewayEvent(parsed)) {
    throw new Error("Invalid stored session event payload");
  }
  return parsed;
};

const rowToStoredSessionEvent = (row: SessionEventRow): StoredSessionEvent => ({
  id: row.id,
  sessionId: row.sessionId,
  type: row.type as GatewayEvent["type"],
  payload: parseStoredPayload(row.payload),
  timestamp: row.timestamp,
  ...(row.executionId != null ? { executionId: row.executionId } : {}),
  ...(row.turnId != null ? { turnId: row.turnId } : {}),
});

export const createSessionEventStore = (db: DatabaseAdapter): SessionEventStore => {
  const insertStmt = db.prepare(`
    INSERT INTO session_events (
      sessionId,
      type,
      payload,
      timestamp,
      executionId,
      turnId
    ) VALUES (
      @sessionId,
      @type,
      @payload,
      @timestamp,
      @executionId,
      @turnId
    )
  `);
  const latestIdStmt = db.prepare(`
    SELECT id
    FROM session_events
    WHERE sessionId = @sessionId
    ORDER BY id DESC
    LIMIT 1
  `);
  const countStmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM session_events
    WHERE sessionId = @sessionId
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM session_events
    WHERE sessionId = @sessionId
  `);
  const lastInsertIdStmt = db.prepare("SELECT last_insert_rowid() AS id");

  const appendSessionEvent = (
    event: Extract<GatewayEvent, { sessionId: string }>,
  ): number => {
    insertStmt.run({
      sessionId: event.sessionId,
      type: event.type,
      payload: JSON.stringify(event),
      timestamp: new Date().toISOString(),
      executionId: "executionId" in event && typeof event.executionId === "string" ? event.executionId : null,
      turnId: "turnId" in event && typeof event.turnId === "string" ? event.turnId : null,
    });
    const row = lastInsertIdStmt.get() as { id: number } | undefined;
    if (!row || typeof row.id !== "number") {
      throw new Error("Failed to read inserted session event id");
    }
    return row.id;
  };

  const getSessionEvents = (
    sessionId: string,
    opts?: SessionEventQueryOptions,
  ): StoredSessionEvent[] => {
    let sql = "SELECT * FROM session_events WHERE sessionId = ?";
    const params: unknown[] = [sessionId];

    if (opts?.afterId !== undefined) {
      sql += " AND id > ?";
      params.push(opts.afterId);
    }

    if (opts?.types && opts.types.length > 0) {
      sql += ` AND type IN (${opts.types.map(() => "?").join(", ")})`;
      params.push(...opts.types);
    }

    if (opts?.executionId !== undefined) {
      sql += " AND executionId = ?";
      params.push(opts.executionId);
    }

    sql += " ORDER BY id ASC";

    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params) as SessionEventRow[];
    return rows.map(rowToStoredSessionEvent);
  };

  const getLatestSessionEventId = (sessionId: string): number | undefined => {
    const row = latestIdStmt.get({ sessionId }) as { id: number } | undefined;
    return typeof row?.id === "number" ? row.id : undefined;
  };

  const deleteSessionEvents = (sessionId: string): void => {
    deleteStmt.run({ sessionId });
  };

  const countSessionEvents = (sessionId: string): number => {
    const row = countStmt.get({ sessionId }) as { total: number } | undefined;
    return row?.total ?? 0;
  };

  return {
    appendSessionEvent,
    getSessionEvents,
    getLatestSessionEventId,
    deleteSessionEvents,
    countSessionEvents,
  };
};
