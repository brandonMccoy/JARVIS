# J.A.R.V.I.S. — Improvements Drawn From Similar Projects

Researched 2026-08-29. Sixteen improvements, each traced to a project that already does it, ranked by value against effort. Nothing here changes the architecture in `docs/PLAN.md`; each item names the phase and job it attaches to.

## Who was looked at

| Project | What it is | What it taught |
|---|---|---|
| **LiveKit Agents / Pipecat** | Production voice-agent frameworks | Semantic turn detection, adaptive interruption, backchannel handling, preemptive generation |
| **Hamming interruption runbook** | Field guide from voice-QA vendor | Per-utterance interrupt policy, recovery-state logging, the metrics that matter |
| **Home Assistant Assist (2026)** | Local voice pipeline for the smart home | Intent fast-path with no LLM round-trip, dual wake words, earcons, 2–4 s is "comparable to cloud" |
| **Leon** | Node/Python personal assistant, 17k★ | Layered memory, *progressive* tool loading so unrelated tools never reach a turn, environment awareness |
| **AILIS** | Desktop companion: VRM avatar + agent harness | Approval + audit *with evidence*, benchmark-driven evaluation, expressions tied to state |
| **Open Interpreter 01** | Voice interface for desktop / ESP32 | Phone-as-satellite to a home server, context accumulation while not actively listening |
| **Gemini Live / GPT-Live** | Commercial realtime assistants | Talk-while-watching screen share, full-duplex as the bar users now expect |
| **Anthropic computer use** | Claude driving a desktop by vision | The path to "native app access" without an MCP server per app |
| **Local JARVIS clones** (Couvbat, KDE Plasma JARVIS) | whisper.cpp + Piper + llama.cpp | A fully offline fallback is achievable and small |

---

## The list, ranked

| # | Improvement | Inspired by | Value | Effort | Lands in |
|---|---|---|---|---|---|
| 1 | Semantic end-of-turn detection | LiveKit turn-detector model | ★★★★★ | M | Phase 2 → replaces J2.9 |
| 2 | Intent fast-path without Claude | Home Assistant | ★★★★★ | M | Phase 2, new job |
| 3 | Earcons for acknowledge / listening / denied | Home Assistant, every commercial assistant | ★★★★☆ | S | Phase 2, new job |
| 4 | Backchannel-aware interruption + false-interrupt resume | LiveKit adaptive mode, Hamming | ★★★★☆ | M | Phase 2 → extends J2.17 |
| 5 | Preemptive generation on the interim transcript | LiveKit | ★★★★☆ | M | Phase 2, new job |
| 6 | Ambient context block (window, clipboard, next event, system) | Leon, AILIS | ★★★★☆ | M | Phase 3, new job |
| 7 | Progressive tool loading via tool search | Leon, Anthropic tool-search tool | ★★★★☆ | M | Phase 5 → extends J5.4 |
| 8 | Layered memory with "remember / forget" | Leon, AILIS | ★★★★☆ | L | Phase 6 → upgrades J6.4 |
| 9 | Per-utterance interrupt policy | Hamming | ★★★☆☆ | S | Phase 5 → extends J5.7 |
| 10 | "Show me what you did" — turn trace with evidence | AILIS | ★★★☆☆ | M | Phase 5 → extends J5.6 |
| 11 | Proactive mode with do-not-disturb | Companion apps, Razer AVA | ★★★☆☆ | L | Phase 6, new job |
| 12 | Talk-while-watching: cursor-attention crops | Gemini Live | ★★★☆☆ | M | Phase 4 → extends J4.8 |
| 13 | Voice-loop metrics + scripted conversation eval | Hamming, AILIS benchmarks | ★★★☆☆ | M | Phase 2/3 → extends J2.21, J3.11 |
| 14 | Speaker verification — he knows it's Sir | Picovoice Eagle; film fidelity | ★★★☆☆ | M | Phase 6, new job |
| 15 | Offline degraded mode (Whisper + Piper + local LLM) | HA stack, local JARVIS clones | ★★☆☆☆ | L | Phase 6, new job |
| 16 | Phone satellite over Tailscale | Open Interpreter 01, Leon Satellite | ★★☆☆☆ | L | Phase 6, new job |
| 17 | Computer-use path for native apps | Anthropic computer use, Leon | ★★★☆☆ | XL | Phase 7 (replaces the Tauri-per-app idea) |

---

## Details

