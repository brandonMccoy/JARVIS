# J.A.R.V.I.S. — Strategic Plan, Requirements & Architecture

> Just A Rather Very Intelligent System. A voice-first web assistant with a Claude brain, a 3D neural-network orb for a face, and a Stark-household personality.

---

## 1. Vision & Non-Negotiables

| # | Requirement (from brief) | Interpretation / decision |
|---|---|---|
| R1 | React web app, single purpose: J.A.R.V.I.S. | Vite + React 19 + TypeScript SPA. No routing beyond `/` (orb) and `/settings/*`. |
| R2 | Same voice as the film J.A.R.V.I.S. | **Cannot legally clone the actor's voice** (Paul Bettany is a living person; every major TTS vendor prohibits cloning without consent). We target the *character* of the voice: refined British RP, measured pace, dry warmth. See §4.3. |
| R3 | Personality like the film AI | System-prompt persona: unflappable, understated wit, anticipates needs, addresses the user as **"Sir"**. |
| R4 | Tunable honesty % and humor % | **No visible sliders.** You tell him ("Jarvis, humor to 60") and he calls a `set_personality` tool that rewrites the persona section of the system prompt. Honesty = *candor/bluntness* (100 = unvarnished, 0 = maximally diplomatic); it never makes him fabricate. Humor = frequency/dryness of quips. |
| R5 | Claude models as the brain; switch by asking | Anthropic TypeScript SDK on a backend. A `set_model` tool lets J.A.R.V.I.S. switch himself when told ("switch to Sonnet"). |
| R6 | Voice interaction with wake word "Hey Jarvis" | Local wake-word engine (Picovoice Porcupine ships a built-in `jarvis` keyword) → streaming STT → Claude → streaming TTS. |
| R7 | Screen sharing for analysis (later) | `getDisplayMedia` → frame capture → Claude vision. |
| R8 | Access to specific apps, per-app on/off and read/write (later) | Each "app" is an MCP server hosted by the core service. A permissions registry filters which tools Claude is even shown, and gates execution at runtime. |
| R9 | Permissions menu page | `/settings/apps` — card per app with Enabled / Read / Write toggles. |
| R10 | Floating 3D neural-network orb; glows from inside when speaking; rotates slowly | React Three Fiber + Bloom postprocessing; glow intensity driven by the TTS audio analyser in real time. |
| R11 | Icons: always-listening, single-prompt listen, view screen | A three-button **control dock** under the orb. See §6. |
| R12 | Indicator of what he is currently doing | A live **activity indicator** (listening, thinking, researching, viewing screen, running *app*, awaiting confirmation, speaking). See §6. |
| R13 | Open/close area that prints what he says | A collapsible **transcript drawer** streaming his words as they are spoken. See §6. |

### Stated assumptions
- Personal, single-user project running on your own machine (localhost). Marvel owns the J.A.R.V.I.S. name and character; fine for personal use, rename before any public distribution.
- Chrome (or Edge) is the target browser. Web Speech API, `getDisplayMedia`, and WebGL2 behave best there.
- **Latency budget (revised — see §4.5).** A single "≤ 1.5 s end of speech → first syllable" number is not achievable with thinking enabled, and hiding a 700 ms VAD window inside it made it look easier than it is. The budget is now two numbers: **time-to-acknowledge ≤ 600 ms** (orb reacts, indicator flips) and **time-to-first-word ≤ 2.5 s** (stretch: 1.5 s on Sonnet at `effort: low`). Both are to be *measured* in spike S1–S3 before anything is built on them.

---

## 2. Architecture

### 2.1 Why a backend at all
Three things cannot live in the browser:
1. **The Anthropic API key.** The browser must never hold it.
2. **TTS / STT vendor keys** (ElevenLabs, Deepgram, Azure).
3. **App access.** A browser tab cannot touch your filesystem, calendar, GitHub, or local apps. Something must run on the machine to host MCP servers and enforce permissions.

So the system is two processes in one repo:

