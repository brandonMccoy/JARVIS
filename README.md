# J.A.R.V.I.S.

A voice-first assistant with a Claude brain, a 3D neural-network orb for a face, and a Stark-household personality. He addresses you as *Sir*.

```
apps/web    React 19 + Vite + React Three Fiber — the orb, voice pipeline, HUD, settings
apps/core   Node 22 + Fastify — Anthropic SDK, persona, intents, TTS, SQLite, WebSocket hub
packages/shared   zod schemas shared by both: settings, model capabilities, WS protocol
docs/       PLAN.md (architecture), JOBS.md (critique + 112-job board), IMPROVEMENTS.md (research)
```

## Run it

Requires **Node ≥ 22.13** (built-in SQLite) and **Chrome or Edge** (Web Speech API, screen share).

```bash
npm install
cp apps/core/.env.example apps/core/.env      # add ANTHROPIC_API_KEY (required), ELEVENLABS_API_KEY (optional)
cp apps/web/.env.example  apps/web/.env       # optional VITE_PICOVOICE_ACCESS_KEY for the local wake word
npm run dev                                   # core on 127.0.0.1:8787, web on http://127.0.0.1:5173
```

If either port is already taken — usually a previous run that has not let go — both walk up to
the next free one and say so, so check the startup output for the actual URL.

Open the web URL, **tap to wake** (the browser needs one gesture before audio can play), then:

| Do | Result |
|---|---|
| Type in the transcript drawer | He answers; text appears as he speaks it |
| Press **Space** or click the orb | Listen once (no wake word) |
| Click **Always** (Shift+L) | Wake-word mode — say "Hey Jarvis, …" |
| Click **View** (Shift+S) | Share your screen; then ask "what's on my screen?" |
| Click the orb / press Space / Esc while he's talking | Interrupt |
| Shift+T | Toggle the transcript |

### Talk to him about himself
These are handled instantly without a model round-trip:

- "Jarvis, what time is it?" · "are you there?" · "stop" · "new session"
- "switch to Sonnet / Haiku / Opus / Fable"
- "humour to seventy" · "candor to full" · "set honesty to 90"
- "what are your settings?"

There are deliberately **no sliders** for honesty and humour — he changes them when you tell him to.

## Without keys
- **No `ANTHROPIC_API_KEY`:** the fast-path intents above still work; everything else gets "my reasoning core isn't connected".
- **No `ELEVENLABS_API_KEY`:** the browser's own British voice is used (Settings → Voice → Browser voice). With a key, ElevenLabs streams a much better voice and the orb glows to the actual audio.
- **No Picovoice key:** "Always" mode uses the browser recogniser to spot "Hey Jarvis" (audio goes to Google). With a key, Porcupine's built-in `jarvis` keyword runs locally in WASM — copy `porcupine_params.pv` into `apps/web/public/`.

## Scripts
```bash
npm run typecheck       # all packages
npm test                # shared + core unit tests
npm run build           # production web build → apps/web/dist
node scripts/smoke.mjs  # end-to-end WebSocket check against a running core
npm run bench:ttft -w @jarvis/core -- 10 opus,sonnet,haiku   # spike S1: time-to-first-token
```

## Security posture
Core binds to `127.0.0.1` only and requires a shared token (`JARVIS_TOKEN` ↔ `VITE_JARVIS_TOKEN`) plus a localhost origin on the WebSocket. API keys never reach the browser.

## Where things are
| Concern | File |
|---|---|
| Persona + honesty/humour bands | `apps/core/src/brain/persona.ts` |
| Fast-path intents | `apps/core/src/brain/intents.ts` |
| Model capability gating | `packages/shared/src/models.ts` |
| Streaming turn loop, tools, cancellation | `apps/core/src/brain/chat.ts` |
| Sentence chunker for TTS | `apps/core/src/voice/chunker.ts` |
| TTS adapters | `apps/core/src/voice/tts.ts` |
| Orb | `apps/web/src/orb/Orb.tsx` |
| Listening modes / wake word | `apps/web/src/voice/listening.ts` |
| Audio playback, earcons, analyser | `apps/web/src/voice/audio.ts` |
| Transcript sync + event routing | `apps/web/src/app/events.ts` |
