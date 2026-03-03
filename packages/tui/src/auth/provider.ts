import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthProofProvider } from "@nexus/client-core";

interface TuiIdentityRecord {
  version: 1;
  principalType: "user";
  principalId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
}

const KEYCHAIN_SERVICE = "dev.nexus.client.identity";
const KEYCHAIN_ACCOUNT = "default";
const FALLBACK_PATH = join(homedir(), ".nexus", "client-identity.json");

const loadFromKeychain = (): TuiIdentityRecord | null => {
  if (process.platform !== "darwin") return null;
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Partial<TuiIdentityRecord>;
    if (
      parsed.version === 1
      && parsed.principalType === "user"
      && typeof parsed.principalId === "string"
      && typeof parsed.publicKeyPem === "string"
      && typeof parsed.privateKeyPem === "string"
    ) {
      return parsed as TuiIdentityRecord;
    }
    return null;
  } catch {
    return null;
  }
};

const saveToKeychain = (identity: TuiIdentityRecord): boolean => {
  if (process.platform !== "darwin") return false;
  const payload = JSON.stringify(identity);
  const result = spawnSync(
    "security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", payload],
    { encoding: "utf8" },
  );
  return result.status === 0;
};

const loadFromFallback = (): TuiIdentityRecord | null => {
  if (!existsSync(FALLBACK_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(FALLBACK_PATH, "utf8")) as Partial<TuiIdentityRecord>;
    if (
      parsed.version === 1
      && parsed.principalType === "user"
      && typeof parsed.principalId === "string"
      && typeof parsed.publicKeyPem === "string"
      && typeof parsed.privateKeyPem === "string"
    ) {
      return parsed as TuiIdentityRecord;
    }
    return null;
  } catch {
    return null;
  }
};

const saveToFallback = (identity: TuiIdentityRecord): void => {
  mkdirSync(dirname(FALLBACK_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(FALLBACK_PATH, JSON.stringify(identity), { mode: 0o600 });
};

const createIdentity = (): TuiIdentityRecord => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const suffix = createHash("sha256").update(publicKey, "utf8").digest("base64url").slice(0, 24);
  return {
    version: 1,
    principalType: "user",
    principalId: `user:tui:${suffix}`,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    createdAt: new Date().toISOString(),
  };
};

const getOrCreateIdentity = (() => {
  let inMemory: TuiIdentityRecord | null = null;
  return (): TuiIdentityRecord => {
    if (inMemory) return inMemory;
    const existing = loadFromKeychain() ?? loadFromFallback();
    if (existing) {
      inMemory = existing;
      return existing;
    }
    const created = createIdentity();
    if (!saveToKeychain(created)) {
      saveToFallback(created);
    }
    inMemory = created;
    return created;
  };
})();

export const createTuiAuthProofProvider = (): AuthProofProvider => ({
  getAuthProof: async (challenge) => {
    const identity = getOrCreateIdentity();
    const payload = Buffer.from(
      `${challenge.nonce}:${identity.principalType}:${identity.principalId}`,
      "utf8",
    );
    const signature = sign(null, payload, identity.privateKeyPem).toString("base64");
    return {
      type: "auth_proof",
      algorithm: "ed25519",
      principalType: identity.principalType,
      principalId: identity.principalId,
      publicKey: identity.publicKeyPem,
      nonce: challenge.nonce,
      signature,
    };
  },
});

