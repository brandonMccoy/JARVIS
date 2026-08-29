import { z } from "zod";
import { AppPermissionSchema, KNOWN_APPS } from "./apps.js";

export const ModelAliasSchema = z.enum(["opus", "fable", "sonnet", "haiku"]);
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const ListeningModeSchema = z.enum(["always", "single", "off"]);

const pct = z.number().int().min(0).max(100);

export const SettingsSchema = z.object({
  personality: z.object({
    /** Candor. 100 = unvarnished, 0 = maximally diplomatic. Voice-only; no UI. */
    honesty: pct.default(80),
    /** Wit. 100 = a quip every turn, 0 = none. Voice-only; no UI. */
    humor: pct.default(45),
    honorific: z.string().min(1).default("Sir"),
  }),
  brain: z.object({
    model: ModelAliasSchema.default("opus"),
    effort: EffortSchema.default("low"),
    webSearch: z.boolean().default(true),
    /** Spoken turns are capped so he cannot monologue. */
    maxSpokenTokens: z.number().int().min(64).max(4000).default(600),
  }),
  voice: z.object({
    ttsProvider: z.enum(["auto", "elevenlabs", "browser"]).default("auto"),
    /** ElevenLabs voice id. Empty = provider default. */
    voiceId: z.string().default(""),
    elevenLabsModel: z.string().default("eleven_turbo_v2_5"),
    stability: z.number().min(0).max(1).default(0.55),
    similarity: z.number().min(0).max(1).default(0.8),
    /** Browser fallback voice name substring, e.g. "Ryan" or "UK English Male". */
    browserVoice: z.string().default("en-GB"),
    wakeWordEngine: z.enum(["auto", "porcupine", "speech"]).default("auto"),
    wakeSensitivity: z.number().min(0).max(1).default(0.6),
    followUpWindowMs: z.number().int().min(0).max(30_000).default(8000),
    vadSilenceMs: z.number().int().min(200).max(3000).default(700),
    earcons: z.boolean().default(true),
    volume: z.number().min(0).max(1).default(0.9),
  }),
  screen: z.object({
    mode: z.enum(["off", "on-demand", "watch"]).default("on-demand"),
    intervalMs: z.number().int().min(1000).max(60_000).default(5000),
  }),
  hud: z.object({
    transcriptOpen: z.boolean().default(true),
    listening: ListeningModeSchema.default("off"),
  }),
  apps: z.array(AppPermissionSchema).default(KNOWN_APPS),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ModelAliasValue = z.infer<typeof ModelAliasSchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type ListeningMode = z.infer<typeof ListeningModeSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({
  personality: {},
  brain: {},
  voice: {},
  screen: {},
  hud: {},
});

/** Deep-partial patch. Each section may be partially supplied. */
export const SettingsPatchSchema = z.object({
  personality: SettingsSchema.shape.personality.partial().optional(),
  brain: SettingsSchema.shape.brain.partial().optional(),
  voice: SettingsSchema.shape.voice.partial().optional(),
  screen: SettingsSchema.shape.screen.partial().optional(),
  hud: SettingsSchema.shape.hud.partial().optional(),
  apps: z.array(AppPermissionSchema).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const merged = {
    personality: { ...current.personality, ...(patch.personality ?? {}) },
    brain: { ...current.brain, ...(patch.brain ?? {}) },
    voice: { ...current.voice, ...(patch.voice ?? {}) },
    screen: { ...current.screen, ...(patch.screen ?? {}) },
    hud: { ...current.hud, ...(patch.hud ?? {}) },
    apps: patch.apps ?? current.apps,
  };
  return SettingsSchema.parse(merged);
}
