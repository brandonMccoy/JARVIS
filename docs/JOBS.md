# J.A.R.V.I.S. — Plan Critique & Job Breakdown

Companion to `docs/PLAN.md`. Part 1 is an honest critique of that plan — 18 findings. Part 2 replaces its seven coarse phases with **112 jobs** (107 from the critique plus five adopted from `docs/IMPROVEMENTS.md`), each sized to a day or less and each with a check that says whether it is actually done.

---

# Part 1 — Critique

## Severity 1 — things that were wrong, not just vague

### C1. The latency target was arithmetic that doesn't add up
"≤ 1.5 s from end of speech to first spoken syllable" is stated as a requirement and then quietly contradicted by the plan's own choices. Add the real segments: 700 ms of VAD silence (dead time before you even *know* the user stopped) + 100–300 ms STT finalisation + 400–2000 ms to Claude's first **text** token (adaptive thinking is on by default on Opus 5, and thinking blocks stream before text) + 150–400 ms waiting for a safe chunk boundary + 150–300 ms TTS first byte. That is **1.3–3.7 s**, with the optimistic end requiring Sonnet at `effort: low` and a short VAD window.

Worse, the 700 ms VAD window was hidden *inside* the budget, which made it look like there was 1.5 s of engineering headroom when there was really 800 ms.

**Fixed:** split into two numbers — **time-to-acknowledge ≤ 600 ms** (the orb and indicator react the moment the transcript finalises; this is what actually makes it feel alive) and **time-to-first-word ≤ 2.5 s**, stretch 1.5 s. Both measured in spikes before anything depends on them. Added a pre-rendered filler line when first-word exceeds ~1.2 s.

### C2. Per-model 400s were designed in
The settings object carried one global `effort` and one prompt-assembly path for all four models. But:
- `output_config.effort` **errors on Haiku 4.5**.
- Mid-conversation `{role: "system"}` messages — which the plan used for operator nudges — are **rejected on Sonnet 5 and Haiku 4.5**.
- The `web_search_20260209` tool type **doesn't exist for Haiku 4.5**; it needs the basic `web_search_20250305`.
- Haiku's context window is 200K, not 1M, so the compaction trigger can't be a single global constant.

So "Jarvis, switch to Haiku" would have produced a hard API error on the very next turn. **Fixed:** a capability record per model in `brain/models.ts` (new §3.1a in the plan); every request is built through it.

### C3. Interrupting mid-tool-call would corrupt the conversation
Barge-in was one line: "cancel stream + stop audio." If the aborted turn had already emitted a `tool_use` block, history now holds a `tool_use` with no matching `tool_result` — and the **next** request 400s. This is the kind of bug that shows up a week after the feature "works." **Fixed:** new §3.5 — every abort path synthesises a cancelled `tool_result`, and the partial assistant turn is stored marked truncated.

### C4. Claude cannot start a screen share
`getDisplayMedia` requires a user gesture. The plan had a `take_screenshot` tool as though he could look whenever he liked. He can't — he can only read frames from a share **you** started with the button. Same class of constraint: `AudioContext` won't start without a gesture either, so the app needs a "tap to wake" on first load or his voice never plays. **Fixed** in §8.

### C5. "Always listening" + speakers is a feedback loop
The plan treated barge-in as free. In practice the mic hears his own voice: the wake word self-triggers and STT transcribes him as you. Browser AEC helps only when input and output share a device. **Fixed:** layered mitigation in §4.4, with **click-the-orb / `Space` to interrupt** as the primary, deterministic path built first, and voice barge-in demoted to optional and gated on a spike.

## Severity 2 — architectural risks that were under-weighted

### C6. The tool runner may not fit the voice loop
The plan commits to `client.beta.messages.toolRunner` *and* to token-level streaming *and* to mid-turn abort. Those three may not compose. If the runner doesn't expose streaming deltas and an `AbortController`, the loop must be hand-written — and that decision changes the shape of `brain/`. It belongs in a spike **before** Phase 0, not discovered in Phase 5.

### C7. Activity events were attributed to the wrong layer
The plan said the tool runner emits them. Server-side tools (web search) never reach a tool-runner hook — they arrive as `server_tool_use` blocks in the raw stream. Activity must be derived from the stream, not the runner, or "Researching" will never fire.

