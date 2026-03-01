// Thin runtime adapter for SQLite.
// Uses bun:sqlite when running on Bun, falls back to better-sqlite3.

export interface Statement {
  run: (...params: unknown[]) => { changes: number };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

export interface DatabaseAdapter {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
}

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

// bun:sqlite requires named parameter keys to include the $ prefix.
// better-sqlite3 uses @param in SQL but strips the prefix from object keys.
// This helper adds $ prefix to bare object keys so bun:sqlite can bind them,
// and rewrites @param to $param in the SQL.
const prefixKeys = (params: unknown[]): unknown[] => {
  if (params.length !== 1 || typeof params[0] !== "object" || params[0] === null || Array.isArray(params[0])) {
    return params;
  }
  const obj = params[0] as Record<string, unknown>;
  const prefixed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    prefixed[key.startsWith("$") || key.startsWith("@") || key.startsWith(":") ? key : `$${key}`] = value;
  }
  return [prefixed];
};

const rewriteAtToDollar = (sql: string): string => sql.replace(/@(\w+)/g, "$$$1");

const createBunAdapter = (dbPath: string): DatabaseAdapter => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as {
    Database: new (path: string) => {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        run: (...params: unknown[]) => void;
        get: (...params: unknown[]) => unknown;
        all: (...params: unknown[]) => unknown[];
      };
      close: () => void;
      changes: number;
    };
  };

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(rewriteAtToDollar(sql));
      return {
        run: (...params) => {
          stmt.run(...prefixKeys(params));
          return { changes: db.changes };
        },
        get: (...params) => stmt.get(...prefixKeys(params)),
        all: (...params) => stmt.all(...prefixKeys(params)),
      };
    },
    close: () => db.close(),
  };
};

const createBetterSqlite3Adapter = (dbPath: string): DatabaseAdapter => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require("better-sqlite3") as {
    new (path: string): {
      exec: (sql: string) => void;
      pragma: (sql: string) => unknown;
      prepare: (sql: string) => {
        run: (...params: unknown[]) => { changes: number };
        get: (...params: unknown[]) => unknown;
        all: (...params: unknown[]) => unknown[];
      };
      close: () => void;
    };
  };

  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");

  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
};

export const openDatabase = (dbPath: string): DatabaseAdapter =>
  isBun ? createBunAdapter(dbPath) : createBetterSqlite3Adapter(dbPath);
