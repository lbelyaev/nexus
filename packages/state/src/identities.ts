import type {
  OwnerIdentity,
  PrincipalBindingRecord,
  PrincipalType,
} from "@nexus/types";
import type { DatabaseAdapter } from "./database.js";

export interface IdentityStore {
  upsertOwnerIdentity: (identity: OwnerIdentity) => void;
  getOwnerIdentity: (did: string) => OwnerIdentity | null;
  upsertPrincipalBinding: (binding: PrincipalBindingRecord) => void;
  getPrincipalBinding: (principalType: PrincipalType, principalId: string) => PrincipalBindingRecord | null;
  listPrincipalBindingsByOwnerDid: (ownerDid: string) => PrincipalBindingRecord[];
}

interface OwnerIdentityRow {
  did: string;
  status: OwnerIdentity["status"];
  createdAt: string;
  updatedAt: string;
}

interface PrincipalBindingRow {
  principalType: PrincipalType;
  principalId: string;
  source: PrincipalBindingRecord["source"];
  ownerDid: string;
  bindingStatus: PrincipalBindingRecord["bindingStatus"];
  verificationMethodId?: string | null;
  proofFormat?: PrincipalBindingRecord["proofFormat"] | null;
  proofPayload?: string | null;
  createdAt: string;
  updatedAt: string;
}

const rowToOwnerIdentity = (row: OwnerIdentityRow): OwnerIdentity => ({
  did: row.did,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const rowToPrincipalBinding = (row: PrincipalBindingRow): PrincipalBindingRecord => ({
  principalType: row.principalType,
  principalId: row.principalId,
  source: row.source,
  ownerDid: row.ownerDid,
  bindingStatus: row.bindingStatus,
  ...(row.verificationMethodId ? { verificationMethodId: row.verificationMethodId } : {}),
  ...(row.proofFormat ? { proofFormat: row.proofFormat } : {}),
  ...(row.proofPayload ? { proofPayload: row.proofPayload } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createIdentityStore = (db: DatabaseAdapter): IdentityStore => {
  const upsertOwnerStmt = db.prepare(`
    INSERT INTO owner_identities (
      did,
      status,
      createdAt,
      updatedAt
    ) VALUES (
      @did,
      @status,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(did) DO UPDATE SET
      status = excluded.status,
      createdAt = excluded.createdAt,
      updatedAt = excluded.updatedAt
  `);
  const getOwnerStmt = db.prepare(
    "SELECT * FROM owner_identities WHERE did = @did",
  );
  const upsertBindingStmt = db.prepare(`
    INSERT INTO principal_bindings (
      principalType,
      principalId,
      source,
      ownerDid,
      bindingStatus,
      verificationMethodId,
      proofFormat,
      proofPayload,
      createdAt,
      updatedAt
    ) VALUES (
      @principalType,
      @principalId,
      @source,
      @ownerDid,
      @bindingStatus,
      @verificationMethodId,
      @proofFormat,
      @proofPayload,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(principalType, principalId) DO UPDATE SET
      source = excluded.source,
      ownerDid = excluded.ownerDid,
      bindingStatus = excluded.bindingStatus,
      verificationMethodId = excluded.verificationMethodId,
      proofFormat = excluded.proofFormat,
      proofPayload = excluded.proofPayload,
      createdAt = excluded.createdAt,
      updatedAt = excluded.updatedAt
  `);
  const getBindingStmt = db.prepare(
    `SELECT * FROM principal_bindings
     WHERE principalType = @principalType AND principalId = @principalId`,
  );
  const listBindingsByOwnerDidStmt = db.prepare(
    `SELECT * FROM principal_bindings
     WHERE ownerDid = @ownerDid
     ORDER BY updatedAt DESC, principalType ASC, principalId ASC`,
  );

  const upsertOwnerIdentity = (identity: OwnerIdentity): void => {
    upsertOwnerStmt.run(identity);
  };

  const getOwnerIdentity = (did: string): OwnerIdentity | null => {
    const row = getOwnerStmt.get({ did }) as OwnerIdentityRow | undefined;
    return row ? rowToOwnerIdentity(row) : null;
  };

  const upsertPrincipalBinding = (binding: PrincipalBindingRecord): void => {
    upsertBindingStmt.run({
      principalType: binding.principalType,
      principalId: binding.principalId,
      source: binding.source,
      ownerDid: binding.ownerDid,
      bindingStatus: binding.bindingStatus,
      verificationMethodId: binding.verificationMethodId ?? null,
      proofFormat: binding.proofFormat ?? null,
      proofPayload: binding.proofPayload ?? null,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    });
  };

  const getPrincipalBinding = (
    principalType: PrincipalType,
    principalId: string,
  ): PrincipalBindingRecord | null => {
    const row = getBindingStmt.get({ principalType, principalId }) as PrincipalBindingRow | undefined;
    return row ? rowToPrincipalBinding(row) : null;
  };

  const listPrincipalBindingsByOwnerDid = (ownerDid: string): PrincipalBindingRecord[] => {
    const rows = listBindingsByOwnerDidStmt.all({ ownerDid }) as PrincipalBindingRow[];
    return rows.map(rowToPrincipalBinding);
  };

  return {
    upsertOwnerIdentity,
    getOwnerIdentity,
    upsertPrincipalBinding,
    getPrincipalBinding,
    listPrincipalBindingsByOwnerDid,
  };
};
