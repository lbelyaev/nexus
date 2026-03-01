import type { DatabaseAdapter } from "./database.js";
import type { AuditEvent } from "@nexus/types";

export interface AuditStore {
  logEvent: (event: AuditEvent) => void;
  getEvents: (sessionId: string) => AuditEvent[];
}

interface AuditRow {
  id: number;
  sessionId: string;
  timestamp: string;
  type: string;
  tool: string | null;
  detail: string;
}

const rowToEvent = (row: AuditRow): AuditEvent => ({
  id: row.id,
  sessionId: row.sessionId,
  timestamp: row.timestamp,
  type: row.type as AuditEvent["type"],
  ...(row.tool != null ? { tool: row.tool } : {}),
  detail: row.detail,
});

export const createAuditStore = (db: DatabaseAdapter): AuditStore => {
  const insertStmt = db.prepare(
    `INSERT INTO audit_events (sessionId, timestamp, type, tool, detail)
     VALUES (@sessionId, @timestamp, @type, @tool, @detail)`,
  );

  const getStmt = db.prepare(
    "SELECT * FROM audit_events WHERE sessionId = ? ORDER BY timestamp ASC",
  );

  const logEvent = (event: AuditEvent): void => {
    insertStmt.run({
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      type: event.type,
      tool: event.tool ?? null,
      detail: event.detail,
    });
  };

  const getEvents = (sessionId: string): AuditEvent[] => {
    const rows = getStmt.all(sessionId) as AuditRow[];
    return rows.map(rowToEvent);
  };

  return { logEvent, getEvents };
};
