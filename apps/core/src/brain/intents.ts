import { MODELS, findSpokenModel, type ModelAlias, type Settings, type SettingsPatch } from "@jarvis/shared";

/**
 * Intent fast-path (JOBS J2.22, Improvement #2).
 * Deterministic matches answered in < 100 ms with no Claude round-trip.
 * Anything ambiguous falls through (returns null) so Claude handles it.
 */
export type Intent =
  | { kind: "stop" }
  | { kind: "are_you_there"; reply: string }
  | { kind: "time"; reply: string }
  | { kind: "new_session"; reply: string }
  | { kind: "switch_model"; alias: ModelAlias; reply: string; patch: SettingsPatch }
  | { kind: "set_personality"; reply: string; patch: SettingsPatch }
  | { kind: "read_settings"; reply: string };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  half: 50, max: 100, maximum: 100, full: 100, min: 0, minimum: 0, off: 0, none: 0,
};

/** Parse "seventy five", "75", "75%", "a hundred", "half" → 0..100, else undefined. */
export function parsePercent(text: string): number | undefined {
  const digits = text.match(/(\d{1,3})\s*(%|percent)?/);
  if (digits) {
    const n = Number(digits[1]);
    if (n >= 0 && n <= 100) return n;
  }
  const words = text.toLowerCase().replace(/-/g, " ").split(/\s+/);
  let total = 0;
  let found = false;
  for (const w of words) {
    const v = NUMBER_WORDS[w];
    if (v === undefined) continue;
    found = true;
    if (v === 100 && total > 0) total = total * 100;
    else total += v;
  }
  if (!found) return undefined;
  return Math.max(0, Math.min(100, total));
}

const strip = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(hey|ok|okay|hi|yo)?[,\s]*jarvis[,\s]*/i, "")
    .replace(/[^a-z0-9%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function matchIntent(rawText: string, settings: Settings): Intent | null {
  const t = strip(rawText);
  const H = settings.personality.honorific;
  if (!t) return null;

  // stop / quiet
  if (/^(stop|shut up|quiet|silence|be quiet|enough|hush|that s enough|cancel)( now| please| jarvis)*$/.test(t)) {
    return { kind: "stop" };
  }

  if (/^(are you (there|awake|listening|online)|you there|hello|hi|good (morning|afternoon|evening))( jarvis)?( sir)?$/.test(t)) {
    const hour = new Date().getHours();
    const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    return { kind: "are_you_there", reply: `${greet}, ${H}. I'm here.` };
  }

  if (/^(what( is|s) the time|what time is it|time( please)?|tell me the time|what s the time)( right now| now| please)*$/.test(t)) {
    const now = new Date();
    const time = now.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/^0/, "");
    return { kind: "time", reply: `It's ${time}, ${H}.` };
  }

  if (/^(new session|start (a )?new session|clear (the )?(session|conversation|history)|forget (this|the) conversation|reset)( please)?$/.test(t)) {
    return { kind: "new_session", reply: `Very good, ${H}. Clean slate.` };
  }

  // model switching: "switch to sonnet", "use haiku", "go back to opus"
  if (/^(switch|change|swap|go( back)?|move|use|run)( over)?( to| on)? /.test(t) || /^(switch|use) /.test(t)) {
    const alias = findSpokenModel(t);
    if (alias && /(model|brain|switch|use|swap|change|go)/.test(t)) {
      if (alias === settings.brain.model) {
        return { kind: "switch_model", alias, reply: `I'm already running on ${MODELS[alias].label}, ${H}.`, patch: {} };
      }
      const line = alias === "haiku" ? "Switching to Haiku. Quicker, if a little less contemplative." : `Switching to ${MODELS[alias].label}, ${H}.`;
      return { kind: "switch_model", alias, reply: line, patch: { brain: { model: alias } } };
    }
  }

  // personality: "humor to seventy", "set honesty 90", "dial the wit up to eighty", "candor to full"
  const pm = t.match(/^(?:set |dial |turn |put )?(?:the |your )?(humou?r|wit|jokes?|honesty|candou?r|bluntness)\b.*?(?:to|at|up to|down to)\s+(.+)$/);
  if (pm) {
    const field = /humou?r|wit|joke/.test(pm[1]!) ? "humor" : "honesty";
    const value = parsePercent(pm[2]!);
    if (value !== undefined) {
      const reply =
        field === "humor"
          ? value >= 80
            ? `${value} percent, ${H}. I shall endeavour to be insufferable.`
            : value <= 20
              ? `Humour at ${value} percent. Strictly business, then.`
              : `Humour set to ${value} percent, ${H}.`
          : value >= 80
            ? `Candor at ${value} percent. I'll spare you the diplomacy, ${H}.`
            : `Candor set to ${value} percent, ${H}.`;
      return { kind: "set_personality", reply, patch: { personality: { [field]: value } } };
    }
  }

  if (/^(what are your settings|read (me |back )?(your|the) settings|what( is|s) your (humou?r|candou?r|honesty)( setting| level)?|settings)( please)?$/.test(t)) {
    const p = settings.personality;
    return {
      kind: "read_settings",
      reply: `Candor ${p.honesty} percent, humour ${p.humor} percent, running on ${MODELS[settings.brain.model].label}, ${H}.`,
    };
  }

  return null;
}
