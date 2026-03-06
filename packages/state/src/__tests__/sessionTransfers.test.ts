import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import { initDatabase } from "../migrations.js";
import { createSessionTransferStore, type SessionTransferRecord } from "../sessionTransfers.js";

const makeTransfer = (overrides: Partial<SessionTransferRecord> = {}): SessionTransferRecord => ({
  sessionId: "sess-1",
  fromPrincipalType: "user",
  fromPrincipalId: "user:alice",
  targetPrincipalType: "user",
  targetPrincipalId: "user:bob",
  expiresAt: "2025-01-01T00:10:00Z",
  state: "requested",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("SessionTransferStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createSessionTransferStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    store = createSessionTransferStore(db);
  });

  it("upserts and retrieves a transfer record", () => {
    const transfer = makeTransfer();
    store.upsertSessionTransfer(transfer);

    expect(store.getSessionTransfer("sess-1")).toEqual(transfer);
  });

  it("lists transfers newest-first by updatedAt", () => {
    store.upsertSessionTransfer(makeTransfer({
      sessionId: "sess-1",
      updatedAt: "2025-01-01T00:01:00Z",
    }));
    store.upsertSessionTransfer(makeTransfer({
      sessionId: "sess-2",
      updatedAt: "2025-01-01T00:03:00Z",
    }));
    store.upsertSessionTransfer(makeTransfer({
      sessionId: "sess-3",
      updatedAt: "2025-01-01T00:02:00Z",
    }));

    expect(store.listSessionTransfers().map((transfer) => transfer.sessionId)).toEqual([
      "sess-2",
      "sess-3",
      "sess-1",
    ]);
  });

  it("updates an existing transfer on upsert", () => {
    store.upsertSessionTransfer(makeTransfer());
    store.upsertSessionTransfer(makeTransfer({
      state: "expired",
      expiresAt: "2025-01-01T00:05:00Z",
      updatedAt: "2025-01-01T00:05:00Z",
    }));

    expect(store.getSessionTransfer("sess-1")).toEqual(makeTransfer({
      state: "expired",
      expiresAt: "2025-01-01T00:05:00Z",
      updatedAt: "2025-01-01T00:05:00Z",
    }));
  });

  it("deletes a transfer record", () => {
    store.upsertSessionTransfer(makeTransfer());
    store.deleteSessionTransfer("sess-1");

    expect(store.getSessionTransfer("sess-1")).toBeNull();
    expect(store.listSessionTransfers()).toEqual([]);
  });
});