### C8. Per-sentence HTTP TTS is the wrong shape
"Sentence by sentence" implied N HTTP requests. That restarts prosody at every boundary (audibly choppy) and pays TTFB N times. **Fixed:** ElevenLabs' *streaming-input WebSocket* — one socket, continuous text in, continuous audio out.

### C9. Transcript sync was specified as an outcome, not a mechanism
"In sync with TTS" can't come from token arrival — text would race ~2 s ahead of speech. The audio queue has to emit "now playing chunk N" and the transcript reveals on that. Now its own job (J2.14).

### C10. The orb would have been driven through React
Nothing said otherwise, and the obvious implementation — `setState` on each amplitude sample — re-renders the tree 60×/s and blows the frame budget. Now an explicit rule in §5 and a job (J1.7).

### C11. Phase ordering put the safe work first
The orb (lowest risk, highest visibility) was Phase 1; the voice loop (every unknown in the project) was Phase 2 as a single bullet. Standard practice is the reverse: attack the riskiest unknown first, because if the latency is 3.5 s the whole UX needs rethinking and you want to know that in week 1, not week 3. **Fixed:** a new **Phase S** of six timeboxed spikes, ~3 days, before any product code.

## Severity 3 — gaps

- **C12. No security posture.** Phase 5 gives this process filesystem write access. A `0.0.0.0` bind would expose an unauthenticated write-capable agent to your LAN. Now: `127.0.0.1` + shared-token handshake + origin check.
- **C13. `better-sqlite3` is a native module** — node-gyp on Windows means Visual Studio Build Tools. Node 22 ships `node:sqlite`; same shape, zero install cost.
- **C14. No error, reconnect, or permission-denied UX.** What he says when the API is down, the mic is refused, or the socket drops was undefined. Now jobs J0.17, J6.1–J6.3.
- **C15. `max_tokens` was never set** for spoken turns — he would monologue. Capped ~600 for speech, raised for analysis.
- **C16. `stop_reason: "refusal"` unhandled** — he'd just go silent. Now J0.16.
- **C17. No way to tell if the personality feature works.** It's the headline feature and had no check. Now J3.10, a tiny regression script: 5 prompts × 3 band settings, outputs saved for eyeballing.
- **C18. Estimates are optimistic.** Phase 5 (MCP host + permissions + two servers + UI) in two weeks is tight. Phase sizing below is in jobs, not weeks, so slip is visible.

## What I'd cut from v1
Watch mode (§8), the Deepgram and Azure adapters, the memory tool, and the Tauri companion. All are real, none are load-bearing, and each is a week you're not spending on the loop that makes this feel like J.A.R.V.I.S. They stay in Phase 6.

## What the plan got right
The two-process split is correct and for the right reasons. Prose bands instead of raw percentages is the right way to make the personality dials actually do something. Deriving activity from real stream events rather than UI guesswork is the difference between an indicator you trust and decoration. Treating apps as MCP servers behind a three-layer gate is the right call and ages well.

---

# Part 2 — Jobs

**Sizes:** `S` ≤ 2h · `M` ≈ half day · `L` ≈ 1 day. Nothing is larger than `L`; anything that grows past it gets split.
**Deps** are job IDs. Anything with no dep can start immediately.

---

## Phase S — Spikes (6 jobs, ~3 days) — *throwaway code, answers only*

