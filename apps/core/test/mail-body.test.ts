import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_APPS, MAIL_BODIES_KEY, mailBodiesEnabled, type AppPermission } from "@jarvis/shared";
import { extractBody } from "../src/connections/google.js";
import { CONNECTED_TOOLS } from "../src/brain/tools.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

test("a simple text/plain message yields its body", () => {
  const body = extractBody({ mimeType: "text/plain", body: { data: b64("Hello Sir.\r\nThe car is ready.") } });
  assert.equal(body, "Hello Sir.\nThe car is ready.");
});

test("multipart/alternative prefers the plain part over the HTML one", () => {
  const body = extractBody({
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64("plain version") } },
      { mimeType: "text/html", body: { data: b64("<p>html version</p>") } },
    ],
  });
  assert.equal(body, "plain version");
});

test("an HTML-only message is stripped to readable text", () => {
  const html = "<html><head><style>p{color:red}</style></head><body><p>Dinner at&nbsp;8 &amp; drinks</p><script>x()</script></body></html>";
  const body = extractBody({ mimeType: "text/html", body: { data: b64(html) } });
  assert.match(body, /Dinner at 8 & drinks/);
  assert.ok(!body.includes("color:red"), "style contents must not survive");
  assert.ok(!body.includes("x()"), "script contents must not survive");
  assert.ok(!body.includes("<"), "no markup should remain");
});

test("attachments are skipped even when their mime type matches", () => {
  const body = extractBody({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("ATTACHED FILE") } },
      { mimeType: "text/plain", body: { data: b64("the actual message") } },
    ],
  });
  assert.equal(body, "the actual message");
});

test("deeply nested parts are still found", () => {
  const body = extractBody({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "application/pdf", filename: "invoice.pdf", body: { data: b64("%PDF") } },
      {
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/plain", body: { data: b64("nested body") } }],
      },
    ],
  });
  assert.equal(body, "nested body");
});

test("a message with no text part yields empty rather than throwing", () => {
  assert.equal(extractBody({ mimeType: "image/png", body: { data: b64("PNG") } }), "");
  assert.equal(extractBody(undefined), "");
});

test("reading bodies is off by default and opt-in", () => {
  const calendar = KNOWN_APPS.find((a) => a.id === "calendar");
  assert.ok(calendar, "the calendar app should exist");
  assert.equal(mailBodiesEnabled(calendar), false, "bodies must default to off");
  assert.equal(mailBodiesEnabled(undefined), false);

  const on: AppPermission = { ...calendar!, scope: { [MAIL_BODIES_KEY]: true } };
  assert.equal(mailBodiesEnabled(on), true);

  // Anything other than an explicit true stays off.
  assert.equal(mailBodiesEnabled({ ...calendar!, scope: { [MAIL_BODIES_KEY]: "yes" } }), false);
  assert.equal(mailBodiesEnabled({ ...calendar!, scope: {} }), false);
});

test("mail_read is a declared tool and takes a message id", () => {
  const tool = CONNECTED_TOOLS.find((t) => t.name === "mail_read");
  assert.ok(tool, "mail_read should be declared");
  const schema = tool!.input_schema as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties?.id, "mail_read takes an id");
  assert.deepEqual(schema.required, ["id"]);
});
