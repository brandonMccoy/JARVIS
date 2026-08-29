import type Anthropic from "@anthropic-ai/sdk";
import { GOOGLE_SCOPES, MODELS, isModelAlias, type ImagePayload, type Settings, type SettingsPatch } from "@jarvis/shared";
import * as google from "../connections/google.js";
import type { ConnectionStore } from "../connections/store.js";

type Tool = Anthropic.Beta.BetaTool;
type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam["content"];

/** What tool executors are allowed to touch. */
export interface ToolContext {
  settings: () => Settings;
  patchSettings: (patch: SettingsPatch) => Settings;
  requestScreenshot: () => Promise<ImagePayload | null>;
  screenShareActive: () => boolean;
  connections: ConnectionStore;
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
        // Ranges live in the description, not as `minimum`/`maximum`: the API
        // rejects those keywords on integer properties. The handlers clamp.
        honesty: { type: "integer", description: "Candor, 0-100. 100 = unvarnished, 0 = maximally diplomatic." },
        humor: { type: "integer", description: "Wit, 0-100. 100 = a quip every turn, 0 = none." },
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

/**
 * Calendar & Mail tools. Kept out of BUILTIN_TOOLS because they are only sent
 * to Claude when the app is enabled and the account is actually connected —
 * PLAN §7 layer 1 (visibility). Offering a tool that cannot work just invites
 * him to promise things he can't deliver.
 */
export const CONNECTED_TOOLS: Tool[] = [
  {
    name: "calendar_agenda",
    description:
      "Read Sir's Google Calendar over a window of days. Use for questions about what is on, what is next, or whether a day is free. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "How many days from today to cover, 1-14. 1 = today only." },
      },
      required: ["days"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "mail_search",
    description:
      "Search Sir's Gmail and return sender, subject, date and a snippet. Read-only — it cannot send or modify anything. Use Gmail query syntax, e.g. 'is:unread', 'from:someone@example.com', 'newer_than:2d'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A Gmail search query. Use 'is:unread' for unread mail." },
        limit: { type: "integer", description: "How many messages to return, 1-20. Defaults to 10." },
      },
      required: ["query"],
      additionalProperties: false,
    },
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
    case "calendar_agenda": {
      const days = clampInt(args.days, 1, 14, 1);
      return withConnection(ctx, GOOGLE_SCOPES.calendarRead, "calendar", async (token) => {
        const timeMin = new Date();
        const timeMax = new Date(timeMin.getTime() + days * 86_400_000);
        const events = await google.listEvents(token, { timeMin, timeMax });
        if (!events.length) {
          return { content: `Nothing scheduled in the next ${days === 1 ? "day" : `${days} days`}.`, summary: "Calendar: empty" };
        }
        const lines = events.map((e) => {
          const when = e.allDay
            ? `${formatDay(e.start)} (all day)`
            : `${formatDay(e.start)} ${formatTime(e.start)}${e.end ? `–${formatTime(e.end)}` : ""}`;
          return `${when} — ${e.summary}${e.location ? ` @ ${e.location}` : ""}`;
        });
        return { content: lines.join("\n"), summary: `Calendar: ${events.length} event${events.length === 1 ? "" : "s"}` };
      });
    }
    case "mail_search": {
      const query = String(args.query ?? "").trim();
      if (!query) return { content: "Provide a Gmail search query.", isError: true, summary: "mail_search: empty query" };
      const limit = clampInt(args.limit, 1, 20, 10);
      return withConnection(ctx, GOOGLE_SCOPES.mailRead, "mail", async (token) => {
        const messages = await google.listMessages(token, { query, maxResults: limit });
        if (!messages.length) return { content: `No messages match "${query}".`, summary: "Mail: no matches" };
        const lines = messages.map((m) => `${m.from} — ${m.subject}\n  ${m.snippet}`);
        return { content: lines.join("\n\n"), summary: `Mail: ${messages.length} message${messages.length === 1 ? "" : "s"}` };
      });
    }
    default:
      return { content: `Unknown tool ${name}.`, isError: true, summary: `Unknown tool ${name}` };
  }
}

/**
 * Wraps a connected-account call so every failure comes back as something he
 * can say out loud, rather than a stack trace or a silent empty result.
 */
async function withConnection(
  ctx: ToolContext,
  scope: string,
  label: string,
  run: (accessToken: string) => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  if (!ctx.connections.isConnected("google")) {
    return {
      content: `Google is not connected, so ${label} is unavailable. Sir can connect it under Settings → Apps.`,
      isError: true,
      summary: `${label}: not connected`,
    };
  }
  if (!ctx.connections.hasScope("google", scope)) {
    return {
      content: `The Google connection does not grant ${label} access. Sir needs to reconnect and approve it.`,
      isError: true,
      summary: `${label}: scope not granted`,
    };
  }
  try {
    const token = await ctx.connections.accessToken("google");
    return await run(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Could not reach ${label}: ${message}${
        message.includes("reconnect") || message.includes("expired") ? " Sir can reconnect under Settings → Apps." : ""
      }`,
      isError: true,
      summary: `${label} failed: ${message}`,
    };
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function formatDay(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
