import type { ServerEvent, TranscriptEntry } from "@jarvis/shared";
import { store } from "../state/store.ts";
import { socket } from "../ws/client.ts";
import { enqueuePcm, flushPlayback, isPlaying, onDrained, setVolume, earcon } from "../voice/audio.ts";
import { browserCancel, browserSpeak, browserSpeaking, onBrowserDrained } from "../voice/browserTts.ts";
import { clearSpoken, noteSpoken } from "../voice/echoGuard.ts";
import { listening } from "../voice/listening.ts";
import { captureFrame, screenActive } from "../screen/share.ts";

/**
 * Server event → store / audio (JOBS J2.14 transcript sync lives here).
 * The transcript reveals text as each chunk *starts playing*, never on token arrival.
 */
export function handleServerEvent(e: ServerEvent): void {
  const s = store.getState();
  switch (e.type) {
    case "hello": {
      s.set({
        sessionId: e.sessionId,
        settings: e.settings,
        capabilities: e.capabilities,
        transcript: e.history,
        connections: e.connections,
        live: null,
      });
      setVolume(e.settings.voice.volume);
      if (e.settings.hud.listening !== listening.current) void listening.setMode(e.settings.hud.listening);
      break;
    }
    case "settings.changed": {
      s.set({ settings: e.settings });
      setVolume(e.settings.voice.volume);
      if (e.settings.hud.listening !== listening.current) void listening.setMode(e.settings.hud.listening);
      break;
    }
    case "assistant.turn": {
      // A new turn always supersedes any audio still playing (barge-in by utterance).
      hardStopPlayback();
      s.set({ live: { turnId: e.turnId, streamed: "", revealed: "", done: false, pendingEntry: null, truncated: false } });
      break;
    }
    case "assistant.delta": {
      const live = store.getState().live;
      if (live && live.turnId === e.turnId) s.patchLive({ streamed: live.streamed + e.text });
      break;
    }
    case "assistant.chunk": {
      const live = store.getState().live;
      if (!live || live.turnId !== e.turnId) break;
      const reveal = () => {
        // Audio is now reaching the speakers — record it so the mic can tell
        // his voice from the user's (see voice/echoGuard.ts).
        noteSpoken(e.text);
        const l = store.getState().live;
        if (!l || l.turnId !== e.turnId) return;
        store.getState().patchLive({ revealed: `${l.revealed} ${e.text}`.trim() });
        if (store.getState().activity.kind !== "speaking") store.getState().setActivity({ kind: "speaking" });
      };
      const ended = () => {
        socket.send({ type: "audio.playback", turnId: e.turnId, seq: e.seq, state: "ended" });
        maybeFinalize(e.turnId);
      };
      if (e.audio && e.sampleRate) {
        enqueuePcm(e.audio, e.sampleRate, { turnId: e.turnId, seq: e.seq, onStart: reveal, onEnd: ended });
      } else {
        const st = store.getState().settings.voice;
        browserSpeak(e.text, { voiceHint: st.browserVoice, volume: st.volume, onStart: reveal, onEnd: ended });
      }
      break;
    }
    case "assistant.done": {
      const live = store.getState().live;
      if (live && live.turnId === e.turnId) {
        s.patchLive({ done: true, truncated: e.truncated });
        maybeFinalize(e.turnId);
      }
      break;
    }
    case "assistant.activity": {
      if (e.activity.kind === "idle" && (isPlaying() || browserSpeaking())) {
        // Core is done, but audio is still playing — stay "speaking" until it drains.
        break;
      }
      s.setActivity(e.activity);
      break;
    }
    case "transcript.append": {
      const live = store.getState().live;
      if (e.entry.role === "assistant" && live && !live.pendingEntry) {
        s.patchLive({ pendingEntry: e.entry });
        maybeFinalize(live.turnId);
      } else {
        s.appendTranscript(e.entry);
      }
      break;
    }
    case "tool.call":
    case "tool.result":
      break;
    case "tool.confirm":
      s.setActivity({ kind: "awaiting_confirmation" });
      break;
    case "screen.request": {
      const image = screenActive() ? captureFrame() : null;
      socket.send({ type: "screen.frame", requestId: e.requestId, image: image ?? undefined, error: image ? undefined : "no frame" });
      break;
    }
    case "fs.listing": {
      const { type: _type, ...listing } = e;
      s.set({ fsListing: listing });
      break;
    }
    case "connection.pending": {
      s.set({ connectionPending: e.provider });
      break;
    }
    case "connection.changed": {
      s.set({ connections: e.connections, connectionPending: null });
      break;
    }
    case "session.reset": {
      hardStopPlayback();
      clearSpoken();
      s.clearTranscript();
      s.set({ sessionId: e.sessionId, sessionCostUsd: 0 });
      break;
    }
    case "error": {
      earcon("error");
      s.appendTranscript({ id: `err-${Date.now()}`, role: "system", text: e.message, ts: Date.now() });
      break;
    }
    case "metrics": {
      const { type: _t, turnId: _id, ...m } = e;
      s.set({ lastMetrics: m, sessionCostUsd: store.getState().sessionCostUsd + (m.costUsd ?? 0) });
      break;
    }
    default:
      break;
  }
}

/** When core is done AND playback has drained, commit the live turn to the transcript. */
function maybeFinalize(turnId: string): void {
  const live = store.getState().live;
  if (!live || live.turnId !== turnId || !live.done) return;
  const commit = () => {
    const l = store.getState().live;
    if (!l || l.turnId !== turnId) return;
    const entry: TranscriptEntry | null = l.pendingEntry
      ? { ...l.pendingEntry, text: l.truncated && l.revealed ? l.revealed : l.pendingEntry.text, truncated: l.truncated || undefined }
      : null;
    store.getState().set({ live: null });
    if (entry) store.getState().appendTranscript(entry);
    if (store.getState().activity.kind === "speaking") store.getState().setActivity({ kind: "idle" });
    listening.openFollowUpWindow();
  };
  if (isPlaying()) onDrained(() => (browserSpeaking() ? onBrowserDrained(commit) : commit()));
  else if (browserSpeaking()) onBrowserDrained(commit);
  else commit();
}

/** Local interrupt: stop audio now, tell core, and truncate the live turn. */
export function interrupt(): void {
  socket.send({ type: "user.interrupt" });
  const live = store.getState().live;
  hardStopPlayback();
  if (live) {
    store.getState().patchLive({ truncated: true, done: true });
    maybeFinalize(live.turnId);
  }
  if (store.getState().activity.kind !== "idle") store.getState().setActivity({ kind: "idle" });
}

function hardStopPlayback(): void {
  flushPlayback();
  browserCancel();
}
