import type { AuthProofProvider } from "@nexus/client-core";

interface WebIdentityRecord {
  version: 1;
  principalType: "user";
  principalId: string;
  publicKeyPem: string;
  privateKey: CryptoKey;
  privateKeyPkcs8B64: string;
  createdAt: string;
}

const DB_NAME = "nexus-auth";
const STORE_NAME = "keystore";
const STORE_KEY = "identity:v1";
const LS_KEY = "nexus.auth.identity.v1";

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const toPem = (label: string, bytes: Uint8Array): string => {
  const body = toBase64(bytes).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
};

const openIdentityDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open auth DB"));
  });

const loadFromIndexedDb = async (): Promise<WebIdentityRecord | null> => {
  const db = await openIdentityDb();
  try {
    const record = await new Promise<WebIdentityRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(STORE_KEY);
      request.onsuccess = () => {
        const value = request.result as Partial<WebIdentityRecord> | undefined;
        if (
          value
          && value.version === 1
          && value.principalType === "user"
          && typeof value.principalId === "string"
          && typeof value.publicKeyPem === "string"
          && value.privateKey instanceof CryptoKey
          && value.privateKey.type === "private"
          && typeof value.privateKeyPkcs8B64 === "string"
        ) {
          resolve(value as WebIdentityRecord);
          return;
        }
        resolve(null);
      };
      request.onerror = () => reject(request.error ?? new Error("Failed to read auth record"));
    });
    return record;
  } finally {
    db.close();
  }
};

const saveToIndexedDb = async (record: WebIdentityRecord): Promise<void> => {
  const db = await openIdentityDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(record, STORE_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Failed to write auth record"));
    });
  } finally {
    db.close();
  }
};

const loadFromLocalStorage = async (): Promise<WebIdentityRecord | null> => {
  if (typeof localStorage === "undefined" || !globalThis.crypto?.subtle) return null;
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      version: 1;
      principalType: "user";
      principalId: string;
      publicKeyPem: string;
      privateKeyPkcs8B64: string;
      createdAt: string;
    };
    if (
      parsed.version !== 1
      || parsed.principalType !== "user"
      || typeof parsed.principalId !== "string"
      || typeof parsed.publicKeyPem !== "string"
      || typeof parsed.privateKeyPkcs8B64 !== "string"
    ) {
      return null;
    }
    const privateKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(fromBase64(parsed.privateKeyPkcs8B64)),
      "Ed25519",
      true,
      ["sign"],
    );
    return {
      version: 1,
      principalType: "user",
      principalId: parsed.principalId,
      publicKeyPem: parsed.publicKeyPem,
      privateKey,
      privateKeyPkcs8B64: parsed.privateKeyPkcs8B64,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
};

const saveToLocalStorage = (record: WebIdentityRecord): void => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      version: 1,
      principalType: record.principalType,
      principalId: record.principalId,
      publicKeyPem: record.publicKeyPem,
      privateKeyPkcs8B64: record.privateKeyPkcs8B64,
      createdAt: record.createdAt,
    }),
  );
};

const computePrincipalId = async (spkiBytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(spkiBytes));
  const id = toBase64Url(new Uint8Array(digest)).slice(0, 24);
  return `user:web:${id}`;
};

const createIdentity = async (): Promise<WebIdentityRecord> => {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto is unavailable");
  }
  const generated = await globalThis.crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  );
  const keyPair = generated as CryptoKeyPair;
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", keyPair.publicKey));
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  return {
    version: 1,
    principalType: "user",
    principalId: await computePrincipalId(spki),
    publicKeyPem: toPem("PUBLIC KEY", spki),
    privateKey: keyPair.privateKey,
    privateKeyPkcs8B64: toBase64(pkcs8),
    createdAt: new Date().toISOString(),
  };
};

const getOrCreateIdentity = (() => {
  let inFlight: Promise<WebIdentityRecord> | null = null;
  return (): Promise<WebIdentityRecord> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const fromIdb = await loadFromIndexedDb().catch(() => null);
      if (fromIdb) return fromIdb;
      const fromStorage = await loadFromLocalStorage();
      if (fromStorage) {
        await saveToIndexedDb(fromStorage).catch(() => {});
        return fromStorage;
      }
      const created = await createIdentity();
      await saveToIndexedDb(created).catch(() => {});
      saveToLocalStorage(created);
      return created;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
})();

export const createWebAuthProofProvider = (): AuthProofProvider => ({
  getAuthProof: async (challenge) => {
    const identity = await getOrCreateIdentity();
    const payload = `${challenge.nonce}:${identity.principalType}:${identity.principalId}`;
    const signature = await globalThis.crypto.subtle.sign(
      "Ed25519",
      identity.privateKey,
      toArrayBuffer(new TextEncoder().encode(payload)),
    );
    return {
      type: "auth_proof",
      algorithm: "ed25519",
      principalType: identity.principalType,
      principalId: identity.principalId,
      publicKey: identity.publicKeyPem,
      nonce: challenge.nonce,
      signature: toBase64(new Uint8Array(signature)),
    };
  },
});
