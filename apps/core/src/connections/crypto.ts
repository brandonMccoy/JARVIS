import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encryption at rest for OAuth tokens (docs/CONNECTIONS.md §3).
 *
 * Tokens are sealed with AES-256-GCM under a key kept beside the database. On
 * Windows that key is itself wrapped with DPAPI under the current user, so a
 * copy of the data directory — a backup, a synced folder, a stolen disk — is
 * useless on another machine or under another account. Elsewhere the key is
 * still a plain file; see §8.
 *
 * Scope, stated plainly: this defeats a stolen directory, not a compromised
 * session. Code running as this user can always ask J.A.R.V.I.S. to decrypt,
 * because J.A.R.V.I.S. has to be able to. The UI should not imply more.
 */
const KEY_FILE = "connection.key";
const ALGO = "aes-256-gcm";
/** Marks a key file whose contents are a DPAPI blob rather than the raw key. */
const DPAPI_PREFIX = "dpapi:";

/** Keyed by data directory — a single cached key would leak across directories. */
const cachedKeys = new Map<string, Buffer>();

function keyPath(dataDir: string): string {
  return path.join(dataDir, KEY_FILE);
}

const usesDpapi = (): boolean => process.platform === "win32";

/**
 * Round-trips base64 through DPAPI in PowerShell. The payload goes over stdin,
 * never argv — command lines are readable by any process on the machine, which
 * would defeat the point.
 */
function dpapi(direction: "Protect" | "Unprotect", inputB64: string): string {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$in=[Console]::In.ReadToEnd().Trim();" +
    "$bytes=[Convert]::FromBase64String($in);" +
    `$out=[System.Security.Cryptography.ProtectedData]::${direction}($bytes,$null,'CurrentUser');` +
    "[Console]::Out.Write([Convert]::ToBase64String($out))";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: inputB64,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function readKeyFile(file: string): Buffer {
  const contents = fs.readFileSync(file, "utf8").trim();

  if (contents.startsWith(DPAPI_PREFIX)) {
    const blob = contents.slice(DPAPI_PREFIX.length);
    let raw: string;
    try {
      raw = dpapi("Unprotect", blob);
    } catch {
      // A different Windows account, or a profile that has been rebuilt. The
      // tokens are gone either way; say so in terms that suggest the fix.
      throw new Error(
        `${KEY_FILE} was encrypted by a different Windows user and cannot be read. ` +
          `Delete ${file} and reconnect your accounts.`,
      );
    }
    return decodeKey(raw, file);
  }

  return decodeKey(contents, file);
}

function decodeKey(base64: string, file: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error(`${file} is corrupt (expected a 32-byte key)`);
  return key;
}

/** DPAPI-wrapped on Windows, bare base64 elsewhere. Owner-only where the OS honours it. */
function writeKeyFile(file: string, key: Buffer): void {
  const base64 = key.toString("base64");
  const contents = usesDpapi() ? DPAPI_PREFIX + dpapi("Protect", base64) : base64;
  fs.writeFileSync(file, contents, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // no-op on Windows, meaningful elsewhere
  } catch {
    /* best effort */
  }
}

/** Load the local key, creating it on first use, upgrading it in place if needed. */
function loadKey(dataDir: string): Buffer {
  const cached = cachedKeys.get(dataDir);
  if (cached) return cached;

  const file = keyPath(dataDir);
  if (fs.existsSync(file)) {
    const key = readKeyFile(file);
    // A key written before DPAPI landed: wrap it now, in place. The key itself
    // does not change, so tokens encrypted under it stay readable.
    const isBare = !fs.readFileSync(file, "utf8").trim().startsWith(DPAPI_PREFIX);
    if (isBare && usesDpapi()) writeKeyFile(file, key);
    cachedKeys.set(dataDir, key);
    return key;
  }

  const key = randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  writeKeyFile(file, key);
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
