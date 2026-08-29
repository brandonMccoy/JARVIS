import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOLDERS_KEY, KNOWN_APPS, folderGrants, type AppPermission } from "@jarvis/shared";
import { listDir, readFile, search, writeFile, MAX_READ_BYTES } from "../src/fs/files.js";
import { ScopeError } from "../src/fs/scope.js";
import { FILESYSTEM_TOOLS } from "../src/brain/tools.js";

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fst-")));
  fs.writeFileSync(path.join(dir, "notes.txt"), "the meeting is on Thursday\nsecond line");
  fs.writeFileSync(path.join(dir, ".env"), "API_KEY=supersecret");
  fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "deep.md"), "buried treasure");
  return dir;
}

const ro = (p: string) => [{ path: p, write: false }];
const rw = (p: string) => [{ path: p, write: true }];

test("listing shows folders first and hides denied files", async () => {
  const dir = fixture();
  const { entries } = await listDir(ro(dir), dir);
  const names = entries.map((e) => e.name);
  assert.equal(names[0], "sub", "directories sort first");
  assert.ok(names.includes("notes.txt"));
  assert.ok(!names.includes(".env"), "a credential file must not even be listed");
});

test("reading a text file works; binary and secrets are refused", async () => {
  const dir = fixture();
  const { text } = await readFile(ro(dir), path.join(dir, "notes.txt"));
  assert.match(text, /meeting is on Thursday/);

  await assert.rejects(() => readFile(ro(dir), path.join(dir, "logo.png")), /binary/);
  // The message names the rule; the spoken form is what the user actually hears.
  await assert.rejects(
    () => readFile(ro(dir), path.join(dir, ".env")),
    (e: Error) => e instanceof ScopeError && /denylist/.test(e.message) && /credentials/.test(e.spoken),
  );
});

test("long files are truncated rather than returned whole", async () => {
  const dir = fixture();
  const big = path.join(dir, "big.txt");
  fs.writeFileSync(big, "x".repeat(MAX_READ_BYTES + 5000));
  const { text, truncated } = await readFile(ro(dir), big);
  assert.equal(truncated, true);
  assert.equal(text.length, MAX_READ_BYTES);
});

test("search finds content and filenames, and never surfaces denied files", async () => {
  const dir = fixture();

  const byContent = await search(ro(dir), "Thursday");
  assert.equal(byContent.matches.length, 1);
  assert.match(byContent.matches[0]!.file, /notes\.txt$/);

  const byName = await search(ro(dir), "deep");
  assert.ok(byName.matches.some((m) => m.file.endsWith("deep.md")), "recurses into subfolders");

  const secret = await search(ro(dir), "supersecret");
  assert.equal(secret.matches.length, 0, "a denied file must not be searchable either");
});

test("writing is refused on a read-only grant and works on a writable one", async () => {
  const dir = fixture();
  const target = path.join(dir, "new.txt");

  await assert.rejects(() => writeFile(ro(dir), target, "nope"), /read-only/);
  assert.equal(fs.existsSync(target), false, "nothing is written when the grant refuses");

  const res = await writeFile(rw(dir), target, "hello");
  assert.equal(res.existed, false);
  assert.equal(fs.readFileSync(target, "utf8"), "hello");

  const again = await writeFile(rw(dir), target, "replaced");
  assert.equal(again.existed, true);
  assert.equal(fs.readFileSync(target, "utf8"), "replaced");
});

test("an interrupted write leaves no stray temp files", async () => {
  const dir = fixture();
  await writeFile(rw(dir), path.join(dir, "atomic.txt"), "content");
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes("jarvis-") && n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("fs_write is declared but only offered when a folder is writable", () => {
  const names = FILESYSTEM_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["fs_list", "fs_read", "fs_search", "fs_write"]);

  // Mirrors Brain.filesystemTools(): the write tool is filtered out when no
  // grant permits writing, so Claude never sees a capability it cannot use.
  const offered = (grants: { path: string; write: boolean }[]) =>
    FILESYSTEM_TOOLS.filter((t) => grants.some((g) => g.write) || t.name !== "fs_write").map((t) => t.name);

  assert.ok(!offered(ro("/x")).includes("fs_write"));
  assert.ok(offered(rw("/x")).includes("fs_write"));
});

test("the filesystem app ships with no folders, so it grants nothing", () => {
  const app = KNOWN_APPS.find((a) => a.id === "filesystem");
  assert.ok(app);
  assert.deepEqual(folderGrants(app), []);
  assert.equal(app!.enabled, false);
});

test("a malformed scope yields no access rather than all access", () => {
  const bad: AppPermission[] = [
    { ...KNOWN_APPS[0]!, scope: { [FOLDERS_KEY]: "C:\\" } },
    { ...KNOWN_APPS[0]!, scope: { [FOLDERS_KEY]: [{ path: 5 }] } },
    { ...KNOWN_APPS[0]!, scope: {} },
  ];
  for (const app of bad) assert.deepEqual(folderGrants(app), []);
});
