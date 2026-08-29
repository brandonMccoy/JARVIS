# Build Status — 2026-08-29

First build session. What exists, what was verified, and where the code deviates from `PLAN.md`.

## Verified
- `npm run typecheck` clean across shared / core / web; `npm test` 23/23; `npm run build` succeeds.
- `scripts/smoke.mjs` against a live core: unauthorised socket rejected (4401); fast-path "what time is it"; humour set by voice (80); model switched by voice (haiku); keyless Claude fallback line; activity returns to idle.
- In Chrome: orb renders (lattice + inner glow + rotation), tap-to-wake, typed message → spoken reply → transcript, screen share start/stop with gold View button and orbital ring, settings page with per-model effort gating. No console errors.
- **Not yet verified (needs keys):** a real Claude turn, ElevenLabs audio, Porcupine wake word. Web Speech STT and browser TTS are wired but were not exercised by microphone in this session.

## Jobs done (from JOBS.md)
Phase 0: J0.1–J0.24 except J0.9 partial (token + origin check done; no per-connection rate limit).
Phase 1: J1.1–J1.11, J1.13 (J1.12 perf pass not measured).
Phase 2: J2.1–J2.8, J2.10, J2.11 (HTTP variant), J2.12, J2.13, J2.14, J2.15, J2.16, J2.20, J2.22, J2.23 (partial: earcons synthesised; filler J2.18 not built), J2.17 (stop-word gate only; no min-words backchannel logic yet).
Phase 3: J3.1, J3.2, J3.3, J3.4, J3.5, J3.7, J3.8, J3.9 (meter shown in drawer header), J3.12.
Phase 4: J4.1, J4.2, J4.3, J4.4, J4.5, J4.6, J4.7.
Not started: Phase S spikes (script for S1 exists: `npm run bench:ttft`), J2.9 semantic turn detection (plain end-of-utterance from the recogniser for now), J2.18, J2.19 overlay, J2.21, J2.24, J2.25, J3.6, J3.10 compaction, J3.11, J3.13, J4.8, Phase 5 (settings for apps are stored; no MCP host yet), Phase 6.

## Deviations from the plan (deliberate)
| Plan said | Built | Why |
|---|---|---|
| pnpm workspaces | npm workspaces | pnpm wasn't installed; npm 10 handles the same layout. |
| ElevenLabs streaming-input WebSocket | HTTP `/stream` per chunk with `previous_text` | Exact chunk↔audio mapping (needed for transcript sync) and verifiable without a key; `previous_text` preserves prosody across chunks. Adapter interface allows swapping. |
| `@react-three/postprocessing` Bloom | Additive-blended radial sprites behind/over the emissive core | Keeps the canvas transparent and cheap; bloom composers fight alpha backgrounds. |
| Letter shortcuts `L` / `S` / `T` | `Shift+L` / `Shift+S` / `Shift+T` | A stray keystroke outside the input started a screen share during testing. |
| Tool runner | Hand-written streaming loop | Needed deterministic `AbortController` + per-event activity mapping (spike S5 resolved by building it). |
| Voice-loop STT | Browser recogniser handles wake-word spotting *and* capture in one continuous session when Porcupine isn't configured | Web Speech can't run two recognisers; one continuous session with a self-hearing gate is the keyless design. |

## Next
1. Add `ANTHROPIC_API_KEY`, run `npm run bench:ttft` (S1), and record numbers in `docs/measurements.md`.
2. Add `ELEVENLABS_API_KEY`, audition voices (S2), set `voiceId` in Settings → Voice.
3. J2.19 latency overlay + J2.21 acceptance run.
4. J2.9 semantic turn detection.
