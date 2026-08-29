import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { TranscriptEntry } from "@jarvis/shared";

type MessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * Conversation history (API messages) + human transcript, per session (JOBS J0.18).
 * `response.content` is stored whole so compaction / thinking blocks survive.
 */
export class SessionStore {
  private sessionId: string;

  constructor(private db: DatabaseSync) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'current_session'").get() as { value?: string } | undefined;
    this.sessionId = row?.value ?? this.createSession();
  }

  get id(): string {
    return this.sessionId;
  }

  private createSession(): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)").run(id, Date.now());
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('current_session', ?)").run(id);
    return id;
  }

  newSession(): string {
    this.sessionId = this.createSession();
    return this.sessionId;
  }

  appendMessage(msg: MessageParam, truncated = false): void {
    this.db
      .prepare("INSERT INTO messages (session_id, role, content_json, truncated, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(this.sessionId, msg.role, JSON.stringify(msg.content), truncated ? 1 : 0, Date.now());
  }

  getMessages(): MessageParam[] {
    const rows = this.db
      .prepare("SELECT role, content_json FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(this.sessionId) as { role: string; content_json: string }[];
    return rows.map((r) => ({ role: r.role as "user" | "assistant", content: JSON.parse(r.content_json) }));
  }

  appendTranscript(entry: Omit<TranscriptEntry, "id" | "ts"> & { id?: string; ts?: number }): TranscriptEntry {
    const full: TranscriptEntry = {
      id: entry.id ?? randomUUID(),
      ts: entry.ts ?? Date.now(),
      role: entry.role,
      text: entry.text,
      truncated: entry.truncated,
      meta: entry.meta,
    };
    this.db
      .prepare("INSERT OR REPLACE INTO transcript (id, session_id, role, text, ts, truncated, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(full.id, this.sessionId, full.role, full.text, full.ts, full.truncated ? 1 : 0, full.meta ? JSON.stringify(full.meta) : null);
    return full;
  }

  getTranscript(limit = 200): TranscriptEntry[] {
    const rows = this.db
      .prepare("SELECT id, role, text, ts, truncated, meta_json FROM transcript WHERE session_id = ? ORDER BY ts DESC LIMIT ?")
      .all(this.sessionId, limit) as { id: string; role: string; text: string; ts: number; truncated: number; meta_json: string | null }[];
    return rows
      .reverse()
      .map((r) => ({
        id: r.id,
        role: r.role as TranscriptEntry["role"],
        text: r.text,
        ts: r.ts,
        truncated: r.truncated === 1 || undefined,
        meta: r.meta_json ? (JSON.parse(r.meta_json) as Record<string, unknown>) : undefined,
      }));
  }

  audit(row: { tool: string; app?: string; argsDigest?: string; allowed: boolean; summary?: string }): void {
    this.db
      .prepare("INSERT INTO audit (ts, session_id, tool, app, args_digest, allowed, summary) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), this.sessionId, row.tool, row.app ?? null, row.argsDigest ?? null, row.allowed ? 1 : 0, row.summary ?? null);
  }

  metrics(turnId: string, data: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO metrics (ts, session_id, turn_id, json) VALUES (?, ?, ?, ?)")
      .run(Date.now(), this.sessionId, turnId, JSON.stringify(data));
  }
}