### 1. Semantic end-of-turn detection — *the single biggest latency win available*
**What.** Replace "700 ms of silence means you're done" with a small transformer that reads the running transcript and decides whether the utterance is *complete*. LiveKit's open turn-detector model does this at ~20 ms inference and reports ~87% fewer mid-thought interruptions. When the text is obviously finished ("what time is it") the turn closes after ~150 ms of silence; when it isn't ("so what I want you to do is…") it waits.
**Why it matters here.** Our own latency table (PLAN §4.5) shows VAD silence is the *dominant fixed cost* — 400–700 ms of pure dead time on every turn. This attacks it directly, and simultaneously fixes the opposite failure (cutting you off when you pause to think), which a shorter VAD window would make worse.
**How.** Run the ONNX model in core on the interim transcript stream; combine with Silero VAD for the acoustic signal. Expose min/max delay settings like LiveKit (`min_delay` ≈ 150 ms, `max_delay` ≈ 1.2 s).
**Replaces** J2.9. Keep the plain VAD threshold as a fallback setting.

### 2. Intent fast-path — *answer simple things without asking Claude*
**What.** A deterministic layer in core that catches a small set of utterances and handles them in < 100 ms with a pre-rendered voice line: "stop", "louder/quieter", "what time is it", "new session", "switch to Sonnet", "humor to seventy", "mute", "are you there". Everything else goes to Claude.
**Why.** Home Assistant's design: built-in intents answer instantly, the LLM is only invoked for open-ended requests. It makes the assistant feel *reflexive*, which is exactly the film character — J.A.R.V.I.S. never pauses to think about "stop". It also removes cost and cache churn from the most frequent utterances.
**How.** A regex/grammar table in `core/brain/intents.ts`, with fixed replies rendered once by TTS and cached as audio. The transcript still logs them. Guard: if confidence is low, fall through to Claude rather than mis-firing.
**New job**, Phase 2. Also makes `set_model` / `set_personality` robust even when the model is slow.

### 3. Earcons — *sound design for the 600 ms nobody can engineer away*
**What.** Three or four short non-verbal sounds: wake-word accepted (soft rising chime), end-of-utterance captured (tick), permission denied / can't do that (low double tone), and a barely-audible "thinking" texture while he reasons.
**Why.** Our time-to-acknowledge target (≤ 600 ms) is what protects the feel, and an earcon lands in ~10 ms — faster than any orb animation or filler phrase and far less annoying than "One moment, Sir" on every turn. Every shipping assistant does this; the plan currently has none.
**How.** Pre-decoded `AudioBuffer`s played through the same output graph so the orb reacts to them too. Volume tied to the TTS volume setting.
**New job**, Phase 2, size S. Consider demoting the spoken filler (J2.18) to only fire past ~2 s once earcons exist.