```
┌──────────────────────────────┐           ┌────────────────────────────────────┐
│  apps/web  (Vite + React)    │  WS       │  apps/core  (Node + Fastify)        │
│                              │◄────────► │                                    │
│  Orb (R3F)                   │           │  /ws    ── chat stream, audio       │
│  Voice pipeline              │  HTTP     │  brain  ── Anthropic SDK (stream)   │
│   ├ wake word (Porcupine)    │◄────────► │  voice  ── ElevenLabs / Deepgram    │
│   ├ STT (Web Speech / DG)    │           │  /settings ── persona, model, apps  │
│   └ TTS playback + analyser  │           │  Tool router                        │
│  Screen capture              │           │   ├ built-in tools (set_model …)    │
│  Settings UI                 │           │   └ MCP client ──► MCP servers      │
└──────────────────────────────┘           │  Permission gate                   │
                                           │  Store (SQLite: settings, history)  │
                                           └────────────────────────────────────┘
                                                   │            │
                                            Anthropic API   ElevenLabs / Deepgram
```

### 2.2 Monorepo layout (pnpm workspaces)

```
JARVIS/
├─ apps/
│  ├─ web/                       # React SPA
│  │  ├─ src/
│  │  │  ├─ orb/                 # R3F scene: NeuralOrb, Core, Edges, Bloom
│  │  │  ├─ voice/               # wakeWord.ts, stt.ts, tts.ts, audioBus.ts
│  │  │  ├─ brain/               # chat client (WS), message store
│  │  │  ├─ screen/              # display capture + frame sampler
│  │  │  ├─ settings/            # pages: Personality, Brain, Voice, Apps, Screen
│  │  │  ├─ state/               # zustand stores: assistant, settings, audio
│  │  │  └─ App.tsx
│  │  └─ index.html
│  └─ core/                      # Node 22 + Fastify + TypeScript
│     ├─ src/
│     │  ├─ brain/               # anthropic client, persona builder, model registry
│     │  ├─ tools/               # built-in tools + MCP bridge + permission gate
│     │  ├─ voice/               # tts.ts (ElevenLabs stream), stt.ts (Deepgram)
│     │  ├─ store/               # node:sqlite (built in, no native build): settings, apps, history
│     │  └─ server.ts
│     └─ .env                    # ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, …
├─ packages/
│  └─ shared/                    # zod schemas + TS types shared by web/core
│     └─ src/ { settings.ts, events.ts, apps.ts }
├─ docs/PLAN.md
└─ pnpm-workspace.yaml
```

### 2.3 Real-time protocol (web ⇄ core)
One WebSocket, JSON events (audio as binary frames), defined in `packages/shared/events.ts`:

| Direction | Event | Payload |
|---|---|---|
| web→core | `user.utterance` | `{ text, images?: base64[] }` |
| web→core | `user.interrupt` | (barge-in: cancel generation + TTS) |
| core→web | `assistant.delta` | `{ text }` streamed tokens |
| core→web | `assistant.audio` | binary chunk (streamed TTS) |
| core→web | `assistant.activity` | `{ kind: idle / listening / thinking / researching / viewing_screen / tool / awaiting_confirmation / speaking, detail?: string }` — `detail` names the app or search query |
| web→core | `mode.set` | `{ listening: "always" / "single" / "off" }` |
| web→core | `screen.frame` | `{ image: base64 }` — reply to `take_screenshot` or sent when the View Screen button is pressed |
| core→web | `tool.call` / `tool.result` | for the transcript and activity log |
| core→web | `tool.confirm` | `{ id, app, action }` — write actions needing a spoken "yes" |
| core→web | `settings.changed` | full settings object |

---

## 3. The Brain (`apps/core/brain`)

### 3.1 Model registry
| Alias (what you say) | Model ID | Role |
|---|---|---|
| "Opus" (default) | `claude-opus-5` | Everyday brain; best quality/latency balance |
| "Fable" | `claude-fable-5` | Heavy reasoning / analysis sessions |
| "Sonnet" | `claude-sonnet-5` | Fast and cheap for chatter |
| "Haiku" | `claude-haiku-4-5` | Ultra-fast for trivial queries |

- **Switching:** a built-in `set_model({ alias })` tool. "Jarvis, switch to Sonnet" → Claude calls the tool → core updates settings → the next turn uses it. Also a dropdown at `/settings/brain`.
- **Effort:** `output_config.effort` exposed as a setting. Voice chat defaults to `low`/`medium` for snappiness; screen-analysis turns bump to `high`.
- **Thinking:** `thinking: { type: "adaptive" }` (always on for Fable 5; on by default for Opus 5).
- **Refusal fallbacks:** on Fable 5 / Opus 5 send `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` so a classifier decline is retried server-side instead of leaving J.A.R.V.I.S. silent.
- **Streaming always** (`client.messages.stream`), chunked into TTS as tokens arrive.
- **`max_tokens` is a persona control.** Spoken turns cap at ~600 tokens so he cannot monologue; screen-analysis and research turns raise it. Streaming is required for the large values.

