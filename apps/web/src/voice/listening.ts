import type { ListeningMode } from "@jarvis/shared";
import { store } from "../state/store.ts";
import { socket } from "../ws/client.ts";
import { earcon, isPlaying } from "./audio.ts";
import { browserSpeaking } from "./browserTts.ts";
import { isEcho, withinSettleWindow } from "./echoGuard.ts";
import { porcupineConfigured, startPorcupine, stopPorcupine } from "./porcupine.ts";
import { Recognizer, sttAvailable } from "./stt.ts";

/**
 * Listening controller (JOBS J2.5, J2.7, J2.9, J2.10).
 *
 * Modes:
 *   off     — mic released.
 *   single  — one utterance, no wake word.
 *   always  — wake word armed. With a Picovoice key the wake word runs
 *             locally and the recogniser only opens after it fires; without
 *             one, a continuous recogniser watches for "hey jarvis" itself.
 *
 * Self-hearing gate: a stop word always interrupts, and anything that reads
 * like his own voice returning through the speakers is dropped on content
 * (see echoGuard.ts) — including when it carries the wake word.
 */
const WAKE = /\b(?:hey|ok|okay|hi|yo)?[,\s]*jarvis\b[,.!?]*/i;
const STOP_WORDS = /^(stop|wait|no wait|hold on|shut up|quiet|enough|cancel)\b/i;

class ListeningController {
  private mode: ListeningMode = "off";
  private rec = new Recognizer({
    onInterim: (t) => this.onInterim(t),
    onFinal: (t) => this.onFinal(t),
    onStart: () => this.setMic(true),
    onEnd: () => this.onRecEnd(),
    onError: (e) => this.onError(e),
  });
  private usingPorcupine = false;
  private captureNext = false;
  private captureTimer = 0;
  private restartTimer = 0;
  private singleActive = false;
  /** Guards against a single utterance producing two `onFinal` calls (Chrome sometimes
   *  reports more than one final segment for one result event) — reset whenever a new
   *  capture window opens, checked at the top of submit() so only the first one lands. */
  private submitted = false;

  get current(): ListeningMode {
    return this.mode;
  }

  async setMode(mode: ListeningMode): Promise<void> {
    if (mode === this.mode) return;
    await this.teardown();
    this.mode = mode;
    socket.send({ type: "mode.set", listening: mode });
    if (mode === "always") await this.armAlways();
    if (mode === "off") earcon("off");
  }

  /** Momentary "listen once". Works in any mode. */
  listenOnce(): void {
    if (!sttAvailable()) {
      this.systemLine("Speech recognition isn't available in this browser. Chrome or Edge is required.");
      return;
    }
    if (this.singleActive) return;
    this.singleActive = true;
    this.captureNext = true;
    this.submitted = false;
    earcon("wake");
    if (this.mode === "always" && !this.usingPorcupine && this.rec.active) return; // continuous recogniser already open; next final is captured
    this.rec.start(false);
  }

  /** Called after each assistant turn ends: keep the door open briefly. */
  openFollowUpWindow(): void {
    this.submitted = false; // the previous turn is over — a new one may submit
    if (this.mode !== "always") return;
    const ms = store.getState().settings.voice.followUpWindowMs;
    if (ms <= 0) return;
    this.captureNext = true;
    clearTimeout(this.captureTimer);
    this.captureTimer = window.setTimeout(() => {
      this.captureNext = false;
      store.getState().set({ interim: "" });
    }, ms);
    if (this.usingPorcupine && !this.rec.active) this.rec.start(false);
  }

  private async armAlways(): Promise<void> {
    const engine = store.getState().settings.voice.wakeWordEngine;
    const wantPorcupine = engine !== "speech" && porcupineConfigured();
    if (wantPorcupine) {
      const ok = await startPorcupine(store.getState().settings.voice.wakeSensitivity, () => this.onWakeWord(""));
      this.usingPorcupine = ok;
      store.getState().set({ wakeEngine: ok ? "porcupine" : "speech" });
      if (ok) return;
    } else {
      store.getState().set({ wakeEngine: "speech" });
    }
    if (!sttAvailable()) {
      this.systemLine("Always-listening needs Chrome or Edge (Web Speech API), or a Picovoice key.");
      this.mode = "off";
      return;
    }
    this.rec.start(true);
  }

