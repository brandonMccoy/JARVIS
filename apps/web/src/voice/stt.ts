/**
 * Web Speech API recogniser wrapper (JOBS J2.8).
 * Chrome/Edge only. Deepgram adapter can replace this behind the same interface (J6.5).
 */
type SR = SpeechRecognition;

interface SRWindow extends Window {
  SpeechRecognition?: new () => SR;
  webkitSpeechRecognition?: new () => SR;
}

export function sttAvailable(): boolean {
  const w = window as SRWindow;
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

export interface RecognizerEvents {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onStart: () => void;
  onEnd: () => void;
  onError: (err: string) => void;
}

export class Recognizer {
  private rec: SR | null = null;
  private running = false;

  constructor(private events: RecognizerEvents) {}

  get active(): boolean {
    return this.running;
  }

  start(continuous: boolean, lang = navigator.language || "en-GB"): boolean {
    const w = window as SRWindow;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return false;
    this.stop();
    const rec = new Ctor();
    rec.continuous = continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = lang;
    rec.onstart = () => {
      this.running = true;
      this.events.onStart();
    };
    rec.onresult = (ev: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]!;
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) this.events.onFinal(text.trim());
        else interim += text;
      }
      if (interim.trim()) this.events.onInterim(interim.trim());
    };
    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      this.events.onError(ev.error);
    };
    rec.onend = () => {
      this.running = false;
      this.events.onEnd();
    };
    this.rec = rec;
    try {
      rec.start();
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    const r = this.rec;
    this.rec = null;
    if (!r) return;
    r.onend = null;
    r.onresult = null;
    r.onerror = null;
    try {
      r.abort();
    } catch {
      /* ignore */
    }
    this.running = false;
  }
}