### 3.1a Per-model capability gating (do not skip)
The four models are **not** interchangeable, and a single global settings object that assumes they are will produce hard 400s at runtime. `brain/models.ts` carries a capability record per model and every request is built through it:

| Capability | Opus 5 | Fable 5 | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|---|
| `output_config.effort` | yes | yes | yes | **no — errors if sent** |
| Mid-conversation `{role:"system"}` messages | yes | yes | **no** | **no** |
| Web search tool type | `web_search_20260209` | `web_search_20260209` | `web_search_20260209` | **`web_search_20250305`** (basic) |
| Context window | 1M | 1M | 1M | **200K** |
| Refusal `fallbacks` | yes | yes | n/a | n/a |
| Thinking | on by default | always on, cannot disable | adaptive | `budget_tokens` style |

Two consequences the plan previously got wrong: operator nudges ("screen share started") **cannot** be mid-conversation system messages when the active model is Sonnet 5 or Haiku 4.5 — they fall back to a user-role context block; and switching model mid-session **starts a new cache namespace** (caches are model-scoped), so the first turn after a switch is a full cache miss. Warn about it in the cost meter rather than being surprised by it.

### 3.2 Persona and the two sliders
The system prompt is built from a stable template:

```
[IDENTITY]      You are J.A.R.V.I.S. … address the user as "Sir" …
[VOICE STYLE]   Spoken output: short sentences, no markdown, no lists, numbers as words …
[CANDOR 0-100]  ← honesty slider → e.g. 85: "Be direct. If Sir is wrong, say so plainly, then help."
[WIT 0-100]     ← humor slider  → e.g. 40: "At most one understated quip per exchange; never at the expense of clarity."
[TOOLS/APPS]    Which apps are enabled and whether writes need confirmation.
[CONTEXT]       Time, active model, screen-share status.
```

The two values are changed **by voice only**: "Jarvis, dial the humor up to 70" → he calls `set_personality({ honesty?, humor? })` → core persists the new values → he confirms in character ("Seventy percent, Sir. I shall endeavour to be insufferable."). Ask "what are your settings?" to hear the current values. There is no slider or form anywhere in the UI.

Values map to **prose bands** (0–20, 21–40, …) rather than raw numbers, so Claude gets behavioural guidance instead of a meaningless percentage. Bands live in `brain/persona.ts` so the wording is easy to tune.

**Prompt caching:** `[IDENTITY]` + `[VOICE STYLE]` + tool definitions form the cached prefix (`cache_control: { type: "ephemeral" }`); the personality/context sections come after the breakpoint, so changing a value doesn't invalidate the whole cache. Mid-turn operator nudges ("screen share started") use mid-conversation `{ role: "system" }` messages **on Opus 5 / Fable 5 only** — on Sonnet 5 and Haiku 4.5 that shape is rejected, so the nudge is emitted as a user-role context block instead (§3.1a).

### 3.3 Tool router
- **Built-in tools:** `set_model`, `set_personality`, `get_time`, `take_screenshot` (asks web for a frame), `remember` (v2 memory).
- **Research:** Anthropic's server-side `web_search_20260209` tool, so "Jarvis, look up…" works out of the box. While a search block is in flight the activity indicator shows **Researching** with the query.
- **App tools:** discovered from MCP servers at startup, filtered by the permission gate (§7), passed to Claude in `tools`.
- The loop is driven by the SDK tool runner (`client.beta.messages.toolRunner`), whose per-turn hooks are where the confirmation gate plugs in. **Spike S5 must confirm first** that the tool runner gives us streaming deltas *and* an abort path — the voice loop needs both. If it doesn't, we hand-write the loop; that decision changes `brain/` and must be made before Phase 0 code, not during Phase 5.
- Activity events come from the **raw stream** (`content_block_start` for a thinking block, `server_tool_use` for search, `tool_use` for apps, first `text` delta), not from the tool runner — server-side tools never reach a tool-runner hook at all.

