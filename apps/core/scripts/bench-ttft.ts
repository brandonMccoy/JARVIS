/**
 * Spike S1 — Claude time-to-first-text-token bench.
 *   npm run bench:ttft -w @jarvis/core -- [turns=10] [models=opus,sonnet,haiku]
 * Writes a markdown table to stdout; paste into docs/measurements.md.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS, DEFAULT_SETTINGS, type ModelAlias } from "@jarvis/shared";
import { env } from "../src/config.js";
import { buildSystem } from "../src/brain/persona.js";

const turns = Number(process.argv[2] ?? 10);
const aliases = (process.argv[3] ?? "opus,sonnet,haiku").split(",") as ModelAlias[];
const prompts = [
  "What time is it in Tokyo right now, roughly?",
  "Give me one sentence on why the sky is blue.",
  "Should I use tabs or spaces?",
  "Remind me what a fibonacci sphere is.",
  "Any advice before I refactor a two thousand line file?",
];

if (!env.anthropicKey) {
  console.error("ANTHROPIC_API_KEY missing (apps/core/.env)");
  process.exit(1);
}
const client = new Anthropic({ apiKey: env.anthropicKey });
const system = buildSystem(DEFAULT_SETTINGS, { now: new Date(), screenShareActive: false, enabledApps: [], listening: "off" });

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

console.log(`| Model | Effort | Thinking | n | TTFT p50 ms | TTFT p95 ms | Total p50 ms |`);
console.log(`|---|---|---|---|---|---|---|`);

for (const alias of aliases) {
  const m = MODELS[alias];
  const configs: { effort?: "low" | "medium"; thinking: boolean }[] = m.supportsEffort
    ? [
        { effort: "low", thinking: true },
        { effort: "medium", thinking: true },
        ...(m.thinking === "always" ? [] : [{ effort: "low" as const, thinking: false }]),
      ]
    : [{ thinking: false }];
  for (const cfg of configs) {
    const ttft: number[] = [];
    const total: number[] = [];
    for (let i = 0; i < turns; i++) {
      const prompt = prompts[i % prompts.length]!;
      const t0 = Date.now();
      let first = 0;
      const params: Anthropic.Beta.MessageCreateParamsStreaming = {
        model: m.id,
        max_tokens: 600 + (cfg.thinking ? 2500 : 0),
        system,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        betas: [],
      };
      if (cfg.effort && m.supportsEffort) params.output_config = { effort: cfg.effort };
      if (cfg.thinking && m.thinking === "adaptive") params.thinking = { type: "adaptive" };
      if (!cfg.thinking && m.thinking === "adaptive") params.thinking = { type: "disabled" };
      const stream = client.beta.messages.stream(params);
      for await (const ev of stream) {
        if (!first && ev.type === "content_block_delta" && ev.delta.type === "text_delta") first = Date.now() - t0;
      }
      await stream.finalMessage();
      ttft.push(first);
      total.push(Date.now() - t0);
    }
    console.log(`| ${m.label} | ${cfg.effort ?? "n/a"} | ${cfg.thinking ? "on" : "off"} | ${turns} | ${pct(ttft, 50)} | ${pct(ttft, 95)} | ${pct(total, 50)} |`);
  }
}