Nothing here ships. Every spike ends with a number or a decision written into `docs/measurements.md`.

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| S1 | **Claude TTFT bench.** Node script, no UI: 20 turns each on `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` at `effort` low/medium, with and without thinking. Record time-to-first-**text**-token, p50 and p95. | M | — | A table in `docs/measurements.md` with p50/p95 per model+effort. |
| S2 | **TTS bench.** ElevenLabs streaming-input WebSocket. Measure first-audio-byte; feed text in 3 chunks and listen for prosody seams. Audition 3–4 British RP male voices on the same 5 lines. | M | — | Chosen `voiceId` recorded, TTFB measured, seam verdict written down. |
| S3 | **STT + turn-detection bench.** Web Speech API in Chrome. Time end-of-speech → final transcript at VAD thresholds 400 / 700 / 1000 ms, **then** run LiveKit's open turn-detector ONNX model on the same 20 utterances (10 complete, 10 trailing off) and compare cut-offs and dead time. | L | — | Chosen VAD fallback threshold, measured finalisation time, and a yes/no on the semantic model with its miss/false-close counts. |
| S4 | **Wake word + self-hearing.** Porcupine web with built-in `jarvis`. Count false accepts over 30 min of normal conversation and music. Then play TTS on **speakers** with the detector armed and count self-triggers. | L | — | FA rate per hour, and a yes/no verdict on voice barge-in over speakers. |
| S5 | **Tool runner viability.** Does `client.beta.messages.toolRunner` give token-level streaming deltas *and* accept an `AbortController`? Try to abort mid-tool-call. | M | — | Written decision: tool runner, or hand-written loop. Blocks J0.13. |
| S6 | **Reconcile the budget.** Add S1+S2+S3 into the real end-to-end number. Rewrite §4.5 of the plan with measured values. Decide whether the filler line is needed. | S | S1,S2,S3 | §4.5 latency table contains measured numbers, not estimates. |

> **Gate:** if S6 lands above ~3 s, stop and revisit before Phase 0 — the answer is probably Sonnet at `effort: low` as the default conversational brain, with Opus reserved for analysis turns.

---

## Phase 0 — Foundation (24 jobs)

**Repo & scaffolding**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J0.1 | pnpm workspace, root `tsconfig.base.json`, eslint + prettier, `.gitignore`, `git init` | S | — | `pnpm -r typecheck` passes on empty packages. |
| J0.2 | Scaffold `apps/web` (Vite + React 19 + TS) | S | J0.1 | `pnpm --filter web dev` serves on :5173. |
| J0.3 | Scaffold `apps/core` (Fastify + TS + tsx watch), bind `127.0.0.1:8787` | S | J0.1 | `GET /health` returns 200; confirmed *not* reachable from another device. |
| J0.4 | Dev script: one command runs both; Vite proxies `/ws` to core | S | J0.2,J0.3 | `pnpm dev` brings up both, browser reaches core through the proxy. |

**Shared contracts**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J0.5 | `packages/shared`: `Settings` zod schema + defaults (incl. `hud`, `personality`) | S | J0.1 | Schema parses defaults; invalid input rejected in a unit test. |
| J0.6 | `packages/shared`: WS event discriminated unions (client→server, server→client) + parse helpers | M | J0.5 | Every event in plan §2.3 has a schema; round-trip test passes. |
| J0.7 | `packages/shared`: `AppPermission` schema (unused until Phase 5, defined now so core never guesses) | S | J0.5 | Typecheck passes. |

**Transport**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J0.8 | Core: WS endpoint, connection registry, heartbeat ping/pong | M | J0.3,J0.6 | Two browser tabs connect; killing one doesn't affect the other. |
| J0.9 | Core: shared-token handshake + origin check on WS upgrade | S | J0.8 | Connection without the token is rejected with 401. |
| J0.10 | Web: WS client with auto-reconnect + exponential backoff + exposed connection state | M | J0.2,J0.6 | Kill core → web shows "reconnecting"; restart core → reconnects without a page reload. |

**Storage & settings**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J0.11 | Core store on `node:sqlite`: migrations + tables `settings`, `sessions`, `messages`, `audit` | M | J0.3 | Fresh DB created on first run; second run doesn't re-migrate. |
| J0.12 | Core settings service: get / patch / persist / broadcast `settings.changed` | M | J0.11,J0.8 | Patch from one tab appears in a second tab within a frame. |