### 3.4 Conversation state
- A session is a rolling message array held in core memory and persisted to SQLite per turn.
- Server-side compaction (beta `compact-2026-01-12`) once a session grows long; `response.content` is appended whole so compaction blocks survive.
- "Jarvis, new session" clears it.

### 3.5 Cancellation correctness (the barge-in trap)
Interrupting mid-turn is not just "stop the audio". If the aborted turn had already emitted a `tool_use` block, the stored history contains a `tool_use` with **no matching `tool_result`**, and the *next* request 400s. Every interrupt path must therefore:
1. Abort the Anthropic request via `AbortController`.
2. Flush the audio queue and the pending TTS chunker.
3. For each orphaned `tool_use`, append a synthetic `tool_result` with `is_error: true` and content `"Cancelled by Sir."`.
4. Store the partial assistant turn marked truncated, so he knows he was cut off rather than believing he finished.

Parallel tool calls return **all** their `tool_result` blocks in a single user message — splitting them trains Claude out of calling tools in parallel.

---

## 4. Voice Pipeline (`apps/web/voice` + `apps/core/voice`)

### 4.0 Listening modes (chosen from the control dock, §6)
| Mode | Button | Behaviour |
|---|---|---|
| **Always listening** | toggle, stays lit | Wake-word engine armed; "Hey Jarvis" opens the mic. Follow-up window after each answer. |
| **Single prompt** | momentary | Opens the mic immediately for one utterance, no wake word needed; closes on end-of-utterance. Ideal when the wake word is off. |
| **Off** | neither lit | Mic released entirely. Text input in the transcript drawer still works. |

### 4.1 Wake word
- **Picovoice Porcupine Web SDK** runs in-browser as WASM, always listening, no audio leaves the machine. Its built-in keyword list includes **`jarvis`**; "hey jarvis" can be trained in the Picovoice Console (free personal tier).
- **Fallback (no key):** Web Speech API in continuous mode + regex on interim results for `hey jarvis`. Works, but streams audio to Google constantly and is less reliable.
- Sensitivity slider at `/settings/voice`.
- **Follow-up window:** after each answer the mic stays open ~8 s so you don't have to repeat "Hey Jarvis" for every sentence.

### 4.2 Speech-to-text
- **v1:** Web Speech API (`SpeechRecognition`, Chrome). Zero setup, decent accuracy, ~300 ms.
- **v2:** Deepgram Nova streaming via core proxy: lower latency, keyword boosting ("Jarvis", "Opus", "Sonnet"), any browser.
- End-of-utterance: VAD silence ≥ 700 ms *or* the recogniser's `isFinal`.

### 4.3 Text-to-speech ("the voice")
- **Primary: ElevenLabs** streaming (turbo-class model, ~250 ms first byte). Pick a British RP male voice from their library and tune stability/similarity for a calm, precise delivery. Voice ID is a setting.
- **Alternative: Azure Neural TTS** `en-GB-RyanNeural` / `en-GB-OliverNeural` with SSML prosody tweaks: cheaper and very stable.
- **Use ElevenLabs' streaming-input WebSocket, not per-sentence HTTP calls.** Feeding it a continuous text stream keeps prosody coherent across chunk boundaries and pays the connection cost once; firing an HTTP request per sentence gives choppy, restarted intonation and a fresh TTFB every time. This is a change from the first draft of this plan.
- The chunker still matters (it decides when text is safe to flush), but it feeds one open socket rather than N requests. It must not break on `Dr.`, `3.5`, `e.g.`, or code spans.
- Core relays audio frames over its own WebSocket with sequence numbers; web decodes into Web Audio, and an `AnalyserNode` on the output feeds RMS amplitude to the orb every frame.

### 4.4 Turn-taking and barge-in
```
idle ─"hey jarvis"─► listening ─final transcript─► thinking ─first token─► speaking ─audio ends─► follow-up ─timeout─► idle
                                                                              │
                                                                 wake word / speech detected
                                                                              ▼
                                                                 cancel stream + stop audio (barge-in)
```
The state machine lives in `web/state/assistant.ts` (XState or a small reducer) and mirrors directly to the orb.

