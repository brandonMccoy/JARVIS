import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  applySettingsPatch,
  MODELS,
  findSpokenModel,
  parseClientEvent,
  parseServerEvent,
} from "../src/index.js";

test("default settings validate", () => {
  assert.equal(DEFAULT_SETTINGS.brain.model, "opus");
  assert.equal(DEFAULT_SETTINGS.personality.honorific, "Sir");
  assert.equal(DEFAULT_SETTINGS.apps.every((a) => a.enabled === false), true);
});

test("invalid settings are rejected", () => {
  assert.throws(() => SettingsSchema.parse({ ...DEFAULT_SETTINGS, personality: { honesty: 150, humor: 0, honorific: "Sir" } }));
});

test("patch merges deeply and revalidates", () => {
  const next = applySettingsPatch(DEFAULT_SETTINGS, { personality: { humor: 90 } });
  assert.equal(next.personality.humor, 90);
  assert.equal(next.personality.honesty, DEFAULT_SETTINGS.personality.honesty);
  assert.throws(() => applySettingsPatch(DEFAULT_SETTINGS, { personality: { humor: -1 } }));
});

test("haiku capability record is gated", () => {
  assert.equal(MODELS.haiku.supportsEffort, false);
  assert.equal(MODELS.haiku.webSearchToolType, "web_search_20250305");
  assert.equal(MODELS.sonnet.supportsMidConvSystem, false);
  assert.equal(MODELS.opus.supportsMidConvSystem, true);
});

test("spoken model detection", () => {
  assert.equal(findSpokenModel("Jarvis, switch to Sonnet please"), "sonnet");
  assert.equal(findSpokenModel("use haiku"), "haiku");
  assert.equal(findSpokenModel("what time is it"), undefined);
});

test("events round-trip", () => {
  const c = parseClientEvent({ type: "user.utterance", text: "hello" });
  assert.equal(c.type, "user.utterance");
  const s = parseServerEvent({ type: "assistant.activity", activity: { kind: "thinking" } });
  assert.equal(s.type, "assistant.activity");
  assert.throws(() => parseClientEvent({ type: "nope" }));
});