**Brain**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J0.13 | Core: Anthropic client factory, `.env` loading, startup key check with an actionable error | S | J0.3 | Missing key prints "Set ANTHROPIC_API_KEY in apps/core/.env", not a stack trace. |
| J0.14 | Core: **`brain/models.ts` capability registry** — alias, id, `supportsEffort`, `supportsMidConvSystem`, `webSearchToolType`, `contextWindow`, `maxOutput`, `supportsFallbacks` | M | J0.13 | Unit test asserts Haiku has `supportsEffort: false` and the basic search tool type. |
| J0.15 | Core: `brain/persona.ts` — identity + voice-style blocks, honesty/humor prose bands, assembly order, cache breakpoint placement | L | J0.5 | Given `{honesty: 85, humor: 40}` the builder emits the expected prose; snapshot test. |
| J0.16 | Core: `brain/chat.ts` — `messages.stream`, adaptive thinking, effort **gated by J0.14**, `fallbacks: "default"` on Opus 5 / Fable 5, `max_tokens` ~600 for spoken turns | L | J0.14,J0.15,S5 | A prompt returns a streamed reply in persona ending in "Sir." |
| J0.17 | Core: stream → event mapper. `content_block_start`(thinking) → `thinking`; `server_tool_use` → `researching`; `tool_use` → `tool`; first text delta → `speaking`; `message_stop` → `idle` | L | J0.16,J0.6 | Console log of a single turn shows the activity sequence in order. |
| J0.18 | Core: history persistence — append full `response.content` (compaction blocks survive), per-turn write | M | J0.11,J0.16 | Restarting core preserves the conversation. |
| J0.19 | Core: handle `stop_reason: "refusal"` → spoken decline line + activity back to idle | S | J0.16 | Forced refusal produces speech, not silence. |
| J0.20 | Core: error taxonomy — `NotFoundError` / `RateLimitError` / `APIStatusError` / `APIConnectionError` each mapped to a spoken message | M | J0.16 | Unplugging the network yields "I can't reach my reasoning, Sir", not a crash. |

**Web shell**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J0.21 | Web: app shell, theme tokens (light/dark/system), layout regions for orb / activity / dock / drawer | M | J0.2 | Empty regions render correctly in both themes. |
| J0.22 | Web: zustand stores — `assistant`, `settings`, `transcript` | S | J0.21,J0.5 | Devtools show state; settings mirror from `settings.changed`. |
| J0.23 | Web: transcript drawer — open/close, persisted to `localStorage`, message rows, autoscroll with scroll-lock, text input | L | J0.22,J0.10 | Typing sends `user.utterance`; reply streams in; scrolling up stops autoscroll. |
| J0.24 | Web: activity indicator component, `aria-live="polite"`, 30 s watchdog → idle | M | J0.22 | Indicator follows a real turn and never sticks after `message_stop`. |

> **Phase 0 acceptance:** type "Good evening, Jarvis." in the drawer → indicator shows Thinking, then Speaking → streamed reply in persona ending in "Sir." No voice, no orb yet.

---

## Phase 1 — The Orb (13 jobs)

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J1.1 | R3F canvas mount: transparent, `position: fixed`, `dpr` capped 1.5, resize handling | S | J0.21 | Canvas floats over the shell with no layout shift. |
| J1.2 | Fibonacci sphere node generation + `InstancedMesh` (~240) | M | J1.1 | Even node distribution, one draw call. |
| J1.3 | KNN edge build (k=3, deduped pairs) → `LineSegments`, additive blending | M | J1.2 | Reads as a lattice; edge count logged and bounded. |
| J1.4 | Emissive core sphere + fresnel outer shell | M | J1.2 | Core visibly glows *through* the lattice. |
| J1.5 | Bloom pass, threshold/intensity tuned separately for light and dark themes | M | J1.4 | Not blown out on light ground, not muddy on dark. |
| J1.6 | Slow rotation + sine bob in `useFrame` | S | J1.2 | ~0.0015 rad/frame on Y, gentle vertical float. |
| J1.7 | **Imperative state driver** — mutable ref holds current + target values; `useFrame` lerps. Zero React re-render per frame | L | J1.4 | React DevTools profiler shows no renders while the orb animates. |
| J1.8 | State → visual mapping for idle / listening / thinking / researching / tool / speaking (incl. gold tool accent) | L | J1.7,J0.24 | Each state is visually distinguishable in a manual cycle. |
| J1.9 | Amplitude source abstraction `getLevel()` — oscillator now, `AnalyserNode` in Phase 2 | S | J1.7 | Swapping the source needs no orb changes. |
| J1.10 | Neuron firing animation — random subset pulses, rate driven by state | M | J1.7 | Firing rate visibly increases on `thinking`. |
| J1.11 | `prefers-reduced-motion` path — static orb, opacity-only state changes | S | J1.8 | Motion setting honoured; states still readable. |
| J1.12 | Perf pass — measure fps on integrated GPU, tune node/edge counts to hold 60 | M | J1.5,J1.10 | 60 fps sustained; final counts recorded. |
| J1.13 | Click / `Space` on the orb dispatches an interrupt intent (no-op until J2.15) | S | J1.1 | Click logs the intent; hover affordance visible. |