**The self-hearing problem.** "Always listening" plus speakers is a feedback loop: the mic hears his own voice, the wake word can self-trigger, and the STT transcribes him as if he were you. The first draft treated barge-in as free; it isn't. Layered mitigation, in order of reliability:
1. **Click the orb (or press `Space`) to interrupt** — deterministic, works on speakers, and is the primary path. Build this first.
2. **Gate the wake-word detector while audio is playing**, re-arming ~150 ms after the queue drains.
3. `getUserMedia({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })` — helps when input and output share a device, unreliable otherwise.
4. **Voice barge-in is optional and gated on spike S4.** If the false-accept rate on speakers is poor, ship headphones-only voice barge-in and keep click-to-interrupt as the default.

### 4.5 Latency budget (measured, not assumed)
| Segment | Realistic | Notes |
|---|---|---|
| VAD silence before end-of-utterance | 400–700 ms | Pure dead time. Tunable; the dominant fixed cost. |
| STT finalisation | 100–300 ms | Web Speech API. |
| Claude time-to-first-**text** token | 400–2000 ms | Thinking blocks stream *before* text. `effort: low` and Sonnet are the levers. |
| First chunk flushed to TTS | 150–400 ms | Chunker waits for a safe boundary. |
| TTS first audio byte | 150–300 ms | ElevenLabs turbo, socket already open. |
| **Total, end of speech → first syllable** | **≈ 1.3–3.7 s** | The old "≤ 1.5 s" was the floor, not the target. |

Therefore: **time-to-acknowledge ≤ 600 ms** is the number that actually protects the feel — the orb and indicator must react the instant the transcript finalises, long before he speaks. If measured time-to-first-word exceeds ~1.2 s, play a short pre-rendered filler ("One moment, Sir.") so the gap is never dead air.

---

## 5. The Orb (`apps/web/orb`)

**Stack:** `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` (Bloom).

**Construction**
- **Nodes:** ~240 points on a Fibonacci sphere as an `InstancedMesh` of tiny spheres; a random subset pulses ("firing neurons").
- **Edges:** k-nearest-neighbour (k≈3) segments between nodes → `LineSegments` with additive blending. This is what reads as "neural network".
- **Core:** inner sphere (r ≈ 0.55) with an emissive material. Bloom makes it glow *through* the lattice — the "from the inside out" effect.
- **Shell:** faint transparent outer sphere with a fresnel rim for depth.
- **Rotation:** `useFrame` → `group.rotation.y += 0.0015`, slight wobble on x.
- **Reactivity by state:**
  - `speaking`: `emissiveIntensity = base + amplitude × gain` (lerp-smoothed); edges brighten with amplitude.
  - `listening`: gentle breathing pulse, colour shifts toward cyan.
  - `thinking`: faster node-firing, subtle ripple across edges.
  - `idle`: slow breathing at low intensity.
- **Floating:** vertical sine bob; the canvas is transparent and `position: fixed`, draggable to a corner.
- **Palette:** Stark blue/cyan (`#38bdf8` → `#7dd3fc`) with a warm gold accent while a tool is executing.

Performance budget: 60 fps on an integrated GPU — instancing, one Bloom pass, `dpr` capped at 1.5.

**The one rule that keeps it at 60 fps:** the orb reacts at audio rate, so its state must **never** go through React. Amplitude and target intensities live in a mutable ref that `useFrame` lerps toward each frame; a React `setState` per audio frame would re-render the tree 60×/s and drop the frame budget. The web/core activity events set the *target*; the animation loop owns everything else.

---

## 6. Main Screen: Controls, Activity, Transcript (`apps/web/hud`)

The `/` route is deliberately sparse: the orb, a small control dock, an activity line, and a drawer. No sliders, no forms.

```
┌───────────────────────────────────────────────────────────────┐
│                                                     ⚙ settings │
│                                                                │
│                          ( orb )                               │
│                                                                │
│                 ● Researching "SpaceX launch"                  │  ← activity indicator
│                                                                │
│                  [🎧 always]  [🎤 once]  [🖥 view]              │  ← control dock
│                                                                │
│ ▾ Transcript ──────────────────────────────────────────────── │  ← drawer (open/closed)
│  J.A.R.V.I.S.  The launch is scheduled for 21:40 UTC, Sir…     │
│  You           what time is it in Texas                        │
│  > type here…                                                  │
└───────────────────────────────────────────────────────────────┘
```

