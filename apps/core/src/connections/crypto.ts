import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encryption at rest for OAuth tokens (docs/CONNECTIONS.md §3).
 *
 * Scope, stated plainly: the key sits in the same directory as the database,
 * so this defends against the token turning up somewhere it shouldn't — a
 * backup, a synced folder, a glance at the SQLite file — and not at all
 * against code running as this user. Moving the key into the OS keychain is
 * the upgrade; until then the UI should not imply more than this delivers.
 */
const KEY_FILE = "connection.key";
const ALGO = "aes-256-gcm";

/** Keyed by data directory — a single cached key would leak across directories. */
const cachedKeys = new Map<string, Buffer>();

function keyPath(dataDir: string): string {
  return path.join(dataDir, KEY_FILE);
}

/** Load the local key, creating it on first use. Owner-only where the OS honours it. */
function loadKey(dataDir: string): Buffer {
  const cached = cachedKeys.get(dataDir);
  if (cached) return cached;

  const file = keyPath(dataDir);
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${KEY_FILE} is corrupt (expected a 32-byte key)`);
    cachedKeys.set(dataDir, key);
    return key;
  }

  const key = randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // no-op on Windows, meaningful elsewhere
  } catch {
    /* best effort */
  }
  cachedKeys.set(dataDir, key);
  return key;
}

/** `iv.tag.ciphertext`, all base64url. */
export function encryptSecret(dataDir: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, loadKey(dataDir), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

/** Returns null rather than throwing — a corrupt blob means "reconnect", not a crash. */
export function decryptSecret(dataDir: string, blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [ivB64, tagB64, dataB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv(ALGO, loadKey(dataDir), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
