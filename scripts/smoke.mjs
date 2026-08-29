// End-to-end smoke test against a running core: node scripts/smoke.mjs
const BASE = "ws://127.0.0.1:8787/ws";
const TOKEN = process.env.JARVIS_TOKEN ?? "dev-local";

const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json());
console.log("health:", health);

// 1. Unauthorised connection is refused.
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE}?token=wrong`);
  ws.onclose = (e) => {
    console.log(`unauthorised close code: ${e.code}`);
    e.code === 4401 ? resolve() : reject(new Error("expected 4401"));
  };
  ws.onerror = () => {};
});

// 2. Authorised session.
const ws = new WebSocket(`${BASE}?token=${TOKEN}`);
const events = [];
const waiters = new Set();
ws.onmessage = (m) => {
  events.push(JSON.parse(m.data));
  for (const w of waiters) w();
};
const waitFor = (pred, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`timeout waiting: ${pred.toString().slice(0, 60)}`));
    }, ms);
    const check = () => {
      const hit = events.find(pred);
      if (!hit) return;
      clearTimeout(t);
      waiters.delete(check);
      resolve(hit);
    };
    waiters.add(check);
    check();
  });
await new Promise((r) => (ws.onopen = r));

const hello = await waitFor((e) => e.type === "hello");
console.log("hello: session", hello.sessionId.slice(0, 8), "anthropic:", hello.capabilities.anthropic, "history:", hello.history.length);

const send = (e) => ws.send(JSON.stringify(e));

// 3. Fast-path intent — no Claude needed.
send({ type: "user.utterance", text: "Jarvis, what time is it?", source: "text" });
const chunk = await waitFor((e) => e.type === "assistant.chunk");
console.log("fast-path chunk:", JSON.stringify(chunk.text), "audio:", Boolean(chunk.audio));
await waitFor((e) => e.type === "assistant.done");
const idle = await waitFor((e) => e.type === "assistant.activity" && e.activity.kind === "idle");
console.log("activity back to idle:", Boolean(idle));

// 4. Personality by voice.
events.length = 0;
send({ type: "user.utterance", text: "dial the humour up to eighty", source: "text" });
const settings = await waitFor((e) => e.type === "settings.changed");
console.log("humor now:", settings.settings.personality.humor);
await waitFor((e) => e.type === "assistant.done");

// 5. Model switch by voice + capability gate check.
events.length = 0;
send({ type: "user.utterance", text: "switch to haiku", source: "text" });
const sw = await waitFor((e) => e.type === "settings.changed");
console.log("model now:", sw.settings.brain.model);
await waitFor((e) => e.type === "assistant.done");

// 6. Open-ended question → Claude (or the keyless fallback line).
events.length = 0;
send({ type: "user.utterance", text: "Give me one sentence on why the sky is blue.", source: "text" });
const done = await waitFor((e) => e.type === "assistant.done", 60_000);
console.log("claude/fallback reply:", JSON.stringify(done.text.slice(0, 160)));
const acts = events.filter((e) => e.type === "assistant.activity").map((e) => e.activity.kind);
console.log("activity sequence:", acts.join(" → "));

// 7. Restore defaults.
send({ type: "settings.patch", patch: { brain: { model: "opus" }, personality: { humor: 45 } } });
await waitFor((e) => e.type === "settings.changed" && e.settings.brain.model === "opus");
console.log("restored defaults");
ws.close();
console.log("SMOKE OK");
process.exit(0);
