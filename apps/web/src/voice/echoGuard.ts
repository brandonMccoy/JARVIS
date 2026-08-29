/**
 * Textual echo suppression — stops J.A.R.V.I.S. hearing himself.
 *
 * Speakers bleed into the microphone, the recogniser transcribes it, and the
 * result arrives looking exactly like a user command. A timing-only gate
 * ("ignore results while he is speaking") cannot catch this: Chrome finalises
 * a result well after it captured the audio, so echo picked up mid-sentence is
 * usually delivered *after* playback ended — when the speaking flag is already
 * back to false and the follow-up window has just opened.
 *
 * So we filter on content instead of timing: record what actually reached the
 * speakers, then drop anything the mic hears that reads like a re-transcription
 * of it. This is the lightweight form of "textual echo cancellation" — using
 * the text we already have rather than an acoustic model.
 */

/**
 * How long spoken text stays eligible to match against a heard result. Echo is
 * delivered within a second or two of playback, so this only has to cover the
 * finalisation lag — keeping it short also stops his speech piling up into a
 * corpus big enough to collide with an unrelated command by chance.
 */
const RECENT_MS = 8_000;
/** How long after the last audio the speakers may still be bleeding in. */
const SETTLE_MS = 800;
/** Shortest contiguous word run that can stand as evidence of echo. */
const MIN_RUN = 4;
/** Share of the heard phrase that run must account for. */
const RUN_COVERAGE = 0.6;

interface Spoken {
  text: string;
  at: number;
}

let spoken: Spoken[] = [];
let lastSpokeAt = 0;

function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Length of the longest run of words appearing in the same order in both.
 * Echo is a re-transcription, so it shows up as one long contiguous run;
 * an unrelated command that merely reuses common words does not.
 */
function longestSharedRun(a: string[], b: string[]): number {
  let best = 0;
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0; // row[j - 1] from the previous iteration of i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      const run = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      row[j] = run;
      if (run > best) best = run;
      diag = above;
    }
  }
  return best;
}

/** Record a chunk at the moment it starts playing through the speakers. */
export function noteSpoken(text: string): void {
  const now = Date.now();
  lastSpokeAt = now;
  spoken.push({ text, at: now });
  spoken = spoken.filter((s) => now - s.at <= RECENT_MS);
}

/** Forget everything — a new session has no echo history worth keeping. */
export function clearSpoken(): void {
  spoken = [];
  lastSpokeAt = 0;
}

/** True while residual audio from the speakers may still reach the mic. */
export function withinSettleWindow(): boolean {
  return lastSpokeAt > 0 && Date.now() - lastSpokeAt < SETTLE_MS;
}

/**
 * Does `heard` look like J.A.R.V.I.S.'s own voice coming back?
 *
 * Deliberately conservative: ignoring the user is a far worse failure than
 * letting the occasional echo through, so evidence has to be a long run of his
 * own words in his own order — not merely reusing his vocabulary. A short
 * fragment carries too little signal to judge on content alone, so it only
 * counts while audio is actually playing or still settling (`hot`).
 */
export function isEcho(heard: string, hot: boolean): boolean {
  const now = Date.now();
  const recent = spoken.filter((s) => now - s.at <= RECENT_MS);
  if (!recent.length) return false;

  const spokenTokens = normalize(recent.map((s) => s.text).join(" "));
  const heardTokens = normalize(heard);
  if (!spokenTokens.length || !heardTokens.length) return false;

  const run = longestSharedRun(heardTokens, spokenTokens);
  if (run >= MIN_RUN && run >= heardTokens.length * RUN_COVERAGE) return true;
  return hot && heardTokens.length <= 2 && run === heardTokens.length;
}
