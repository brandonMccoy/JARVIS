/**
 * Sentence chunker for streaming TTS (JOBS J2.12).
 * Decides when streamed text is safe to hand to the voice. Must not split on
 * "Dr.", "e.g.", "3.5", or inside code spans, and must not starve the first
 * chunk (speech should start early).
 */
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "no", "col", "gen", "lt", "sgt", "capt", "mt", "ft", "inc", "ltd", "co", "approx", "dept", "est", "fig", "vol", "a.m", "p.m", "u.s", "u.k",
]);

export interface ChunkerOptions {
  /** Emit even without punctuation once this many chars accumulate at a soft boundary. */
  softLimit?: number;
  /** Hard cap; split at whitespace regardless. */
  hardLimit?: number;
  /** Minimum chars for a chunk unless it ends the stream. */
  minChars?: number;
}

export class SentenceChunker {
  private buf = "";
  private inCode = false;
  private readonly soft: number;
  private readonly hard: number;
  private readonly min: number;

  constructor(opts: ChunkerOptions = {}) {
    this.soft = opts.softLimit ?? 160;
    this.hard = opts.hardLimit ?? 320;
    this.min = opts.minChars ?? 8;
  }

  /** Feed streamed text; returns zero or more complete chunks. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let chunk: string | null;
    while ((chunk = this.take()) !== null) out.push(chunk);
    return out;
  }

  /** Return whatever remains (end of stream). */
  flush(): string | null {
    const rest = cleanForSpeech(this.buf);
    this.buf = "";
    this.inCode = false;
    return rest.length ? rest : null;
  }

  reset(): void {
    this.buf = "";
    this.inCode = false;
  }

  private take(): string | null {
    const s = this.buf;
    if (!s.length) return null;

    // Newline is always a boundary (paragraph / list end).
    const nl = s.indexOf("\n");
    if (nl >= 0 && nl >= this.min) return this.emit(nl + 1);

    // Sentence terminators followed by whitespace.
    for (let i = 0; i < s.length - 1; i++) {
      const ch = s[i]!;
      if (ch === "`") this.inCode = !this.inCode;
      if (this.inCode) continue;
      if (ch !== "." && ch !== "!" && ch !== "?") continue;
      const next = s[i + 1]!;
      if (!/\s/.test(next)) continue; // "3.5", "e.g.x", URLs
      if (i + 1 < this.min) continue;
      if (ch === "." && this.isAbbreviation(s, i)) continue;
      // closing quotes/brackets after the terminator
      let end = i + 1;
      return this.emit(end);
    }

    // Soft boundary: comma / semicolon / colon / dash once we're long.
    if (s.length >= this.soft) {
      const idx = lastIndexOfAny(s, [", ", "; ", ": ", " — ", " - "], this.min);
      if (idx > 0) return this.emit(idx + 1);
    }
    if (s.length >= this.hard) {
      const sp = s.lastIndexOf(" ");
      if (sp > this.min) return this.emit(sp + 1);
    }
    return null;
  }

  private isAbbreviation(s: string, dotIndex: number): boolean {
    // word before the dot
    let j = dotIndex - 1;
    while (j >= 0 && /[a-z.]/i.test(s[j]!)) j--;
    const word = s.slice(j + 1, dotIndex).toLowerCase();
    if (!word) return false;
    if (ABBREVIATIONS.has(word)) return true;
    // Single capital letter initials: "J. Smith"
    if (word.length === 1 && /[a-z]/i.test(word)) return true;
    return false;
  }

  private emit(end: number): string | null {
    const raw = this.buf.slice(0, end);
    this.buf = this.buf.slice(end);
    const text = cleanForSpeech(raw);
    if (!text.length) return this.take();
    return text;
  }
}

function lastIndexOfAny(s: string, needles: string[], min: number): number {
  let best = -1;
  for (const n of needles) {
    const i = s.lastIndexOf(n);
    if (i > best && i >= min) best = i + n.length - 1;
  }
  return best;
}

/** Strip markdown residue so the voice doesn't read symbols aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").trim())
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}
