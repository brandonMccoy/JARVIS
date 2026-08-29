import Anthropic from "@anthropic-ai/sdk";
import { createHash, randomUUID } from "node:crypto";
import { GOOGLE_SCOPES, MODELS, folderGrants, mailBodiesEnabled, type Activity, type ImagePayload, type ServerEvent, type Settings } from "@jarvis/shared";
import { VOICE_SAMPLE_RATE } from "../config.js";
import type { ConnectionStore } from "../connections/store.js";
import type { SessionStore } from "../store/sessions.js";
import type { SettingsService } from "../store/settings.js";
import { SentenceChunker } from "../voice/chunker.js";
import type { TtsProvider } from "../voice/tts.js";
import { matchIntent, type Intent } from "./intents.js";
import { buildSystem } from "./persona.js";
import { BUILTIN_TOOLS, CONNECTED_TOOLS, FILESYSTEM_TOOLS, FS_WRITE_TOOLS, executeTool } from "./tools.js";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaToolUnion = Anthropic.Beta.BetaToolUnion;
type StreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;

export interface BrainDeps {
  client: Anthropic | null;
  settings: SettingsService;
  sessions: SessionStore;
  connections: ConnectionStore;
  tts: () => TtsProvider;
  emit: (e: ServerEvent) => void;
  requestScreenshot: () => Promise<ImagePayload | null>;
  screenShareActive: () => boolean;
  log: (msg: string, extra?: unknown) => void;
}

interface Turn {
  id: string;
  abort: AbortController;
  chunker: SentenceChunker;
  seq: number;
  speechQueue: Promise<void>;
  spokenText: string;
  fullText: string;
  truncated: boolean;
  startedAt: number;
  firstTextAt?: number;
  firstAudioAt?: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  modelId: string;
}

/**
 * The brain (PLAN §3). One instance per core process.
 *
 * - Streams every turn; activity is derived from real stream events (§6.2).
 * - Manual tool loop with AbortController so barge-in is deterministic.
 * - Cancellation correctness (§3.5): an aborted turn never leaves an orphaned
 *   tool_use in history.
 */
export class Brain {
  private turn: Turn | null = null;
  private lastActivity: Activity = { kind: "idle" };

  constructor(private deps: BrainDeps) {}

  get busy(): boolean {
    return this.turn !== null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async handleUtterance(text: string, source: "voice" | "text", images?: ImagePayload[]): Promise<void> {
    if (this.turn) this.interrupt(); // a new utterance is a barge-in
    const entry = this.deps.sessions.appendTranscript({ role: "user", text, meta: { source, images: images?.length ?? 0 } });
    this.deps.emit({ type: "transcript.append", entry });

    const intent = !images?.length ? matchIntent(text, this.deps.settings.get()) : null;
    if (intent) {
      await this.runIntent(intent, entry.id);
      return;
    }
    await this.runClaudeTurn(text, entry.id, images);
  }

  /** Stop speaking and thinking immediately. Safe to call when idle. */
  interrupt(): void {
    const t = this.turn;
    if (!t) return;
    t.truncated = true;
    t.abort.abort();
  }

  newSession(): string {
    this.interrupt();
    const id = this.deps.sessions.newSession();
    this.deps.emit({ type: "session.reset", sessionId: id });
    return id;
  }

  // -------------------------------------------------------------------------
  // Intents (fast path)
  // -------------------------------------------------------------------------

  private async runIntent(intent: Intent, replyTo: string): Promise<void> {
    if (intent.kind === "stop") {
      this.activity({ kind: "idle" });
      return;
    }
    const turn = this.beginTurn(replyTo);
    try {
      if (intent.kind === "new_session") {
        const id = this.deps.sessions.newSession();
        this.deps.emit({ type: "session.reset", sessionId: id });
      }
      if (intent.kind === "switch_model" || intent.kind === "set_personality") {
        if (Object.keys(intent.patch).length) this.deps.settings.patch(intent.patch);
      }
      this.activity({ kind: "speaking" });
      this.speak(turn, intent.reply);
    } finally {
      await this.finishTurn(turn, { fastPath: intent.kind });
    }
  }

  // -------------------------------------------------------------------------
  // Claude turn
  // -------------------------------------------------------------------------

  private async runClaudeTurn(text: string, replyTo: string, images?: ImagePayload[]): Promise<void> {
    const turn = this.beginTurn(replyTo);
    const { client, sessions, settings } = this.deps;

    if (!client) {
      this.activity({ kind: "speaking" });
      this.speak(turn, `I'm afraid my reasoning core isn't connected, ${settings.get().personality.honorific}. Set ANTHROPIC_API_KEY in apps/core/.env and restart me.`);
      await this.finishTurn(turn, {});
      return;
    }

    const userContent: BetaContentBlockParam[] | string = images?.length
      ? [
          ...images.map<BetaContentBlockParam>((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.data },
          })),
          { type: "text", text },
        ]
      : text;
    const userMsg: BetaMessageParam = { role: "user", content: userContent };
    sessions.appendMessage(userMsg);
    const messages = sessions.getMessages();
    const mode: "spoken" | "analysis" = images?.length ? "analysis" : "spoken";