### 6.1 Control dock (three icon buttons)
| Button | Type | Action | Visual |
|---|---|---|---|
| **Always listening** | toggle | Arms the wake word (§4.0). | Lit ring while armed; pulses when the mic is open. |
| **Listen once** | momentary | Opens the mic for a single prompt without the wake word. | Fills while recording; auto-releases on end-of-utterance. |
| **View screen** | toggle | Opens the browser's display picker; while active he can see the screen (§8). Pressing it captures a frame and sends it with the next prompt, or you can just ask "what do you see?" | Lit ring while a share is active; a thumbnail badge shows what is shared. |

Keyboard: `Space` = listen once, `L` = always listening, `S` = view screen, `T` = transcript.

### 6.2 Activity indicator
A single line beneath the orb, driven by `assistant.activity` events from core. States and their orb coupling:

| Activity | Shown as | Orb |
|---|---|---|
| `idle` | (hidden) | slow breathing |
| `listening` | ● Listening… | cyan pulse |
| `thinking` | ● Thinking… | faster neuron firing |
| `researching` | ● Researching "query" | ripple across edges |
| `viewing_screen` | ● Viewing screen | ring indicator |
| `tool` | ● Checking GitHub… / Writing file… | gold accent |
| `awaiting_confirmation` | ● Awaiting your confirmation, Sir | gold, held |
| `speaking` | ● Speaking | glow follows audio amplitude |

Activity is derived on the core side from stream events (thinking blocks → `thinking`, `server_tool_use` web_search → `researching`, custom `tool_use` → `tool` with the app name, first text token → `speaking`), so the indicator is always truthful rather than guessed by the UI.

### 6.3 Transcript drawer
- Collapsible panel (chevron or `T`), remembers open/closed state across reloads.
- Prints his words **as they are spoken**, sentence by sentence in sync with TTS, not the full reply up front; your utterances appear as recognised.
- Tool activity appears as quiet inline rows ("Searched the web · 3 results", "Read `README.md`").
- A text box at the bottom for typing when speech is inconvenient.
- Scrolls to the newest line unless you've scrolled up; "copy transcript" and "new session" actions in the drawer header.

---

## 7. App Access and Permissions (Phase 5)

### 6.1 Model
Every "app" is an **MCP server** the core launches or connects to. Candidates, roughly by value:

| App | MCP source | Read examples | Write examples |
|---|---|---|---|
| Filesystem (scoped dirs) | `@modelcontextprotocol/server-filesystem` | list/read files | create/edit files |
| GitHub | official GitHub MCP | issues, PRs, diffs | comment, create issue |
| Google Calendar / Gmail | community MCP | today's agenda, unread | create event, send mail |
| Spotify | community MCP | now playing | play/pause/queue |
| Browser (Chrome) | Chrome MCP / Playwright | read page | click/navigate |
| Home automation | Home Assistant MCP | sensor states | toggle lights |

### 6.2 Permission registry (`packages/shared/apps.ts`)
```ts
type AppPermission = {
  id: string;             // "github"
  enabled: boolean;       // master switch
  read: boolean;
  write: boolean;
  confirmWrites: boolean; // spoken confirmation before each write
  scope?: Record<string, unknown>; // e.g. allowed directories
};
```

### 6.3 Enforcement: three layers
1. **Visibility.** Disabled apps' tools are never sent to Claude. Tools are classified read/write from MCP annotations (`readOnlyHint`, `destructiveHint`) plus a manual override map; `write=false` strips write tools from the list.
2. **Runtime gate.** The tool router re-checks permission on every call (defence against stale tool lists). With `confirmWrites`, it emits `tool.confirm` → J.A.R.V.I.S. says *"Shall I send that, Sir?"* and waits for a yes.
3. **Audit log.** Every tool call, permitted or denied, is written to SQLite and shown on the Apps page.

### 6.4 UI: `/settings/apps`
Grid of app cards: icon, name, status dot, **Enabled** toggle, **Read** / **Write** chips, "Confirm writes" checkbox, scope editor (folders, repos), and a "Recent activity" drawer per app.

