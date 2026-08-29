import { z } from "zod";
import { ConnectionProviderSchema, ConnectionStateSchema } from "./connections.js";
import { SettingsSchema, SettingsPatchSchema, ListeningModeSchema } from "./settings.js";

/** What J.A.R.V.I.S. is doing right now (PLAN §6.2). Derived from real stream events, never guessed. */
export const ActivityKindSchema = z.enum([
  "idle",
  "listening",
  "thinking",
  "researching",
  "viewing_screen",
  "tool",
  "awaiting_confirmation",
  "speaking",
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivitySchema = z.object({
  kind: ActivityKindSchema,
  detail: z.string().optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

const ImageSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.string(), // base64
});
export type ImagePayload = z.infer<typeof ImageSchema>;

export const TranscriptRoleSchema = z.enum(["user", "assistant", "tool", "system"]);

export const TranscriptEntrySchema = z.object({
  id: z.string(),
  role: TranscriptRoleSchema,
  text: z.string(),
  ts: z.number(),
  truncated: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------
/**
 * A directory listing for the Filesystem folder picker. Directory names only —
 * never file names, never contents.
 */
export const FsListingSchema = z.object({
  /** Absolute and resolved. Absent at the top level, where `entries` are the roots. */
  path: z.string().optional(),
  /** Absent at a drive or filesystem root. */
  parent: z.string().optional(),
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
  error: z.string().optional(),
});

export type FsListing = z.infer<typeof FsListingSchema>;

export const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user.utterance"),
    text: z.string().min(1),
    source: z.enum(["voice", "text"]).default("text"),
    images: z.array(ImageSchema).optional(),
  }),
  z.object({ type: z.literal("user.interrupt") }),
  z.object({ type: z.literal("mode.set"), listening: ListeningModeSchema }),
  z.object({
    type: z.literal("screen.frame"),
    requestId: z.string().optional(),
    image: ImageSchema.optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("screen.status"), active: z.boolean(), label: z.string().optional() }),
  z.object({ type: z.literal("settings.patch"), patch: SettingsPatchSchema }),
  z.object({ type: z.literal("session.new") }),
  z.object({ type: z.literal("tool.confirm.reply"), id: z.string(), approved: z.boolean() }),
  /**
   * Directory listing for the folder picker. A browser tab cannot produce an
   * absolute path — `webkitdirectory` yields relative names — so core does the
   * walking and the user picks from what it reports. This is a *settings* path,
   * deliberately not bound by the granted folders: it is how folders get
   * granted in the first place. It returns directory names only, never file
   * contents.
   */
  z.object({ type: z.literal("fs.browse"), path: z.string().optional() }),
  z.object({ type: z.literal("audio.playback"), turnId: z.string(), seq: z.number(), state: z.enum(["started", "ended"]) }),
  z.object({ type: z.literal("client.listening"), active: z.boolean() }),
  /** Store the user's own OAuth client (docs/CONNECTIONS.md §1 — clients are BYO). */
  z.object({
    type: z.literal("connection.configure"),
    provider: ConnectionProviderSchema,
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  }),
  z.object({ type: z.literal("connection.start"), provider: ConnectionProviderSchema }),
  z.object({ type: z.literal("connection.disconnect"), provider: ConnectionProviderSchema }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    sessionId: z.string(),
    settings: SettingsSchema,
    history: z.array(TranscriptEntrySchema),
    capabilities: z.object({
      anthropic: z.boolean(),
      elevenlabs: z.boolean(),
      version: z.string(),
    }),
    connections: z.array(ConnectionStateSchema).default([]),
  }),
  z.object({ type: z.literal("assistant.turn"), turnId: z.string(), replyTo: z.string() }),
  z.object({ type: z.literal("assistant.delta"), turnId: z.string(), text: z.string() }),
  /** One spoken chunk. If `audio` is present it is base64 PCM s16le mono at `sampleRate`. Otherwise the client speaks `text` itself. */
  z.object({
    type: z.literal("assistant.chunk"),
    turnId: z.string(),
    seq: z.number(),
    text: z.string(),
    audio: z.string().optional(),
    sampleRate: z.number().optional(),
    last: z.boolean().optional(),
  }),
  z.object({ type: z.literal("assistant.done"), turnId: z.string(), truncated: z.boolean(), text: z.string() }),
  z.object({ type: z.literal("assistant.activity"), activity: ActivitySchema }),
  z.object({ type: z.literal("transcript.append"), entry: TranscriptEntrySchema }),
  z.object({ type: z.literal("tool.call"), turnId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool.result"), turnId: z.string(), name: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ type: z.literal("tool.confirm"), id: z.string(), app: z.string(), action: z.string() }),
  FsListingSchema.extend({ type: z.literal("fs.listing") }),
  z.object({ type: z.literal("screen.request"), requestId: z.string() }),
  z.object({ type: z.literal("settings.changed"), settings: SettingsSchema }),
  z.object({ type: z.literal("connection.changed"), connections: z.array(ConnectionStateSchema) }),
  /** Consent is in flight in the system browser; the HUD shows a waiting state. */
  z.object({ type: z.literal("connection.pending"), provider: ConnectionProviderSchema }),
  z.object({ type: z.literal("session.reset"), sessionId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string(), spoken: z.string().optional() }),
  z.object({
    type: z.literal("metrics"),
    turnId: z.string(),
    ttfbMs: z.number().optional(),
    ttfwMs: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    costUsd: z.number().optional(),
    model: z.string().optional(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export function parseClientEvent(raw: unknown): ClientEvent {
  return ClientEventSchema.parse(raw);
}
export function parseServerEvent(raw: unknown): ServerEvent {
  return ServerEventSchema.parse(raw);
}