> **Phase 1 acceptance:** orb floats, rotates, pulses to a synthetic signal at 60 fps, and the indicator + orb flip Thinking → Speaking on a typed turn.

---

## Phase 2 — Voice loop (25 jobs) — *the hard part*

**Audio plumbing**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J2.1 | "Tap to wake" first-run gesture → resume `AudioContext`, request mic permission | M | J0.21 | Reload → one tap → his voice can play (autoplay policy satisfied). |
| J2.2 | Mic capture with `echoCancellation` / `noiseSuppression` / `autoGainControl` constraints | S | J2.1 | Stream acquired; constraints confirmed in `getSettings()`. |
| J2.3 | Web: ordered audio queue player — sequence numbers, gapless-ish playback, hard flush | L | J2.1 | Out-of-order chunks play in order; flush stops instantly. |
| J2.4 | Web: `AnalyserNode` on the output → RMS → `getLevel()` (replaces the oscillator) | M | J2.3,J1.9 | Orb glow tracks his actual voice. |

**Listening**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J2.5 | Listening-mode state machine: off / single / always, plus the follow-up window | L | J0.22 | All transitions exercised; mode persists across reload. |
| J2.6 | Control dock UI — three buttons, lit/pulsing states, keyboard shortcuts, aria labels | L | J2.5,J0.21 | `L` / `Space` / `S` work; states legible in both themes. |
| J2.7 | Porcupine integration + AccessKey config + sensitivity setting | L | J2.2,S4 | "Hey Jarvis" opens the mic; sensitivity slider changes FA rate. |
| J2.8 | STT adapter interface + Web Speech implementation (interim + final results) | L | J2.2 | Interim text appears in the drawer; final fires once. |
| J2.9 | **Semantic end-of-turn detection** *(Improvement #1)* — LiveKit turn-detector ONNX in core on the interim transcript, combined with Silero VAD; `min_delay` ≈ 150 ms, `max_delay` ≈ 1.2 s; plain VAD threshold kept as a fallback setting | L | J2.8,S3 | "What time is it" closes ≤ 200 ms after speech ends; "so what I want you to do is…" followed by an 800 ms pause does **not** close the turn. |
| J2.10 | **Wake-word gating while audio plays**, re-arm ~150 ms after the queue drains | M | J2.7,J2.3 | Playing his voice on speakers no longer self-triggers. |

**Speaking**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J2.11 | Core: TTS adapter interface + ElevenLabs **streaming-input WebSocket** client | L | J0.3,S2 | One socket per turn; audio streams out as text streams in. |
| J2.12 | Core: text chunker — safe flush boundaries, doesn't break on `Dr.`, `3.5`, `e.g.`, code spans | L | J2.11 | Unit tests over a nasty-input corpus all pass. |
| J2.13 | Core: audio frame relay over the app WebSocket with sequence numbers | M | J2.11,J0.8 | Frames arrive ordered and complete. |
| J2.14 | **Transcript reveal synced to playback** — queue emits "now playing chunk N", drawer reveals on that event, not on token arrival | M | J2.3,J0.23 | Text and speech stay together for a 30 s reply. |

**Interruption**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J2.15 | Click-orb / `Space` hard interrupt → abort core stream, flush audio queue, flush chunker | L | J1.13,J2.3,J0.16 | Interrupt lands in < 200 ms mid-sentence. |
| J2.16 | **Cancellation correctness** — synthesise cancelled `tool_result` for orphaned `tool_use`; store partial turn as truncated | L | J2.15,J0.18 | Interrupt mid-tool-call, then continue talking: next turn succeeds, no 400. |
| J2.17 | **Voice barge-in with backchannel gating** *(Improvement #4)* — only if S4 said yes; interrupt requires `min_words ≥ 2` *or* a stop-word ("stop", "wait", "no"); "mm-hm / yes / okay / go on" never interrupts. Otherwise ship headphones-only and document it | M | J2.10,S4 | Ten backchannels while he speaks → zero interruptions; "no, wait" interrupts in < 300 ms; or correctly disabled with a settings note. |

**Proving it**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J2.18 | Filler line — pre-rendered "One moment, Sir." played when first-word exceeds the S6 threshold | M | J2.3,J0.17 | Slow turns have no dead air; fast turns never trigger it. |
| J2.19 | Latency instrumentation + toggleable on-screen debug overlay (per-segment timings) | M | J2.14 | Overlay shows VAD / STT / TTFT / TTS / total per turn. |
| J2.20 | Mic-denied and no-TTS-key UX — he degrades to text instead of failing silently | M | J2.2,J0.20 | Deny mic → clear spoken/printed explanation, text input still works. |
| J2.21 | **Acceptance run** — "Hey Jarvis, what time is it?" 10× ; record p50/p95 against the S6 budget | S | J2.19 | Measured numbers written to `docs/measurements.md`; pass or a named follow-up. |

**From the research list (`docs/IMPROVEMENTS.md`)**

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J2.22 | **Intent fast-path** *(Improvement #2)* — deterministic grammar in `core/brain/intents.ts` for stop / louder / quieter / mute / what time is it / new session / switch to *model* / *dial* to *N* / are you there; replies rendered once by TTS and cached as audio; low-confidence matches fall through to Claude | M | J2.11,J0.12 | "Jarvis, stop" and "what time is it" answered in < 100 ms with **no** Anthropic request in the log; "what time is it in Tokyo" falls through to Claude. |
| J2.23 | **Earcons** *(Improvement #3)* — four pre-decoded `AudioBuffer`s (wake accepted, utterance captured, denied, thinking texture) through the output graph so the orb reacts; volume tied to the TTS setting; J2.18 filler threshold raised to ~2 s | S | J2.3,J2.7 | Chime audible within 50 ms of wake-word accept; filler no longer fires on turns under 2 s. |
| J2.24 | **Voice-loop metrics** *(Improvement #13)* — per session: false-interrupt rate, missed-interrupt rate, resume success, repeated-user-speech rate, time-to-acknowledge and time-to-first-word p50/p95; written to SQLite and shown in the J2.19 overlay | M | J2.19,J2.25 | A 20-turn session produces a metrics row; overlay shows the six numbers live. |
| J2.25 | **False-interrupt resume** *(Improvement #4)* — if an interruption is followed by ≥ 2 s of silence with no transcript, resume the audio queue from the truncation point instead of leaving dead air | M | J2.17,J2.15 | A cough mid-reply pauses him and he resumes the same sentence within 2 s. |

> **Phase 2 acceptance:** wake word → spoken answer within the measured budget, orb lighting from within, transcript printing in step with his voice, and a click that reliably shuts him up.

---

## Phase 3 — Personality & brain by voice (13 jobs)

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J3.1 | `set_personality({honesty?, humor?})` tool — validate 0–100, persist, confirm in character | M | J0.15,J0.12 | "Humor to eighty" changes behaviour on the *next* turn and he says so. |
| J3.2 | `set_model({alias})` tool — alias map, capability re-gate on switch, cache-miss warning | M | J0.14 | "Switch to Haiku" works and does **not** send `effort`. |
| J3.3 | `get_time` + `get_settings` tools (so "what are your settings?" is answerable) | S | J0.16 | He reads back current honesty/humor/model. |
| J3.4 | Web search tool wiring with **per-model tool type** from J0.14 | M | J0.14,J0.17 | Search works on Opus 5 *and* Haiku 4.5. |
| J3.5 | Activity mapping for `server_tool_use` → `researching` with the query string | S | J3.4,J0.24 | Indicator reads `Researching "…"` with the real query. |
| J3.6 | Transcript inline tool rows ("Searched the web · 3 results") | M | J0.23,J3.4 | Rows appear inline, visually quieter than speech. |
| J3.7 | Settings page: Brain (model, effort with per-model gating in the UI, new session) | M | J0.12,J0.14 | Effort control is disabled with an explanation when Haiku is active. |
| J3.8 | Settings page: Voice (provider, voiceId, wake sensitivity, follow-up window, VAD) | M | J0.12 | Changes take effect without a restart. |
| J3.9 | Token + cost meter from `usage`, per session and per day | M | J0.18 | Meter matches the Anthropic console within rounding. |
| J3.10 | Session management: new session, list, resume, compaction enable at a **per-model** threshold | L | J0.18,J0.14 | Long session compacts and keeps answering coherently. |
| J3.11 | **Persona regression script** — 5 fixed prompts × 3 band settings, outputs saved to a file for eyeballing | M | J3.1 | `pnpm persona:check` writes a diffable transcript. |
| J3.12 | Settings page: Screen (default mode, interval) | S | J0.12 | Persists and broadcasts. |
| J3.13 | **Scripted conversation eval** *(Improvement #13)* — a 20-turn script of recorded audio files (incl. two backchannels, one real interruption, one intent fast-path, one model switch) replayed through the real pipeline; asserts on transcript, activity sequence, and J2.24 metrics | M | J2.24,J3.11 | `pnpm voice:eval` runs end-to-end and fails on a regression in any asserted turn. |

> **Phase 3 acceptance:** "Switch to Sonnet", "dial the humor to eighty", and "look up the SpaceX launch" all work by voice, audibly change behaviour, and drive the right indicator states.

---

## Phase 4 — Screen sharing (8 jobs)

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J4.1 | `getDisplayMedia` behind the dock button (**user gesture**), track-ended handling, share thumbnail badge | M | J2.6 | Stopping the share from Chrome's own bar updates the button state. |
| J4.2 | Frame grabber — offscreen canvas, downscale ≤ 1568 px long side, JPEG q 0.8 | M | J4.1 | Frame produced in < 100 ms; size logged. |
| J4.3 | `take_screenshot` tool ↔ web round-trip — request id, deferred promise, timeout | L | J4.2,J0.17 | Tool resolves with a frame, or times out cleanly after 5 s. |
| J4.4 | **No-active-share path** — tool returns a typed "no share" result; he asks you to start one | S | J4.3 | Asking "what's on my screen?" with no share gets a spoken request, not an error. |
| J4.5 | Attach image blocks to the next turn; raise `effort` to `high` for analysis turns | M | J4.3,J0.14 | Vision turn returns a correct description. |
| J4.6 | Activity `viewing_screen` + orb ring indicator | S | J4.3,J1.8 | Ring visible only while a share is live. |
| J4.7 | Privacy: frames never written to disk by default; explicit opt-in setting | S | J4.2 | Default run leaves no images on disk (verified). |
| J4.8 | Watch mode — interval capture + perceptual-hash gate *(deferrable to Phase 6)* | L | J4.2 | Identical frames are not re-sent. |

> **Phase 4 acceptance:** press View screen, ask "what's wrong with the code on my screen?", get a correct answer, and see the ring while he looks.

---

## Phase 5 — Apps & permissions (13 jobs)

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J5.1 | Permission schema wired to storage; defaults **all off**, `confirmWrites: true` | S | J0.7,J0.11 | Fresh install grants nothing. |
| J5.2 | MCP client host — spawn stdio servers from config, lifecycle, crash restart with backoff | L | J0.3 | Killing a server process restarts it without taking core down. |
| J5.3 | Tool discovery + read/write classification from `readOnlyHint` / `destructiveHint` + manual override map | L | J5.2 | Every discovered tool lands in read or write; unknowns default to write. |
| J5.4 | **Layer 1 — visibility filter:** disabled apps' tools never enter `tools` | M | J5.3,J5.1 | Disabling GitHub removes its tools from the request payload (asserted in a test). |
| J5.5 | **Layer 2 — runtime gate:** re-check on every call; denial returns a typed result he explains out loud | M | J5.4 | Forcing a stale tool list still gets blocked. |
| J5.6 | **Layer 3 — audit log:** every call, permitted or denied, written with args digest | M | J5.5,J0.11 | Log rows visible in SQLite after a session. |
| J5.7 | Confirmation flow — pause hook → `tool.confirm` → `awaiting_confirmation` → resolved **deterministically** by core on "yes"/"no" (not re-interpreted by Claude) | L | J5.5,J0.24 | "Shall I send that, Sir?" → "no" reliably cancels. |
| J5.8 | Parallel tool results returned in a **single** user message | S | J5.5 | Two concurrent calls produce one user message with both results. |
| J5.9 | Apps page — cards, Enabled/Read/Write chips, confirm-writes checkbox | L | J5.1,J0.21 | Toggles persist and immediately affect the next turn. |
| J5.10 | Apps page — per-app scope editor (directories, repos) + recent-activity drawer | L | J5.9,J5.6 | Scope limits are enforced by the gate, not just displayed. |
| J5.11 | ~~Wire filesystem MCP server with scoped directories~~ **Done, natively:** per-folder grants with a single containment choke point, folder picker served by core, read/search/write tools. Not the MCP server — its allowed-directory model has no per-folder write flag (PLAN §6.2a) | M | J5.10 | Reads inside scope succeed; outside scope is denied and explained. Covered by `fs-scope.test.ts` and `fs-tools.test.ts`. |
| J5.12 | Wire GitHub MCP server (PAT in core `.env`) | M | J5.3 | "Any open PRs?" answers correctly; write requires confirmation. |
| J5.13 | Security pass — confirm `127.0.0.1` bind, token handshake, origin check, and that a denied tool truly cannot execute | M | J0.9,J5.5 | Written checklist, each item verified by hand. |

> **Phase 5 acceptance:** filesystem and GitHub work by voice; turning Write off blocks writes at the request level; every write asks first; the audit log shows it all.

---

## Phase 6 — Hardening & deferred (10 jobs)

| ID | Job | Size | Deps | Done when |
|---|---|---|---|---|
| J6.1 | Reconnect UX — orb dims, indicator explains, queued utterance replays | M | J0.10 | Restarting core mid-sentence recovers gracefully. |
| J6.2 | Permission-denied UX for mic and screen, with a route back to granting | M | J2.20 | Clear guidance, no dead ends. |
| J6.3 | API-down / rate-limited spoken fallbacks with retry-after respect | M | J0.20 | 429 produces a calm spoken explanation, then recovery. |
| J6.4 | Memory tool (`memory_20250818`) for cross-session recall | L | J3.10 | He remembers a fact stated last session. |
| J6.5 | Deepgram STT adapter behind the J2.8 interface | L | J2.8 | Swappable in settings; latency compared to Web Speech. |
| J6.6 | Azure TTS adapter behind the J2.11 interface | L | J2.11 | Swappable in settings. |
| J6.7 | Cost guardrail — daily budget with a spoken warning at 80% | M | J3.9 | Warning fires once per day at threshold. |
| J6.8 | PWA install + window-shape polish | M | J1.12 | Installs and launches chromeless. |
| J6.9 | Watch mode (if deferred from J4.8) | L | J4.8 | See J4.8. |
| J6.10 | README + run instructions + `.env.example` | M | J5.13 | A clean clone runs after following the README only. |

---

## Rollup

| Phase | Jobs | Rough size |
|---|---|---|
| S — Spikes | 6 | ~3 days |
| 0 — Foundation | 24 | ~2 weeks |
| 1 — Orb | 13 | ~1 week |
| 2 — Voice loop | 25 | ~3 weeks |
| 3 — Personality & brain | 13 | ~1.5 weeks |
| 4 — Screen | 8 | ~1 week |
| 5 — Apps & permissions | 13 | ~2 weeks |
| 6 — Hardening | 10 | ~1.5 weeks |
| **Total** | **112** | **~12.5 weeks** at a steady solo pace |

**MVP = Phase S + 0 + 1 + 2** (68 jobs, ~6.5 weeks): a floating neural orb you wake by voice, that answers in character, prints what it says, and shuts up when you tell it to. Everything after that is capability, not identity.

## Critical path
`S5 → J0.16 → J0.17 → J2.11 → J2.12 → J2.13 → J2.3 → J2.14 → J2.15 → J2.16`, with `S3 → J2.9` (semantic turn detection) feeding in at J2.14.

That chain is the product. The orb (Phase 1) and every settings page are off it and can be done in any gap — but nothing in Phase 2 should start before S1–S6 are answered.