### 6.5 Native desktop apps (later)
A browser cannot inspect arbitrary desktop windows. For "look at what's in VS Code / Outlook", the path is a **desktop companion** (Tauri shell around the same React app) that gains OS-level window capture and accessibility-tree access. The permission model transfers unchanged; the companion simply registers more MCP servers.

---

## 8. Screen Sharing (Phase 4)
> **Hard browser constraint the first draft missed:** `getDisplayMedia` **requires a user gesture**. J.A.R.V.I.S. can never start a screen share on his own. The View screen button is therefore the *only* way a share begins, and the `take_screenshot` tool can only read a frame from an already-active stream. If he calls it with no share running, the tool returns a "no active screen share" result and he says so out loud ("I'll need you to share your screen first, Sir") rather than silently failing. The same rule applies to `AudioContext` and the mic: the app needs a one-time "tap to wake" gesture on first load before it can play his voice at all (autoplay policy).

- Started from the **View screen** button (§6.1): `navigator.mediaDevices.getDisplayMedia({ video: true })` → `<video>` → offscreen canvas.
- **On-demand mode (default):** when you ask "what's on my screen?" (or press the button mid-conversation), grab one frame, downscale to ≤ 1568 px on the long side, JPEG q≈0.8, attach as a base64 `image` block.
- **Watch mode:** one frame every N seconds, only *sent* if it differs from the last (perceptual hash) and a question is pending or J.A.R.V.I.S. was asked to monitor for something.
- Activity indicator shows **Viewing screen**; the orb shows a ring while sharing. `/settings/screen` picks default mode and interval.
- Analysis turns use `effort: "high"` on Opus 5 / Fable 5.

---

## 9. Settings and Persistence
A single `Settings` zod schema in `packages/shared`, stored in SQLite by core, mirrored in a zustand store on the web, every change broadcast as `settings.changed`.

```ts
Settings = {
  personality: { honesty: 0-100, humor: 0-100, honorific: "Sir" },   // voice-only; no UI
  brain: { model: "opus" | "fable" | "sonnet" | "haiku", effort: "low"|"medium"|"high"|"xhigh"|"max" },
  voice: { provider: "elevenlabs"|"azure", voiceId, wakeSensitivity, followUpWindowMs, sttProvider },
  screen: { mode: "off"|"on-demand"|"watch", intervalMs },
  hud: { transcriptOpen: boolean, listening: "always"|"single"|"off" },
  apps: AppPermission[]
}
```

Settings pages (behind the ⚙ icon): **Brain** (model, effort, session controls, token/cost meter), **Voice**, **Apps & Permissions**, **Screen**. Personality has no page; it lives in the settings object and is changed only by talking to him.

---

## 10. Delivery Roadmap

| Phase | Goal | Done when… |
|---|---|---|
| **0 — Foundation** (wk 1) | Monorepo; core `/ws` streaming via Anthropic SDK; transcript drawer with text input | You can type to J.A.R.V.I.S. in the drawer and see streamed replies in persona, addressed as "Sir". |
| **1 — The Orb** (wk 1–2) | R3F neural orb, rotation, bloom, glow bound to a test oscillator; activity indicator wired to `assistant.activity` | Orb floats, rotates, pulses at 60 fps; indicator flips between Thinking / Speaking on a text turn. |
| **2 — Voice loop** (wk 2–3) | Control dock (always / once); wake word → STT → Claude → streamed TTS → orb glow; barge-in; transcript prints in sync with speech | "Hey Jarvis, what time is it?" gets a spoken answer in < 1.5 s, the orb lights from within, the drawer shows the words as he says them. |
| **3 — Personality & Brain** (wk 3) | `set_personality` + `set_model` tools, web search ("Researching"), settings persistence, session history | "Switch to Sonnet" and "humor to 80" both work by voice and audibly change behaviour; "look up X" shows Researching. |
| **4 — Screen share** (wk 4) | View-screen button → display capture → vision | Press the icon, ask "What's wrong with the code on my screen?", get a correct answer. |
| **5 — Apps & Permissions** (wk 5–6) | MCP bridge, permission gate, Apps page, confirmations | Filesystem + GitHub work; disabling Write blocks writes; confirmations are spoken. |
| **6 — Polish** (ongoing) | Memory tool, cost meter, Deepgram STT, Tauri companion, PWA install | Daily-driver quality. |

Phases 0–2 are the MVP. Nothing in later phases changes the Phase 0–2 architecture.