  private async teardown(): Promise<void> {
    clearTimeout(this.captureTimer);
    clearTimeout(this.restartTimer);
    this.captureNext = false;
    this.singleActive = false;
    this.rec.stop();
    if (this.usingPorcupine) await stopPorcupine();
    this.usingPorcupine = false;
    this.setMic(false);
    store.getState().set({ interim: "", wakeEngine: "none" });
  }

  private onWakeWord(remainder: string): void {
    earcon("wake");
    if (assistantSpeaking()) socket.send({ type: "user.interrupt" });
    const rest = remainder.trim();
    if (rest) {
      this.submitted = false;
      this.submit(rest);
      return;
    }
    this.captureNext = true;
    this.submitted = false;
    clearTimeout(this.captureTimer);
    this.captureTimer = window.setTimeout(() => (this.captureNext = false), 8000);
    if (this.usingPorcupine) this.rec.start(false);
  }

  private onInterim(text: string): void {
    // Don't paint his own voice into the interim line either.
    if (isEcho(text, assistantSpeaking() || withinSettleWindow())) return;
    if (this.mode === "always" && !this.usingPorcupine && !this.captureNext) {
      const m = text.match(WAKE);
      if (!m) return;
      store.getState().set({ interim: text.slice(m.index! + m[0].length).trim() });
      return;
    }
    if (this.captureNext || this.singleActive) store.getState().set({ interim: text });
  }

  private onFinal(text: string): void {
    if (!text) return;
    const speaking = assistantSpeaking();

    // Barge-in wins over everything: never filter the user telling him to stop.
    if (speaking && STOP_WORDS.test(text.trim())) {
      socket.send({ type: "user.interrupt" });
      earcon("captured");
      return;
    }

    // Self-hearing gate. Content-based, and checked before the wake word so his
    // own voice can't trigger a turn by saying his own name — which the previous
    // ordering allowed, and which a timing-only check misses anyway because a
    // result captured mid-playback is usually delivered after playback ended.
    if (isEcho(text, speaking || withinSettleWindow())) return;

    if (this.mode === "always" && !this.usingPorcupine) {
      const m = text.match(WAKE);
      if (m) {
        const remainder = text.slice(m.index! + m[0].length);
        this.onWakeWord(remainder);
        return;
      }
      if (speaking) return; // still his own audio, just not a stop word
      if (!this.captureNext) return;
      this.submit(text);
      return;
    }

    // single mode or porcupine-armed capture
    if (speaking && !this.captureNext && !this.singleActive) return;
    this.submit(text);
  }

  private submit(text: string): void {
    if (this.submitted) return; // a duplicate final result for the same utterance
    this.submitted = true;
    clearTimeout(this.captureTimer);
    this.captureNext = false;
    this.singleActive = false;
    store.getState().set({ interim: "" });
    earcon("captured");
    socket.send({ type: "user.utterance", text, source: "voice" });
    if (this.usingPorcupine || this.mode !== "always") this.rec.stop();
    this.setMic(false);
  }

  private onRecEnd(): void {
    this.setMic(false);
    this.singleActive = false;
    // Chrome ends continuous recognition after silence; re-arm.
    if (this.mode === "always" && !this.usingPorcupine) {
      clearTimeout(this.restartTimer);
      this.restartTimer = window.setTimeout(() => {
        if (this.mode === "always" && !this.usingPorcupine) this.rec.start(true);
      }, 250);
    }
  }

  private onError(err: string): void {
    this.setMic(false);
    if (err === "not-allowed" || err === "service-not-allowed") {
      this.systemLine("Microphone access was denied. Allow the microphone in the browser's site settings, then try again. Typing still works.");
      this.mode = "off";
      store.getState().set({ wakeEngine: "none" });
      socket.send({ type: "mode.set", listening: "off" });
      earcon("denied");
    } else if (err === "network") {
      this.systemLine("Speech recognition lost its network connection; retrying.");
    }
  }

  private setMic(open: boolean): void {
    if (store.getState().micOpen !== open) store.getState().set({ micOpen: open });
    socket.send({ type: "client.listening", active: open });
  }

  private systemLine(text: string): void {
    store.getState().appendTranscript({ id: `sys-${Date.now()}`, role: "system", text, ts: Date.now() });
  }
}

export function assistantSpeaking(): boolean {
  return isPlaying() || browserSpeaking() || store.getState().activity.kind === "speaking";
}

export const listening = new ListeningController();
