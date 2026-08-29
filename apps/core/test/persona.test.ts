import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, applySettingsPatch } from "@jarvis/shared";
import { buildSystem } from "../src/brain/persona.js";

const ctx = { now: new Date("2026-08-29T20:00:00"), screenShareActive: false, enabledApps: [], listening: "off" as const };

test("stable prefix carries cache_control and honorific", () => {
  const blocks = buildSystem(DEFAULT_SETTINGS, ctx);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0]?.cache_control, { type: "ephemeral" });
  assert.ok(blocks[0]?.text.includes('"Sir"'));
  assert.ok(!blocks[0]?.text.includes("{{HONORIFIC}}"));
});

test("stable prefix does not change when dials change", () => {
  const a = buildSystem(DEFAULT_SETTINGS, ctx)[0]!.text;
  const b = buildSystem(applySettingsPatch(DEFAULT_SETTINGS, { personality: { humor: 100, honesty: 0 } }), ctx)[0]!.text;
  assert.equal(a, b);
});

test("dials map to prose bands", () => {
  const low = buildSystem(applySettingsPatch(DEFAULT_SETTINGS, { personality: { humor: 5, honesty: 5 } }), ctx)[1]!.text;
  const high = buildSystem(applySettingsPatch(DEFAULT_SETTINGS, { personality: { humor: 95, honesty: 95 } }), ctx)[1]!.text;
  assert.ok(low.includes("Wit setting: none"));
  assert.ok(low.includes("diplomatic to a fault"));
  assert.ok(high.includes("relentlessly droll"));
  assert.ok(high.includes("unvarnished"));
});

test("screen share state is reflected", () => {
  const off = buildSystem(DEFAULT_SETTINGS, ctx)[1]!.text;
  const on = buildSystem(DEFAULT_SETTINGS, { ...ctx, screenShareActive: true })[1]!.text;
  assert.ok(off.includes("No screen share is active"));
  assert.ok(on.includes("A screen share is active"));
});
