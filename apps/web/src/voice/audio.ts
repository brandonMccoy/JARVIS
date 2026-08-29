/**
 * Web Audio output graph (JOBS J2.1, J2.3, J2.4, J2.23).
 *   sources → master gain → analyser → destination
 * The orb reads getLevel() every frame; nothing here touches React.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let timeData: Float32Array<ArrayBuffer> | null = null;
let smoothed = 0;
/** Synthetic envelope used when the browser voice speaks (no analyser access). */
let syntheticUntil = 0;
let syntheticSeed = 0;

export function isAwake(): boolean {
  return ctx !== null && ctx.state === "running";
}

export async function unlockAudio(): Promise<void> {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    master = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    timeData = new Float32Array(analyser.fftSize);
    master.connect(analyser);
    analyser.connect(ctx.destination);
  }
  if (ctx.state !== "running") await ctx.resume();
}

export function setVolume(v: number): void {
  if (master) master.gain.value = Math.max(0, Math.min(1, v));
}

/** 0..1 loudness for the orb. Cheap; call per frame. */
export function getLevel(): number {
  let target = 0;
  if (analyser && timeData) {
    analyser.getFloatTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) sum += timeData[i]! * timeData[i]!;
    target = Math.min(1, Math.sqrt(sum / timeData.length) * 4);
  }
  const now = performance.now();
  if (now < syntheticUntil) {
    const t = now / 1000;
    const env = 0.35 + 0.22 * Math.sin(t * 9.3 + syntheticSeed) + 0.15 * Math.sin(t * 23.7) + 0.08 * Math.sin(t * 41.1);
    target = Math.max(target, Math.max(0, Math.min(1, env)));
  }
  smoothed += (target - smoothed) * (target > smoothed ? 0.5 : 0.15);
  return smoothed;
}

/** Drive the synthetic envelope while the browser voice speaks. */
export function pulseSynthetic(ms: number): void {
  syntheticSeed = Math.random() * 10;
  syntheticUntil = performance.now() + ms;
}
export function stopSynthetic(): void {
  syntheticUntil = 0;
}

// ---------------------------------------------------------------------------
// Ordered PCM player
// ---------------------------------------------------------------------------
interface QueueItem {
  turnId: string;
  seq: number;
  onStart: () => void;
  onEnd: () => void;
  source: AudioBufferSourceNode;
  startAt: number;
  duration: number;
  timer: number;
}

const active = new Map<number, QueueItem>();
let nextTime = 0;
let itemCounter = 0;
let drainListeners: (() => void)[] = [];

export function isPlaying(): boolean {
  return active.size > 0 || performance.now() < syntheticUntil;
}

export function onDrained(fn: () => void): void {
  if (!isPlaying()) fn();
  else drainListeners.push(fn);
}

function checkDrained(): void {
  if (active.size === 0) {
    const ls = drainListeners.splice(0);
    for (const l of ls) l();
  }
}

export function enqueuePcm(
  base64: string,
  sampleRate: number,
  meta: { turnId: string; seq: number; onStart: () => void; onEnd: () => void },
): void {
  if (!ctx || !master) return;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const samples = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  const buffer = ctx.createBuffer(1, Math.max(1, samples), sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) data[i] = view.getInt16(i * 2, true) / 32768;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(master);
  const now = ctx.currentTime;
  const startAt = Math.max(now + 0.03, nextTime);
  nextTime = startAt + buffer.duration;

  const id = itemCounter++;
  const item: QueueItem = {
    ...meta,
    source,
    startAt,
    duration: buffer.duration,
    timer: window.setTimeout(() => meta.onStart(), Math.max(0, (startAt - now) * 1000)),
  };
  active.set(id, item);
  source.onended = () => {
    if (!active.has(id)) return;
    active.delete(id);
    meta.onEnd();
    checkDrained();
  };
  source.start(startAt);
}

export function flushPlayback(): void {
  for (const [id, item] of active) {
    clearTimeout(item.timer);
    try {
      item.source.stop();
    } catch {
      /* already stopped */
    }
    active.delete(id);
  }
  nextTime = 0;
  stopSynthetic();
  checkDrained();
}

// ---------------------------------------------------------------------------
// Earcons (synthesised; no asset files)
// ---------------------------------------------------------------------------
export type Earcon = "wake" | "captured" | "denied" | "error" | "off";

export function earcon(kind: Earcon): void {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + 0.005;
  const play = (freq: number, at: number, dur: number, gain = 0.12, type: OscillatorType = "sine") => {
    const osc = ctx!.createOscillator();
    const g = ctx!.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g);
    g.connect(master!);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  };
  switch (kind) {
    case "wake":
      play(660, t0, 0.12);
      play(990, t0 + 0.09, 0.16);
      break;
    case "captured":
      play(1320, t0, 0.07, 0.08);
      break;
    case "denied":
      play(330, t0, 0.14, 0.1, "triangle");
      play(262, t0 + 0.13, 0.2, 0.1, "triangle");
      break;
    case "error":
      play(220, t0, 0.25, 0.1, "sawtooth");
      break;
    case "off":
      play(880, t0, 0.08, 0.06);
      play(560, t0 + 0.07, 0.12, 0.06);
      break;
  }
}
