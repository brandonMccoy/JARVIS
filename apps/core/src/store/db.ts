import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Storage on Node's built-in SQLite (no native build step — PLAN §11).
 */
export function openDatabase(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "jarvis.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     title TEXT
   );
   CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     content_json TEXT NOT NULL,
     truncated INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
   CREATE TABLE IF NOT EXISTS transcript (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     text TEXT NOT NULL,
     ts INTEGER NOT NULL,
     truncated INTEGER NOT NULL DEFAULT 0,
     meta_json TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(session_id, ts);
   CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     session_id TEXT,
     tool TEXT NOT NULL,
     app TEXT,
     args_digest TEXT,
     allowed INTEGER NOT NULL,
     summary TEXT
   );
   CREATE TABLE IF NOT EXISTS metrics (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     session_id TEXT,
     turn_id TEXT,
     json TEXT NOT NULL
   );`,
  // 2 — account connections (docs/CONNECTIONS.md §3). Token columns hold
  // AES-256-GCM blobs, never plaintext; the OAuth client secret is the user's
  // own and is stored the same way.
  `CREATE TABLE IF NOT EXISTS connections (
     id             TEXT PRIMARY KEY,
     status         TEXT NOT NULL,
     account        TEXT,
     scopes         TEXT NOT NULL DEFAULT '',
     client_id      TEXT,
     client_secret  TEXT,
     access_token   TEXT,
     refresh_token  TEXT,
     expires_at     INTEGER,
     connected_at   INTEGER,
     error          TEXT
   );`,
];

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const current = Number(
    (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value ?? "0",
  );
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(i + 1));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
