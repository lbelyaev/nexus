import { openDatabase } from "./database.js";
import { initDatabase } from "./migrations.js";
import { createSessionStore, type SessionStore } from "./sessions.js";
import { createAuditStore, type AuditStore } from "./audit.js";

export interface StateStore extends SessionStore, AuditStore {
  close: () => void;
}

export const createStateStore = (dbPath: string = ":memory:"): StateStore => {
  const db = openDatabase(dbPath);
  initDatabase(db);
  return {
    ...createSessionStore(db),
    ...createAuditStore(db),
    close: () => db.close(),
  };
};
