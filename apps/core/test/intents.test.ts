import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "@jarvis/shared";
import { matchIntent, parsePercent } from "../src/brain/intents.js";

const S = DEFAULT_SETTINGS;

test("parsePercent handles words and digits", () => {
  assert.equal(parsePercent("seventy"), 70);
  assert.equal(parsePercent("seventy five"), 75);
  assert.equal(parsePercent("75%"), 75);
  assert.equal(parsePercent("a hundred"), 100);
  assert.equal(parsePercent("half"), 50);
  assert.equal(parsePercent("banana"), undefined);
});

test("stop", () => {
  assert.equal(matchIntent("Jarvis, stop", S)?.kind, "stop");
  assert.equal(matchIntent("stop", S)?.kind, "stop");
  assert.equal(matchIntent("stop the music", S), null);
});

test("time is fast-pathed but timezone questions are not", () => {
  assert.equal(matchIntent("what time is it", S)?.kind, "time");
  assert.equal(matchIntent("hey jarvis what time is it", S)?.kind, "time");
  assert.equal(matchIntent("what time is it in Tokyo", S), null);
});

test("model switching", () => {
  const i = matchIntent("switch to sonnet", S);
  assert.equal(i?.kind, "switch_model");
  assert.equal(i?.kind === "switch_model" && i.alias, "sonnet");
  assert.equal(matchIntent("use haiku please", S)?.kind, "switch_model");
  assert.equal(matchIntent("tell me about sonnets", S), null);
});

test("personality dials", () => {
  const i = matchIntent("dial the humor up to seventy", S);
  assert.equal(i?.kind, "set_personality");
  assert.deepEqual(i?.kind === "set_personality" && i.patch, { personality: { humor: 70 } });
  const j = matchIntent("set honesty to 90", S);
  assert.deepEqual(j?.kind === "set_personality" && j.patch, { personality: { honesty: 90 } });
  assert.equal(matchIntent("I like humor", S), null);
});

test("new session and readback", () => {
  assert.equal(matchIntent("new session", S)?.kind, "new_session");
  assert.equal(matchIntent("what are your settings", S)?.kind, "read_settings");
});

test("open-ended questions fall through", () => {
  assert.equal(matchIntent("what's the weather like tomorrow", S), null);
  assert.equal(matchIntent("explain quantum tunnelling", S), null);
});
