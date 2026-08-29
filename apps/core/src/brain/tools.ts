import type Anthropic from "@anthropic-ai/sdk";
import { MODELS, isModelAlias, type ImagePayload, type Settings, type SettingsPatch } from "@jarvis/shared";

type Tool = Anthropic.Beta.BetaTool;
type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam["content"];

/** What tool executors are allowed to touch. */
export interface ToolContext {
  settings: () => Settings;
  patchSettings: (patch: SettingsPatch) => Settings;
  requestScreenshot: () => Promise<ImagePayload | null>;
  screenShareActive: () => boolean;
}

export interface ToolOutcome {
  content: ToolResultContent;
  isError?: boolean;
  /** One-line summary for the transcript / audit log. */
  summary: string;
  /** Some tools change what the next request must look like. */
  modelChanged?: boolean;
}

export const BUILTIN_TOOLS: Tool[] = [
  {
    name: "set_model",
    description:
      "Switch the reasoning model J.A.R.V.I.S. runs on. Use when Sir asks to switch, change, or use a different model (Opus, Fable, Sonnet, Haiku). Takes effect on the next turn.",
    input_schema: {
      type: "object",
      properties: {
        alias: { type: "string", enum: ["opus", "fable", "sonnet", "haiku"], description: "Which model to switch to." },
      },
      required: ["alias"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "set_personality",
    description:
      "Adjust J.A.R.V.I.S.'s candor (honesty) and/or wit (humor) as percentages 0-100. Only call when Sir explicitly asks to change them. Omit a field to leave it unchanged.",
    input_schema: {
      type: "object",
      properties: {
        honesty: { type: "integer", minimum: 0, maximum: 100, description: "Candor. 100 = unvarnished, 0 = maximally diplomatic." },
        humor: { type: "integer", minimum: 0, maximum: 100, description: "Wit. 100 = a quip every turn, 0 = none." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_settings",
    description: "Read J.A.R.V.I.S.'s current candor, wit, honorific, active model, and effort level.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "get_time",
    description: "Get the current local date and time with timezone.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "take_screenshot",
    description:
      "Capture the current frame of Sir's active screen share so you can see it. Only works while a screen share is active; if none is, the result says so and you should ask Sir to press View Screen. Use when asked what is on the screen, to read something, or to analyse code/errors on screen.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "set_model": {
      const alias = String(args.alias ?? "");
      if (!isModelAlias(alias)) return { content: `Unknown model "${alias}".`, isError: true, summary: `set_model rejected ${alias}` };
      const before = ctx.settings().brain.model;
      ctx.patchSettings({ brain: { model: alias } });
      return {
        content: `Model switched from ${MODELS[before].label} to ${MODELS[alias].label}. It is active from the next turn.`,
        summary: `Switched model to ${MODELS[alias].label}`,
        modelChanged: before !== alias,
      };
    }
    case "set_personality": {
      const patch: NonNullable<SettingsPatch["personality"]> = {};
      if (typeof args.honesty === "number") patch.honesty = clamp(args.honesty);
      if (typeof args.humor === "number") patch.humor = clamp(args.humor);
      if (patch.honesty === undefined && patch.humor === undefined)
        return { content: "Nothing to change; provide honesty and/or humor.", isError: true, summary: "set_personality: no fields" };
      const s = ctx.patchSettings({ personality: patch });
      return {
        content: `Candor is now ${s.personality.honesty}%, wit ${s.personality.humor}%.`,
        summary: `Personality → candor ${s.personality.honesty}, wit ${s.personality.humor}`,
      };
    }
    case "get_settings": {
      const s = ctx.settings();
      return {
        content: JSON.stringify({
          honesty: s.personality.honesty,
          humor: s.personality.humor,
          honorific: s.personality.honorific,
          model: MODELS[s.brain.model].label,
          effort: s.brain.effort,
          webSearch: s.brain.webSearch,
        }),
        summary: "Read settings",
      };
    }
    case "get_time": {
      const now = new Date();
      return {
        content: `${now.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        summary: "Read the time",
      };
    }
    case "take_screenshot": {
      if (!ctx.screenShareActive()) {
        return {
          content: "No active screen share. Sir must press the View Screen control before you can look.",
          isError: true,
          summary: "Screenshot requested with no active share",
        };
      }
      const img = await ctx.requestScreenshot();
      if (!img) return { content: "Screen capture timed out.", isError: true, summary: "Screenshot timed out" };
      return {
        content: [
          { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
          { type: "text", text: "Current frame of the screen share." },
        ],
        summary: "Looked at the screen",
      };
    }
    default:
      return { content: `Unknown tool ${name}.`, isError: true, summary: `Unknown tool ${name}` };
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
