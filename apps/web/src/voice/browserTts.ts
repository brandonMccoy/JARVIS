import { pulseSynthetic, stopSynthetic } from "./audio.ts";

/**
 * Keyless voice: the browser's own speechSynthesis with a British voice.
 * Used when core has no ElevenLabs key (chunks arrive without audio).
 */
let voiceCache: SpeechSynthesisVoice[] = [];
let queueDepth = 0;
let drainListeners: (() => void)[] = [];

function loadVoices(): SpeechSynthesisVoice[] {
  if (!("speechSynthesis" in window)) return [];
  voiceCache = speechSynthesis.getVoices();
  return voiceCache;
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = () => loadVoices();
}

export function pickVoice(hint: string): SpeechSynthesisVoice | undefined {
  const voices = voiceCache.length ? voiceCache : loadVoices();
  const h = hint.toLowerCase();
  const byHint = voices.find((v) => v.name.toLowerCase().includes(h) && h.length > 2);
  if (byHint) return byHint;
  const prefs = ["google uk english male", "microsoft ryan", "microsoft george", "daniel", "microsoft thomas", "arthur"];
  for (const p of prefs) {
    const v = voices.find((x) => x.name.toLowerCase().includes(p));
    if (v) return v;
  }
  return voices.find((v) => v.lang.toLowerCase().startsWith("en-gb")) ?? voices.find((v) => v.lang.toLowerCase().startsWith("en"));
}

export function browserSpeaking(): boolean {
  return queueDepth > 0;
}

export function onBrowserDrained(fn: () => void): void {
  if (queueDepth === 0) fn();
  else drainListeners.push(fn);
}

export function browserSpeak(text: string, opts: { voiceHint: string; volume: number; onStart: () => void; onEnd: () => void }): void {
  if (!("speechSynthesis" in window)) {
    opts.onStart();
    opts.onEnd();
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(opts.voiceHint);
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? "en-GB";
  u.rate = 1.0;
  u.pitch = 0.9;
  u.volume = opts.volume;
  queueDepth++;
  const estimateMs = Math.max(600, text.length * 55);
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    queueDepth = Math.max(0, queueDepth - 1);
    if (queueDepth === 0) {
      stopSynthetic();
      const ls = drainListeners.splice(0);
      for (const l of ls) l();
    }
    opts.onEnd();
  };
  u.onstart = () => {
    pulseSynthetic(estimateMs + 400);
    opts.onStart();
  };
  u.onboundary = () => pulseSynthetic(1200);
  u.onend = finish;
  u.onerror = finish;
  speechSynthesis.speak(u);
}

export function browserCancel(): void {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  queueDepth = 0;
  stopSynthetic();
  const ls = drainListeners.splice(0);
  for (const l of ls) l();
}
