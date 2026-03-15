import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseAdapter } from "../database.js";
import { initDatabase } from "../migrations.js";
import { createIdentityStore } from "../identities.js";

describe("IdentityStore", () => {
  let db: DatabaseAdapter;
  let store: ReturnType<typeof createIdentityStore>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    initDatabase(db);
    store = createIdentityStore(db);
  });

  it("upserts and reads owner identities", () => {
    store.upsertOwnerIdentity({
      did: "did:key:z6Mkowner",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(store.getOwnerIdentity("did:key:z6Mkowner")).toEqual({
      did: "did:key:z6Mkowner",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("upserts principal bindings and lists them by owner DID", () => {
    store.upsertOwnerIdentity({
      did: "did:key:z6Mkowner",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    store.upsertPrincipalBinding({
      principalType: "user",
      principalId: "web:alice",
      source: "web",
      ownerDid: "did:key:z6Mkowner",
      bindingStatus: "verified",
      verificationMethodId: "did:key:z6Mkowner#z6Mkowner",
      proofFormat: "did-auth",
      proofPayload: "{\"challengeId\":\"abc\"}",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    store.upsertPrincipalBinding({
      principalType: "user",
      principalId: "telegram:12345",
      source: "telegram",
      ownerDid: "did:key:z6Mkowner",
      bindingStatus: "verified",
      createdAt: "2026-01-01T00:01:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    });

    expect(store.getPrincipalBinding("user", "web:alice")?.ownerDid).toBe("did:key:z6Mkowner");
    expect(store.listPrincipalBindingsByOwnerDid("did:key:z6Mkowner").map((binding) => binding.principalId)).toEqual([
      "telegram:12345",
      "web:alice",
    ]);
  });
});