    this.activity({ kind: "thinking" });

    try {
      for (let hop = 0; hop < 8; hop++) {
        if (turn.abort.signal.aborted) break;
        const s = settings.get();
        const model = MODELS[s.brain.model];
        turn.modelId = model.id;
        const params = this.buildParams(s, messages, mode);

        const partial = new PartialAssembler();
        const stream = client.beta.messages.stream(params, { signal: turn.abort.signal });

        let message: Anthropic.Beta.BetaMessage;
        try {
          for await (const event of stream) {
            partial.ingest(event);
            this.onStreamEvent(event, turn, partial);
          }
          message = await stream.finalMessage();
        } catch (err) {
          if (turn.abort.signal.aborted) {
            this.persistAborted(partial, messages);
            break;
          }
          throw err;
        }

        this.recordUsage(turn, message);
        const assistantMsg: BetaMessageParam = { role: "assistant", content: message.content };
        sessions.appendMessage(assistantMsg);
        messages.push(assistantMsg);

        if (message.stop_reason === "refusal") {
          const why = message.stop_details?.type === "refusal" ? message.stop_details.explanation : undefined;
          this.deps.log("refusal", why);
          this.speak(turn, `I'm afraid I must decline that one, ${s.personality.honorific}.`);
          break;
        }
        if (message.stop_reason === "pause_turn") continue;

        if (message.stop_reason === "tool_use") {
          const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          const results: BetaToolResultBlockParam[] = [];
          for (const use of uses) {
            this.deps.emit({ type: "tool.call", turnId: turn.id, name: use.name, input: use.input });
            this.activity({ kind: use.name === "take_screenshot" ? "viewing_screen" : "tool", detail: humanToolName(use.name) });
            const outcome = await executeTool(use.name, use.input, {
              settings: () => settings.get(),
              patchSettings: (p) => settings.patch(p),
              requestScreenshot: this.deps.requestScreenshot,
              screenShareActive: this.deps.screenShareActive,
              connections: this.deps.connections,
            });
            sessions.audit({
              tool: use.name,
              argsDigest: digest(use.input),
              allowed: true,
              summary: outcome.summary,
            });
            this.deps.emit({ type: "tool.result", turnId: turn.id, name: use.name, ok: !outcome.isError, summary: outcome.summary });
            this.deps.emit({
              type: "transcript.append",
              entry: sessions.appendTranscript({ role: "tool", text: outcome.summary, meta: { tool: use.name, ok: !outcome.isError } }),
            });
            results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, is_error: outcome.isError });
          }
          // All results in ONE user message (parallel-tool-use contract).
          const resultMsg: BetaMessageParam = { role: "user", content: results };
          sessions.appendMessage(resultMsg);
          messages.push(resultMsg);
          if (turn.abort.signal.aborted) break;
          this.activity({ kind: "thinking" });
          continue;
        }
        break; // end_turn, max_tokens, stop_sequence
      }
    } catch (err) {
      this.handleError(turn, err);
    } finally {
      await this.finishTurn(turn, { model: turn.modelId });
    }
  }

  /**
   * PLAN §7 layer 1 (visibility): a tool only reaches Claude when its app is
   * enabled *and* the account is connected *and* the scope was actually
   * granted. Anything else and he'd offer a capability that cannot run.
   */
  private connectedTools(): BetaToolUnion[] {
    const app = this.deps.settings.get().apps.find((a) => a.id === "calendar");
    if (!app?.enabled || !app.read) return [];
    const conns = this.deps.connections;
    if (!conns.isConnected("google")) return [];
    const allowed = new Set<string>();
    if (conns.hasScope("google", GOOGLE_SCOPES.calendarRead)) allowed.add("calendar_agenda");
    if (conns.hasScope("google", GOOGLE_SCOPES.mailRead)) {
      allowed.add("mail_search");
      // Bodies are a further opt-in on top of the mail scope: without the
      // toggle Claude never learns the tool exists, so he cannot offer to
      // read one and cannot be talked into trying.
      if (mailBodiesEnabled(app)) allowed.add("mail_read");
    }
    return CONNECTED_TOOLS.filter((t) => allowed.has(t.name)) as BetaToolUnion[];
  }

  /**
   * Layer 1 for the Filesystem app. Grants are the permission, so with none
   * configured Claude never learns the tools exist — and `fs_write` stays out
   * of the payload entirely until some folder is actually writable.
   */
  private filesystemTools(): BetaToolUnion[] {
    const app = this.deps.settings.get().apps.find((a) => a.id === "filesystem");
    if (!app?.enabled) return [];
    const grants = folderGrants(app);
    if (!grants.length) return [];
    const writable = grants.some((g) => g.write);
    return FILESYSTEM_TOOLS.filter((t) => writable || !FS_WRITE_TOOLS.has(t.name)) as BetaToolUnion[];
  }

  /** Only what the gate would actually allow, so the prompt cannot overpromise. */
  private sharedFolders(): { path: string; write: boolean }[] {
    const app = this.deps.settings.get().apps.find((a) => a.id === "filesystem");
    if (!app?.enabled) return [];
    return folderGrants(app).map((g) => ({ path: g.path, write: g.write }));
  }

  private buildParams(s: Settings, messages: BetaMessageParam[], mode: "spoken" | "analysis"): Anthropic.Beta.MessageCreateParamsStreaming {
    const model = MODELS[s.brain.model];
    const system = buildSystem(s, {
      now: new Date(),
      screenShareActive: this.deps.screenShareActive(),
      enabledApps: s.apps.filter((a) => a.enabled).map((a) => a.label),
      sharedFolders: this.sharedFolders(),
      listening: s.hud.listening,
    });

    const tools: BetaToolUnion[] = [...BUILTIN_TOOLS, ...this.connectedTools(), ...this.filesystemTools()];
    if (s.brain.webSearch) {
      tools.push({ type: model.webSearchToolType, name: "web_search", max_uses: 3 } as BetaToolUnion);
    }

    const thinkingOn = model.thinking === "adaptive" || model.thinking === "always";
    const spokenCap = s.brain.maxSpokenTokens + (thinkingOn ? 2500 : 0);
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: model.id,
      max_tokens: mode === "analysis" ? 6000 : spokenCap,
      system,
      messages,
      tools,
      stream: true,
    };
    if (model.supportsEffort) params.output_config = { effort: mode === "analysis" ? "high" : s.brain.effort };
    if (model.thinking === "adaptive") params.thinking = { type: "adaptive" };
    if (model.supportsFallbacks) {
      params.betas = ["server-side-fallback-2026-07-01"];
      (params as unknown as { fallbacks: string }).fallbacks = "default";
    }
    return params;
  }

  // -------------------------------------------------------------------------
  // Stream → activity + speech
  // -------------------------------------------------------------------------

  private onStreamEvent(event: StreamEvent, turn: Turn, partial: PartialAssembler): void {
    switch (event.type) {
      case "content_block_start": {
        const b = event.content_block;
        if (b.type === "thinking" || b.type === "redacted_thinking") this.activity({ kind: "thinking" });
        else if (b.type === "server_tool_use") this.activity({ kind: "researching" });
        else if (b.type === "web_search_tool_result") this.activity({ kind: "thinking" });
        break;
      }
      case "content_block_delta": {
        if (event.delta.type === "text_delta") {
          if (!turn.firstTextAt) turn.firstTextAt = Date.now();
          this.activity({ kind: "speaking" });
          turn.fullText += event.delta.text;
          this.deps.emit({ type: "assistant.delta", turnId: turn.id, text: event.delta.text });
          for (const chunk of turn.chunker.push(event.delta.text)) this.speak(turn, chunk);
        }
        break;
      }
      case "content_block_stop": {
        const q = partial.searchQueryFor(event.index);
        if (q) this.activity({ kind: "researching", detail: q });
        break;
      }
      default:
        break;
    }
  }

  /** Queue one chunk of speech. Audio is fetched immediately, emitted in order. */
  private speak(turn: Turn, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const seq = turn.seq++;
    const previousText = turn.spokenText;
    turn.spokenText = `${turn.spokenText} ${clean}`.trim();
    if (!turn.fullText.includes(clean)) turn.fullText = `${turn.fullText} ${clean}`.trim();

    const provider = this.deps.tts();
    const audioPromise =
      provider.name === "browser"
        ? Promise.resolve<Buffer | null>(null)
        : provider
            .synthesize({ text: clean, previousText, signal: turn.abort.signal }, this.deps.settings.get())
            .catch((err: unknown) => {
              if (!turn.abort.signal.aborted) this.deps.log("tts failed; falling back to browser voice", String(err));
              return null;
            });

    turn.speechQueue = turn.speechQueue.then(async () => {
      if (turn.abort.signal.aborted) return;
      const audio = await audioPromise;
      if (turn.abort.signal.aborted) return;
      if (!turn.firstAudioAt) turn.firstAudioAt = Date.now();
      this.deps.emit({
        type: "assistant.chunk",
        turnId: turn.id,
        seq,
        text: clean,
        audio: audio ? audio.toString("base64") : undefined,
        sampleRate: audio ? VOICE_SAMPLE_RATE : undefined,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  private beginTurn(replyTo: string): Turn {
    const turn: Turn = {
      id: randomUUID(),
      abort: new AbortController(),
      chunker: new SentenceChunker(),
      seq: 0,
      speechQueue: Promise.resolve(),
      spokenText: "",
      fullText: "",
      truncated: false,
      startedAt: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      modelId: "",
    };
    this.turn = turn;
    this.deps.emit({ type: "assistant.turn", turnId: turn.id, replyTo });
    return turn;
  }

  private async finishTurn(turn: Turn, extra: Record<string, unknown>): Promise<void> {
    if (!turn.abort.signal.aborted) {
      const rest = turn.chunker.flush();
      if (rest) this.speak(turn, rest);
    } else {
      turn.chunker.reset();
    }
    await turn.speechQueue.catch(() => undefined);

    const text = turn.fullText.trim();
    if (text) {
      const entry = this.deps.sessions.appendTranscript({ role: "assistant", text, truncated: turn.truncated || undefined });
      this.deps.emit({ type: "transcript.append", entry });
    }
    this.deps.emit({ type: "assistant.done", turnId: turn.id, truncated: turn.truncated, text });

    const model = turn.modelId ? Object.values(MODELS).find((m) => m.id === turn.modelId) : undefined;
    const costUsd = model
      ? (turn.usage.input * model.inputPerM + turn.usage.output * model.outputPerM + turn.usage.cacheRead * model.inputPerM * 0.1 + turn.usage.cacheWrite * model.inputPerM * 1.25) / 1_000_000
      : undefined;
    const metrics = {
      ttfbMs: turn.firstTextAt ? turn.firstTextAt - turn.startedAt : undefined,
      ttfwMs: turn.firstAudioAt ? turn.firstAudioAt - turn.startedAt : undefined,
      inputTokens: turn.usage.input || undefined,
      outputTokens: turn.usage.output || undefined,
      cacheReadTokens: turn.usage.cacheRead || undefined,
      costUsd,
      model: turn.modelId || undefined,
      truncated: turn.truncated,
      ...extra,
    };
    this.deps.sessions.metrics(turn.id, metrics);
    this.deps.emit({ type: "metrics", turnId: turn.id, ...stripUndefined(metrics) });

    if (this.turn === turn) this.turn = null;
    this.activity({ kind: "idle" });
  }

  /** §3.5 — never leave a tool_use without a tool_result. */
  private persistAborted(partial: PartialAssembler, messages: BetaMessageParam[]): void {
    const content = partial.completedContent();
    if (!content.length) return;
    const assistantMsg: BetaMessageParam = { role: "assistant", content };
    this.deps.sessions.appendMessage(assistantMsg, true);
    messages.push(assistantMsg);
    const orphans = content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
    if (orphans.length) {
      const results: BetaToolResultBlockParam[] = orphans.map((u) => ({
        type: "tool_result",
        tool_use_id: u.id,
        content: `Cancelled by ${this.deps.settings.get().personality.honorific}.`,
        is_error: true,
      }));
      const resultMsg: BetaMessageParam = { role: "user", content: results };
      this.deps.sessions.appendMessage(resultMsg, true);
      messages.push(resultMsg);
    }
  }

  private recordUsage(turn: Turn, message: Anthropic.Beta.BetaMessage): void {
    const u = message.usage;
    turn.usage.input += u.input_tokens ?? 0;
    turn.usage.output += u.output_tokens ?? 0;
    turn.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    turn.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }

  private handleError(turn: Turn, err: unknown): void {
    const H = this.deps.settings.get().personality.honorific;
    let spoken: string;
    let detail = String(err);
    if (err instanceof Anthropic.AuthenticationError) spoken = `My API key was rejected, ${H}. Please check ANTHROPIC_API_KEY.`;
    else if (err instanceof Anthropic.RateLimitError) spoken = `I'm being rate-limited, ${H}. Give me a moment and ask again.`;
    else if (err instanceof Anthropic.BadRequestError) spoken = `That request was rejected as malformed, ${H}. I've logged the details.`;
    else if (err instanceof Anthropic.APIConnectionError) spoken = `I can't reach my reasoning, ${H}. The network appears to be down.`;
    else if (err instanceof Anthropic.APIError) spoken = `The API returned an error ${err.status ?? ""}, ${H}.`;
    else spoken = `Something went wrong on my end, ${H}.`;
    if (err instanceof Anthropic.APIError) detail = `${err.status} ${err.message}`;
    this.deps.log("turn error", detail);
    this.deps.emit({ type: "error", message: detail, spoken });
    this.activity({ kind: "speaking" });
    this.speak(turn, spoken);
  }

  private activity(a: Activity): void {
    if (this.lastActivity.kind === a.kind && this.lastActivity.detail === a.detail) return;
    this.lastActivity = a;
    this.deps.emit({ type: "assistant.activity", activity: a });
  }
}

/** Reassembles content blocks from stream events so an aborted turn can be persisted correctly. */
class PartialAssembler {
  private blocks = new Map<number, { type: string; text: string; json: string; id?: string; name?: string; done: boolean }>();

  ingest(event: StreamEvent): void {
    if (event.type === "content_block_start") {
      const b = event.content_block;
      this.blocks.set(event.index, {
        type: b.type,
        text: "",
        json: "",
        id: "id" in b ? (b as { id?: string }).id : undefined,
        name: "name" in b ? (b as { name?: string }).name : undefined,
        done: false,
      });
    } else if (event.type === "content_block_delta") {
      const b = this.blocks.get(event.index);
      if (!b) return;
      if (event.delta.type === "text_delta") b.text += event.delta.text;
      else if (event.delta.type === "input_json_delta") b.json += event.delta.partial_json;
    } else if (event.type === "content_block_stop") {
      const b = this.blocks.get(event.index);
      if (b) b.done = true;
    }
  }

  searchQueryFor(index: number): string | undefined {
    const b = this.blocks.get(index);
    if (!b || b.type !== "server_tool_use") return undefined;
    try {
      const parsed = JSON.parse(b.json || "{}") as { query?: string };
      return parsed.query;
    } catch {
      return undefined;
    }
  }

  /** Only complete blocks; thinking blocks are dropped (they cannot be replayed without their signature). */
  completedContent(): BetaContentBlockParam[] {
    const out: BetaContentBlockParam[] = [];
    for (const [, b] of [...this.blocks.entries()].sort((a, c) => a[0] - c[0])) {
      if (b.type === "text" && b.text.trim()) out.push({ type: "text", text: b.text });
      if (b.type === "tool_use" && b.done && b.id && b.name) {
        let input: unknown = {};
        try {
          input = JSON.parse(b.json || "{}");
        } catch {
          continue;
        }
        out.push({ type: "tool_use", id: b.id, name: b.name, input });
      }
    }
    return out;
  }
}

function humanToolName(name: string): string {
  switch (name) {
    case "set_model":
      return "Switching model";
    case "set_personality":
      return "Adjusting personality";
    case "get_settings":
      return "Reading settings";
    case "get_time":
      return "Checking the time";
    case "take_screenshot":
      return "Viewing screen";
    default:
      return `Running ${name.replace(/_/g, " ")}`;
  }
}

function digest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex").slice(0, 16);
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
