import { create } from "zustand";
import {
  DEFAULT_CONNECTIONS,
  DEFAULT_SETTINGS,
  type Activity,
  type ConnectionState,
  type ListeningMode,
  type Settings,
  type TranscriptEntry,
} from "@jarvis/shared";

export type Connection = "connecting" | "open" | "closed";

export interface LiveTurn {
  turnId: string;
  /** Text streamed from Claude so far (not necessarily spoken yet). */
  streamed: string;
  /** Text revealed in the drawer — advances as each chunk starts playing. */
  revealed: string;
  /** Core has finished producing chunks. */
  done: boolean;
  /** The persisted assistant entry, held until playback drains. */
  pendingEntry: TranscriptEntry | null;
  truncated: boolean;
}

export interface Metrics {
  ttfbMs?: number;
  ttfwMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  model?: string;
}

interface State {
  connection: Connection;
  sessionId: string;
  settings: Settings;
  capabilities: { anthropic: boolean; elevenlabs: boolean; version: string };
  /** Account connections — status only; tokens never leave core. */
  connections: ConnectionState[];
  /** Provider whose consent is currently open in the system browser. */
  connectionPending: string | null;
  activity: Activity;
  /** Client-side listening state (mic open) — shown as "Listening…" locally. */
  micOpen: boolean;
  interim: string;
  transcript: TranscriptEntry[];
  live: LiveTurn | null;
  screen: { active: boolean; label: string };
  view: "main" | "settings";
  awake: boolean;
  lastMetrics: Metrics | null;
  sessionCostUsd: number;
  wakeEngine: "porcupine" | "speech" | "none";

  set: (patch: Partial<State>) => void;
  setActivity: (a: Activity) => void;
  appendTranscript: (e: TranscriptEntry) => void;
  clearTranscript: () => void;
  patchLive: (patch: Partial<LiveTurn>) => void;
  listeningMode: () => ListeningMode;
}

export const useStore = create<State>((set, get) => ({
  connection: "connecting",
  sessionId: "",
  settings: DEFAULT_SETTINGS,
  capabilities: { anthropic: false, elevenlabs: false, version: "" },
  connections: DEFAULT_CONNECTIONS,
  connectionPending: null,
  activity: { kind: "idle" },
  micOpen: false,
  interim: "",
  transcript: [],
  live: null,
  screen: { active: false, label: "" },
  view: "main",
  awake: false,
  lastMetrics: null,
  sessionCostUsd: 0,
  wakeEngine: "none",

  set: (patch) => set(patch),
  setActivity: (activity) => set({ activity }),
  appendTranscript: (e) => set((s) => ({ transcript: [...s.transcript.filter((x) => x.id !== e.id), e].slice(-400) })),
  clearTranscript: () => set({ transcript: [], live: null }),
  patchLive: (patch) => set((s) => (s.live ? { live: { ...s.live, ...patch } } : {})),
  listeningMode: () => get().settings.hud.listening,
}));

export const store = useStore;