---

## 11. Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Frontend | Vite + React 19 + TS | Fast HMR for 3D iteration; no SSR needed. |
| 3D | React Three Fiber + drei + postprocessing | Declarative Three.js; Bloom out of the box. |
| State | zustand (+ small state machine for the voice loop) | Minimal boilerplate; usable outside React (audio callbacks). |
| Backend | Node 22 + Fastify + `@anthropic-ai/sdk` | Same language as the front end; first-class SDK; MCP SDK is TS-native. |
| Transport | Single WebSocket | Bidirectional, binary audio frames, cancellation for barge-in. |
| Wake word | Porcupine (local WASM) | Private, accurate, already has "jarvis". |
| TTS | ElevenLabs streaming (Azure fallback) | Best naturalness + streaming latency; Azure for cost. |
| Storage | **`node:sqlite`** (Node 22 built-in) | Changed from better-sqlite3: that is a native module and node-gyp on Windows means Visual Studio Build Tools. The built-in module has zero install cost and the same synchronous API shape. |
| Binding | Core listens on `127.0.0.1` only, with a shared token on the WS handshake | Phase 5 gives this process filesystem **write** access. A `0.0.0.0` bind would hand every device on your network an unauthenticated agent with write access to your disk. |
| Validation | zod schemas shared across packages | One source of truth for settings/events. |
| App access | MCP servers behind a permission gate | Standard protocol, huge ecosystem, self-describing tools. |

---

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Voice not close enough to the film | Curate 3–4 candidate voices, A/B them on the same lines; tune stability/style; SSML prosody for Azure. Accept "in the spirit of" rather than identical. |
| IP (name, character) | Personal use only; keep a single `ASSISTANT_NAME` constant so rebranding is one line. |
| Latency > 1.5 s | Stream everything; sentence-level TTS; `effort: low` for chit-chat; Sonnet/Haiku for trivial turns; prompt caching on the persona prefix. |
| Wake-word false positives | Porcupine sensitivity slider; require a short pause after the keyword. |
| API key leakage | Keys only in `apps/core/.env`; the web app never calls vendors directly. |
| Runaway cost | Per-session token meter on the Brain page; daily budget with a spoken warning. |
| Browser mic/screen permissions | Serve over `localhost` or HTTPS; explain permission prompts on first run. |
| Tool misuse (writes) | Three-layer gate (§7.3); `confirmWrites` on by default for every app. |
| Indicator lies (says Thinking while idle) | Activity is derived from real stream events on core, never inferred by the UI; a watchdog resets to `idle` if no event arrives for 30 s. |
| **He hears himself** (always-listening + speakers) | Click/`Space` to interrupt is the primary path; wake word gated while audio plays; AEC constraints on; voice barge-in gated on spike S4. §4.4. |
| **Orphaned `tool_use` after an interrupt 400s the next turn** | Synthetic cancelled `tool_result` on every abort path. §3.5. |
| **Per-model 400s** (effort on Haiku, system messages on Sonnet) | Capability record per model in `brain/models.ts`; requests built through it. §3.1a. |
| **Core exposed on the LAN** | Bind `127.0.0.1`, shared-token WS handshake, origin check. |
| Tool runner can't stream or abort | Spike S5 decides this before Phase 0 code lands; fallback is a hand-written loop. |
| Screen share can't be started by Claude | User-gesture-only; tool reports "no active share" and he asks for one. §8. |

---

## 13. First Steps (Phase 0 checklist)
1. `pnpm init` workspace; scaffold `apps/web` (Vite React-TS) and `apps/core` (Fastify TS).
2. `packages/shared`: `Settings`, `AppPermission`, WS event schemas including `assistant.activity` (zod).
3. `apps/core`: `ANTHROPIC_API_KEY` in `.env`; `/ws` endpoint; `brain/persona.ts` with the banded prompt builder; `brain/chat.ts` using `client.messages.stream` on `claude-opus-5`, adaptive thinking, fallbacks enabled; emit `thinking` / `speaking` / `idle` activity.
4. `apps/web`: transcript drawer with text input that sends `user.utterance` and renders `assistant.delta`; activity line above it.
5. Smoke test: "Good evening, Jarvis." → indicator shows Thinking, then Speaking, streamed reply ending in "Sir."
