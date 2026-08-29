import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret } from "../src/connections/crypto.js";
import { createPkce } from "../src/connections/oauth.js";
import { ConnectionStore } from "../src/connections/store.js";
import { openDatabase } from "../src/store/db.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-conn-"));
}

test("secrets round-trip through encryption", () => {
  const dir = tempDir();
  const secret = "GOCSPX-not-a-real-secret";
  const blob = encryptSecret(dir, secret);
  assert.notEqual(blob, secret);
  assert.ok(!blob.includes(secret), "ciphertext must not contain the plaintext");
  assert.equal(decryptSecret(dir, blob), secret);
});

test("a tampered or corrupt blob decrypts to null rather than throwing", () => {
  const dir = tempDir();
  const blob = encryptSecret(dir, "token");
  const [iv, tag, data] = blob.split(".");
  const tampered = [iv, tag, `${data!.slice(0, -2)}AA`].join(".");
  assert.equal(decryptSecret(dir, tampered), null);
  assert.equal(decryptSecret(dir, "nonsense"), null);
  assert.equal(decryptSecret(dir, null), null);
});

test("each data directory gets its own key, and that key persists", () => {
  const dir = tempDir();
  const blob = encryptSecret(dir, "refresh-token");
  assert.ok(fs.existsSync(path.join(dir, "connection.key")), "the key file lands in its own data directory");
  assert.equal(decryptSecret(dir, blob), "refresh-token");

  // A different data directory must not be able to read the first one's blob.
  const other = tempDir();
  assert.notEqual(decryptSecret(other, blob), "refresh-token");
});

test("PKCE challenge is the S256 hash of the verifier", () => {
  const { verifier, challenge } = createPkce();
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  assert.notEqual(verifier, challenge);
});

test("configuring a client stores no plaintext secret and exposes no tokens", () => {
  const dir = tempDir();
  const db = openDatabase(dir);
  const store = new ConnectionStore({ db, dataDir: dir, onChange: () => undefined, log: () => undefined });

  assert.equal(store.publicState()[0]?.status, "unconfigured");

  store.configure("google", "client-id.apps.googleusercontent.com", "GOCSPX-super-secret");

  const state = store.publicState()[0]!;
  assert.equal(state.status, "disconnected");
  assert.equal(state.provider, "google");
  // The wire shape carries status only. Check what actually crosses the socket,
  // which is the JSON form — undefined-valued keys do not survive it.
  const onWire = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(onWire).sort(), ["provider", "scopes", "status"]);

  const raw = JSON.stringify(db.prepare("SELECT * FROM connections").all());
  assert.ok(!raw.includes("GOCSPX-super-secret"), "client secret must be encrypted at rest");
  assert.ok(raw.includes("client-id.apps.googleusercontent.com"), "client id is not secret");
});

test("tools are refused while disconnected", async () => {
  const dir = tempDir();
  const db = openDatabase(dir);
  const store = new ConnectionStore({ db, dataDir: dir, onChange: () => undefined, log: () => undefined });

  assert.equal(store.isConnected("google"), false);
  assert.equal(store.hasScope("google", "https://www.googleapis.com/auth/calendar.readonly"), false);
  await assert.rejects(() => store.accessToken("google"), /not connected/);
});
