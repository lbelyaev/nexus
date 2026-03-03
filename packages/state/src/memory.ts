import type { DatabaseAdapter } from "./database.js";
import type { MemoryItem, MemoryItemKind } from "@nexus/types";

export interface MemoryStore {
  appendMemoryItem: (
    item: Omit<MemoryItem, "id" | "lastAccessedAt"> & { workspaceId?: string; lastAccessedAt?: string },
  ) => number;
  getMemoryItems: (
    sessionId: string,
    opts?: { kind?: MemoryItemKind; limit?: number; offset?: number; newestFirst?: boolean },
  ) => MemoryItem[];
  getWorkspaceMemoryItems: (
    workspaceId: string,
    opts?: {
      kind?: MemoryItemKind;
      limit?: number;
      offset?: number;
      newestFirst?: boolean;
      excludeSessionId?: string;
    },
  ) => MemoryItem[];
  searchMemory: (
    sessionId: string,
    query: string,
    opts?: { limit?: number; kinds?: MemoryItemKind[] },
  ) => MemoryItem[];
  searchWorkspaceMemory: (
    workspaceId: string,
    query: string,
    opts?: { limit?: number; kinds?: MemoryItemKind[]; excludeSessionId?: string },
  ) => MemoryItem[];
  touchMemoryItem: (id: number, timestamp?: string) => void;
  deleteMemory: (sessionId: string) => void;
  deleteWorkspaceMemory: (workspaceId: string) => void;
}

interface MemoryRow {
  id: number;
  workspaceId: string;
  sessionId: string;
  kind: string;
  content: string;
  source: string;
  confidence: number;
  keywords: string;
  createdAt: string;
  lastAccessedAt: string;
  tokenEstimate: number;
}

const parseKeywords = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
};

const rowToMemoryItem = (row: MemoryRow): MemoryItem => ({
  id: row.id,
  sessionId: row.sessionId,
  kind: row.kind as MemoryItemKind,
  content: row.content,
  source: row.source,
  confidence: row.confidence,
  keywords: parseKeywords(row.keywords),
  createdAt: row.createdAt,
  lastAccessedAt: row.lastAccessedAt,
  tokenEstimate: row.tokenEstimate,
});

export const createMemoryStore = (db: DatabaseAdapter): MemoryStore => {
  const insertStmt = db.prepare(
    `INSERT INTO memory_items (workspaceId, sessionId, kind, content, source, confidence, keywords, createdAt, lastAccessedAt, tokenEstimate)
     VALUES (@workspaceId, @sessionId, @kind, @content, @source, @confidence, @keywords, @createdAt, @lastAccessedAt, @tokenEstimate)`,
  );
  const touchStmt = db.prepare(
    "UPDATE memory_items SET lastAccessedAt = ? WHERE id = ?",
  );
  const deleteStmt = db.prepare(
    "DELETE FROM memory_items WHERE sessionId = ?",
  );
  const deleteWorkspaceStmt = db.prepare(
    "DELETE FROM memory_items WHERE workspaceId = ?",
  );

  const appendMemoryItem = (
    item: Omit<MemoryItem, "id" | "lastAccessedAt"> & { workspaceId?: string; lastAccessedAt?: string },
  ): number => {
    const now = item.lastAccessedAt ?? item.createdAt;
    insertStmt.run({
      workspaceId: item.workspaceId ?? "default",
      sessionId: item.sessionId,
      kind: item.kind,
      content: item.content,
      source: item.source,
      confidence: item.confidence,
      keywords: JSON.stringify(item.keywords),
      createdAt: item.createdAt,
      lastAccessedAt: now,
      tokenEstimate: item.tokenEstimate,
    });
    const row = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    return row.id;
  };

  const getMemoryItems = (
    sessionId: string,
    opts?: { kind?: MemoryItemKind; limit?: number; offset?: number; newestFirst?: boolean },
  ): MemoryItem[] => {
    const where: string[] = ["sessionId = ?"];
    const params: unknown[] = [sessionId];

    if (opts?.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }

    const orderBy = opts?.newestFirst ? "createdAt DESC, id DESC" : "createdAt ASC, id ASC";
    let sql = `SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`;

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

    const rows = db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemoryItem);
  };

  const getWorkspaceMemoryItems = (
    workspaceId: string,
    opts?: {
      kind?: MemoryItemKind;
      limit?: number;
      offset?: number;
      newestFirst?: boolean;
      excludeSessionId?: string;
    },
  ): MemoryItem[] => {
    const where: string[] = ["workspaceId = ?"];
    const params: unknown[] = [workspaceId];

    if (opts?.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts?.excludeSessionId) {
      where.push("sessionId != ?");
      params.push(opts.excludeSessionId);
    }

    const orderBy = opts?.newestFirst ? "createdAt DESC, id DESC" : "createdAt ASC, id ASC";
    let sql = `SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`;

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

    const rows = db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemoryItem);
  };

  const searchMemory = (
    sessionId: string,
    query: string,
    opts?: { limit?: number; kinds?: MemoryItemKind[] },
  ): MemoryItem[] => {
    const where: string[] = ["sessionId = ?"];
    const params: unknown[] = [sessionId];
    const likeQuery = `%${query}%`;
    where.push("(content LIKE ? OR keywords LIKE ?)");
    params.push(likeQuery, likeQuery);

    if (opts?.kinds && opts.kinds.length > 0) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      where.push(`kind IN (${placeholders})`);
      params.push(...opts.kinds);
    }

    let sql = `SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY confidence DESC, createdAt DESC, id DESC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemoryItem);
  };

  const searchWorkspaceMemory = (
    workspaceId: string,
    query: string,
    opts?: { limit?: number; kinds?: MemoryItemKind[]; excludeSessionId?: string },
  ): MemoryItem[] => {
    const where: string[] = ["workspaceId = ?"];
    const params: unknown[] = [workspaceId];
    const likeQuery = `%${query}%`;
    where.push("(content LIKE ? OR keywords LIKE ?)");
    params.push(likeQuery, likeQuery);

    if (opts?.kinds && opts.kinds.length > 0) {
      const placeholders = opts.kinds.map(() => "?").join(", ");
      where.push(`kind IN (${placeholders})`);
      params.push(...opts.kinds);
    }
    if (opts?.excludeSessionId) {
      where.push("sessionId != ?");
      params.push(opts.excludeSessionId);
    }

    let sql = `SELECT * FROM memory_items WHERE ${where.join(" AND ")} ORDER BY confidence DESC, createdAt DESC, id DESC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemoryItem);
  };

  const touchMemoryItem = (id: number, timestamp: string = new Date().toISOString()): void => {
    touchStmt.run(timestamp, id);
  };

  const deleteMemory = (sessionId: string): void => {
    deleteStmt.run(sessionId);
  };

  const deleteWorkspaceMemory = (workspaceId: string): void => {
    deleteWorkspaceStmt.run(workspaceId);
  };

  return {
    appendMemoryItem,
    getMemoryItems,
    getWorkspaceMemoryItems,
    searchMemory,
    searchWorkspaceMemory,
    touchMemoryItem,
    deleteMemory,
    deleteWorkspaceMemory,
  };
};
