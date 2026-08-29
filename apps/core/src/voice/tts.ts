import { VOICE_SAMPLE_RATE } from "../config.js";
import type { Settings } from "@jarvis/shared";

/**
 * TTS adapter (JOBS J2.11).
 *
 * `synthesize` returns PCM s16le mono at VOICE_SAMPLE_RATE for one chunk of
 * text, or `null` when the provider cannot produce audio (browser mode: the
 * web app speaks the text itself with speechSynthesis).
 *
 * ElevenLabs is called per chunk over the HTTP stream endpoint with
 * `previous_text` for prosody continuity. Chunk requests are started as soon
 * as the chunk exists and awaited in order, so audio for chunk N+1 is usually
 * ready before chunk N finishes playing.
 */
export interface TtsRequest {
  text: string;
  previousText?: string;
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly name: "elevenlabs" | "browser";
  synthesize(req: TtsRequest, settings: Settings): Promise<Buffer | null>;
}

export class BrowserTts implements TtsProvider {
  readonly name = "browser" as const;
  async synthesize(): Promise<Buffer | null> {
    return null;
  }
}

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // "George" — warm British male, present on all ElevenLabs accounts

export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs" as const;
  constructor(private apiKey: string) {}

  async synthesize(req: TtsRequest, settings: Settings): Promise<Buffer | null> {
    const voiceId = settings.voice.voiceId.trim() || DEFAULT_VOICE_ID;
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
    url.searchParams.set("output_format", `pcm_${VOICE_SAMPLE_RATE}`);
    url.searchParams.set("optimize_streaming_latency", "3");

    const body: Record<string, unknown> = {
      text: req.text,
      model_id: settings.voice.elevenLabsModel,
      voice_settings: {
        stability: settings.voice.stability,
        similarity_boost: settings.voice.similarity,
        style: 0.15,
        use_speaker_boost: true,
      },
    };
    if (req.previousText) body.previous_text = req.previousText.slice(-300);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "content-type": "application/json",
        accept: "audio/pcm",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
}

export function chooseTts(settings: Settings, elevenKey: string): TtsProvider {
  const want = settings.voice.ttsProvider;
  if (want === "browser") return new BrowserTts();
  if (want === "elevenlabs" || want === "auto") {
    if (elevenKey) return new ElevenLabsTts(elevenKey);
  }
  return new BrowserTts();
}
