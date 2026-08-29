import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceChunker, cleanForSpeech } from "../src/voice/chunker.js";

function run(parts: string[]): string[] {
  const c = new SentenceChunker();
  const out: string[] = [];
  for (const p of parts) out.push(...c.push(p));
  const rest = c.flush();
  if (rest) out.push(rest);
  return out;
}

test("splits on sentence boundaries", () => {
  assert.deepEqual(run(["Good evening, Sir. ", "The workshop is ready. Shall we begin?"]), [
    "Good evening, Sir.",
    "The workshop is ready.",
    "Shall we begin?",
  ]);
});

test("does not split on abbreviations or decimals", () => {
  const out = run(["Dr. Banner called at 3.5 minutes past, e.g. just now. That is all."]);
  assert.deepEqual(out, ["Dr. Banner called at 3.5 minutes past, e.g. just now.", "That is all."]);
});

test("does not split inside code spans", () => {
  const out = run(["Run `npm test. then build`. Then rest."]);
  assert.deepEqual(out, ["Run npm test. then build.", "Then rest."]);
});

test("streams token by token", () => {
  const text = "One moment, Sir. I am checking the calendar now. Done.";
  const tokens = text.match(/.{1,3}/g) ?? [];
  assert.deepEqual(run(tokens), ["One moment, Sir.", "I am checking the calendar now.", "Done."]);
});

test("soft limit splits long clauses at a comma", () => {
  const long = "This is a very long clause that keeps going and going without any terminal punctuation at all, and then it continues for a while longer before it finally finishes with a full stop right here.";
  const out = run([long]);
  assert.ok(out.length >= 2);
  assert.ok(out.every((s) => s.length <= 320));
});

test("cleanForSpeech strips markdown", () => {
  assert.equal(cleanForSpeech("**Bold** and `code` and [link](http://x)"), "Bold and code and link");
  assert.equal(cleanForSpeech("- item one\n- item two"), "item one\nitem two");
});