### 4. Backchannel-aware interruption and false-interrupt resume
**What.** Distinguish "mm-hm", "yes", "okay", "go on" (backchannels — keep talking) from "no wait", "stop", or any multi-word utterance (real interruptions). When an interruption turns out to be false — the user said something short and then went silent — resume the paused speech instead of leaving dead air.
**Why.** Hamming: "the single most common complaint about bad voice agents is interruption handling — either the agent barrels on, or it stops on every breath." LiveKit ships this as `mode: "adaptive"` with a 2.0 s false-interruption timeout and `resume_false_interruption`.
**How.** Gate voice barge-in on `min_words ≥ 2` *or* a stop-word list; on false interrupt, resume the audio queue from the truncation point. Log false-interrupt and missed-interrupt rates separately (see #13).
**Extends** J2.17. Only relevant once voice barge-in is enabled at all (S4 verdict).

### 5. Preemptive generation on the interim transcript
**What.** Start the Claude request on the *interim* transcript as soon as the turn detector says the utterance is probably complete; if the final transcript matches, the response is already streaming; if not, abort and re-issue.
**Why.** Takes STT finalisation (100–300 ms) plus part of TTFT off the critical path. LiveKit ships this as preemptive generation. Combined with #1, this is how sub-1.5 s becomes plausible on Opus rather than only on Sonnet.
**Risk.** Wasted tokens on mismatches; keep a mismatch counter and disable automatically if it exceeds ~20%.
**New job**, Phase 2, after J2.15 (needs the abort path to be solid).

### 6. Ambient context block — *"Sir, your three o'clock is in ten minutes"*
**What.** A small, cheap `[CONTEXT]` section refreshed per turn: local time and day, active window title, clipboard text (opt-in, truncated), next calendar event, battery/CPU/network state, whether screen share is live.
**Why.** Leon calls it environment awareness: "answers stay grounded in what is actually happening on your machine." It's what makes "what's this?" or "remind me before that meeting" work without a screen share, and it's the cheapest route to film-accurate behaviour.
**How.** Core gathers it (Node `active-win`, clipboard via the web app's permission, calendar via the Phase 5 MCP). Placed *after* the cache breakpoint. Every field individually toggleable on the Voice/Brain settings page.
**New job**, Phase 3.

### 7. Progressive tool loading via tool search
**What.** Instead of sending every enabled app's tools on every turn, send a core set plus Anthropic's tool-search tool with the rest marked `defer_loading: true`; Claude pulls in what it needs.
**Why.** Leon's phrase: "without exposing its full tool surface to unrelated turns." Once five MCP servers are wired, that's 50–100 tool definitions on a "what time is it" turn — slower, costlier, and worse cache behaviour. Tool search keeps the prefix stable.
**How.** `tools: [tool_search_tool_regex, …core tools…, …deferred app tools…]`. Never defer *everything* (400). Permission filtering (J5.4) still runs first.
**Extends** J5.4.

### 8. Layered memory with explicit "remember / forget"
**What.** Three tiers, as Leon and AILIS both converge on: **durable preferences** ("I take my coffee black", model preference), **day-to-day context** (what you're working on this week), **recent discussion** (the current session). Plus spoken commands: "Jarvis, remember that…", "forget what I said about…", "what do you know about me?".
**Why.** Memory is what separates an assistant from a chatbot, and it's the top feature in every companion-app review. The plan had a single memory tool in Phase 6 with no structure.
**How.** Anthropic memory tool for the store, a nightly consolidation pass (Sonnet, `effort: low`) that promotes recurring facts upward and expires stale day-to-day items, and a visible "What I remember" page so nothing is hidden.
**Upgrades** J6.4.

### 9. Per-utterance interrupt policy
**What.** Tag each thing he says with an interruptibility class: *chat* (interrupt freely), *confirmation prompt* ("Shall I send that, Sir?" — patient endpointing, wait for a real yes/no), *reading back something you asked for* (interrupt allowed but resume offered), *warning* (finish the sentence).
**Why.** Hamming's core rule: "interrupt when the user's intent is more important than the current audio, and prove that decision in the logs." A confirmation cut off by a cough should not be treated as "no".
**Extends** J5.7 / J2.17. Size S once #4 exists.

### 10. "Show me what you did" — turn trace with evidence
**What.** For any turn that used tools, the transcript row expands into a trace: each tool call, its arguments digest, result summary, the screenshot he saw (if any), and timing. Spoken equivalent: "Jarvis, what did you just do?" reads it back.
**Why.** AILIS's design goal: "traceable progress and recoverable failures," with approval flows and evidence for consequential actions. The audit log (J5.6) stores this already; this is the surface that makes it *trustworthy* rather than a table in SQLite.
**Extends** J5.6 and the transcript drawer.

### 11. Proactive mode with do-not-disturb
**What.** He speaks *first* for a short allow-list of triggers: morning briefing when you first sit down, calendar event in N minutes, a long build/test run finishing, battery critical, "you've been in that meeting-free block for 3 hours". Hard DND toggle in the dock; quiet hours in settings; every proactive line logged.
**Why.** Every companion product (Replika, HakkoAI, Razer AVA) lists proactive engagement as the feature people actually feel. It's also the most film-accurate thing on this list. Must be opt-in per trigger or it becomes Clippy.
**How.** Core scheduler + event bus; triggers produce a *prompt* to Claude with the persona so the wording stays in character, not canned lines.
**New job**, Phase 6, size L.

### 12. Talk-while-watching: cursor-attention crops
**What.** During an active screen share, when you say "this function" / "that error" / "here", send a high-resolution crop around the mouse cursor alongside the downscaled full frame.
**Why.** Gemini Live's screen sharing works because you can *point*; a 1568 px downscale of a 4K monitor loses the line of code you mean. Cursor position is free.
**How.** Web sends cursor coords with each frame; core crops ~600 px around it at native resolution. Trigger on deictic words in the transcript or always when a share is live.
**Extends** J4.8 / J4.5.

### 13. Voice-loop metrics and a scripted conversation eval
**What.** Track, per session: false-interruption rate, missed-interruption rate, resume success, repeated-user-speech rate (a sign he mis-heard), time-to-acknowledge and time-to-first-word p50/p95. Plus a scripted 20-turn conversation replayed from audio files through the real pipeline as a regression test.
**Why.** Hamming lists exactly these as the metrics that predict user complaints; AILIS publishes benchmark scores for its harness. We have a persona check (J3.11) and a one-off latency run (J2.21); this makes them continuous.
**Extends** J2.19 / J2.21 / J3.11.

### 14. Speaker verification — he knows it's Sir
**What.** Enrol your voice once; the wake word only opens the mic for you, and he can address a second speaker differently ("I'm afraid I only take instructions from Sir").
**Why.** Film fidelity, and a real security property once Phase 5 gives him write access to your files — a visitor saying "Hey Jarvis, delete the downloads folder" should not work. Picovoice Eagle does on-device speaker recognition alongside Porcupine.
**New job**, Phase 6, size M.

### 15. Offline degraded mode
**What.** When the internet is down or privacy mode is on, fall back to whisper.cpp (STT), Piper (TTS, a British voice exists), and a small local model via Ollama for basic conversation and the intent fast-path. He warns you: "Running on local reasoning, Sir — I'm somewhat diminished."
**Why.** Home Assistant's 2026 stack and several JARVIS clones show this is a weekend of work, and it means the orb never goes dark. Also a privacy toggle for sensitive conversations.
**How.** The STT/TTS adapter interfaces (J2.8, J2.11) already exist for this; add a `LocalBrain` adapter behind the same chat interface.
**New job**, Phase 6, size L. Low priority until Phase 5 is done.

### 16. Phone satellite
**What.** A stripped web client on your phone (PWA) that is only a mic, speaker, and orb, connecting to core at home over Tailscale. "Hey Jarvis" from the garden.
**Why.** Open Interpreter's 01 app and Leon's Satellite both exist because a desktop-bound assistant stops being an assistant when you stand up.
**How.** The web app is already a thin client; this is a route with the transcript hidden and the dock reduced to one button. Auth is the existing token handshake; transport is Tailscale so nothing is exposed publicly.
**New job**, Phase 6, size L.

### 17. Computer-use path for native apps *(replaces the Tauri-per-app idea)*
**What.** For apps with no MCP server, let him drive them by vision: Anthropic's computer-use tools (screenshot, click, type) inside the same permission gate, with **visual verification** after each action (Leon's "verify visual outcomes").
**Why.** The plan's Phase 6 note assumed a Tauri companion exposing per-app integrations. Computer use makes that unnecessary for read-mostly tasks and covers arbitrary legacy apps. It's also the highest-risk feature on this list — every action is a write.
**How.** Requires the desktop companion for OS-level input anyway, so this is Phase 7. Gate: `write` permission on a virtual "Desktop" app, `confirmWrites` forced on, and a kill-switch (`Esc` twice).

---

## Adopted into the Build Board (2026-08-29)
Items **1, 2, 3, 4, 13** are now jobs in `docs/JOBS.md`: #1 rewrote J2.9 (and widened spike S3), #4 rewrote J2.17 and added J2.25, #2 is J2.22, #3 is J2.23, #13 is J2.24 + J3.13. Together they attack the two things the critique said matter most — dead time and perceived responsiveness.

## What I'd explicitly not copy
- **Full-duplex speech-to-speech** (GPT-Live). Claude has no realtime audio API; the cascade is right. Keep the TTS adapter boundary clean so a native speech model could plug in later, and stop there.
- **VRM/anime avatars** (AILIS, Utsuwa). The orb *is* the identity; expressions map to state, not a face.
- **Everything-is-a-skill plugin frameworks** (Leon, Naomi). MCP already is the plugin system; a second one is bureaucracy.

## Sources
- LiveKit turn detection docs — https://docs.livekit.io/agents/logic/turns/
- Hamming interruption runbook — https://hamming.ai/resources/voice-agent-interruption-handling-runbook
- Voice agent frameworks compared — https://soniox.com/wiki/voice-agent-frameworks
- Home Assistant local voice 2026 — https://insiderllm.com/guides/home-assistant-local-llm-guide/ and https://dev.to/kunal_d6a8fea2309e1571ee7/local-ai-voice-assistant-stack-2026-whisper-piper-ollama-wired-together-572l
- Leon — https://github.com/leon-ai/leon
- AILIS — https://github.com/haowenGuo/AILIS
- Open Interpreter 01 — https://github.com/OpenInterpreter/01 and https://github.com/openinterpreter/01-app
- Gemini Live vs GPT-Live — https://apidog.com/blog/gpt-live-vs-gemini-live/
- Anthropic computer use — https://www.digitalapplied.com/blog/anthropic-computer-use-api-guide
- Local JARVIS clones — https://github.com/Couvbat/Jarvis and https://github.com/novik133/jarvis
- Companion apps survey — https://github.com/topics/ai-companion and https://www.razer.com/razer-ava
