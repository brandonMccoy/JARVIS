import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOLDERS_KEY, KNOWN_APPS, folderGrants, type AppPermission } from "@jarvis/shared";
import { execFileSync } from "node:child_process";
import { createFolder, deleteEntry, listDir, readFile, renameEntry, search, writeFile, MAX_READ_BYTES } from "../src/fs/files.js";
import { recycleSupported } from "../src/fs/recycle.js";
import { ScopeError } from "../src/fs/scope.js";
import { FILESYSTEM_TOOLS, FS_WRITE_TOOLS } from "../src/brain/tools.js";

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

test("every disk-changing tool is withheld until a folder is writable", () => {
  const names = FILESYSTEM_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["fs_list", "fs_read", "fs_search", "fs_write", "fs_mkdir", "fs_rename", "fs_delete"]);
  assert.deepEqual([...FS_WRITE_TOOLS].sort(), ["fs_delete", "fs_mkdir", "fs_rename", "fs_write"]);

  // Mirrors Brain.filesystemTools(): write tools are filtered out when no grant
  // permits writing, so Claude never sees a capability it cannot use.
  const offered = (grants: { path: string; write: boolean }[]) =>
    FILESYSTEM_TOOLS.filter((t) => grants.some((g) => g.write) || !FS_WRITE_TOOLS.has(t.name)).map((t) => t.name);

  assert.deepEqual(offered(ro("/x")), ["fs_list", "fs_read", "fs_search"], "read-only grants offer no way to change the disk");
  assert.deepEqual(offered(rw("/x")), names);
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

// ---------------------------------------------------------------------------
// Rename and delete
// ---------------------------------------------------------------------------

test("rename moves a file and refuses to clobber an existing one", async () => {
  const dir = fixture();
  const from = path.join(dir, "notes.txt");
  const to = path.join(dir, "renamed.txt");

  const res = await renameEntry(rw(dir), from, to);
  assert.equal(res.to, to);
  assert.equal(fs.existsSync(from), false);
  assert.match(fs.readFileSync(to, "utf8"), /meeting is on Thursday/);

  fs.writeFileSync(path.join(dir, "other.txt"), "existing");
  await assert.rejects(() => renameEntry(rw(dir), to, path.join(dir, "other.txt")), /already exists/);
  assert.equal(fs.readFileSync(path.join(dir, "other.txt"), "utf8"), "existing", "the target is untouched");
});

test("rename is refused on a read-only grant and outside the grant", async () => {
  const dir = fixture();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-out-")));

  await assert.rejects(() => renameEntry(ro(dir), path.join(dir, "notes.txt"), path.join(dir, "x.txt")), /read-only/);
  // A writable grant still cannot move a file out of the shared folders.
  await assert.rejects(
    () => renameEntry(rw(dir), path.join(dir, "notes.txt"), path.join(outside, "escaped.txt")),
    /outside every granted folder/,
  );
  assert.equal(fs.existsSync(path.join(dir, "notes.txt")), true);
});

test("neither delete nor rename can remove a shared folder root", async () => {
  const dir = fixture();
  await assert.rejects(() => deleteEntry(rw(dir), dir), /shared folder root/);
  await assert.rejects(() => renameEntry(rw(dir), dir, `${dir}-moved`), /shared folder root/);
  assert.equal(fs.existsSync(dir), true);
});

test("delete is refused on a read-only grant", async () => {
  const dir = fixture();
  const target = path.join(dir, "notes.txt");
  await assert.rejects(() => deleteEntry(ro(dir), target), /read-only/);
  assert.equal(fs.existsSync(target), true, "nothing is removed when the grant refuses");
});

test("credential files cannot be overwritten, renamed or deleted either", async () => {
  const dir = fixture();
  const env = path.join(dir, ".env");
  await assert.rejects(() => writeFile(rw(dir), env, "clobbered"), /denylist/);
  await assert.rejects(() => deleteEntry(rw(dir), env), /denylist/);
  await assert.rejects(() => renameEntry(rw(dir), env, path.join(dir, "moved.txt")), /denylist/);
  assert.equal(fs.readFileSync(env, "utf8").trim(), "API_KEY=supersecret", "the file is untouched");
});

test("a deleted file leaves the disk and arrives in the Recycle Bin", { skip: !recycleSupported() }, async () => {
  const dir = fixture();
  const marker = `jarvis-recycle-${Date.now()}`;
  const target = path.join(dir, `${marker}.txt`);
  fs.writeFileSync(target, "recover me");

  const res = await deleteEntry(rw(dir), target);
  assert.equal(res.kind, "file");
  assert.equal(fs.existsSync(target), false, "it is gone from disk");

  // The point of the feature: it must be recoverable, not merely absent.
  const bin = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s=(New-Object -ComObject Shell.Application).Namespace(0xA); $s.Items() | ForEach-Object { $_.Name }",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.ok(bin.includes(marker), "the deleted file should be restorable from the Recycle Bin");
});

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

test("creating a folder works, and refuses to clobber an existing one", async () => {
  const dir = fixture();
  const made = path.join(dir, "Recipes");

  const res = await createFolder(rw(dir), made);
  assert.equal(res.path, made);
  assert.equal(fs.statSync(made).isDirectory(), true);

  await assert.rejects(() => createFolder(rw(dir), made), /already exists/);
  await assert.rejects(() => createFolder(rw(dir), path.join(dir, "sub")), /already exists/);
});

test("creating a folder needs a writable grant and an existing parent", async () => {
  const dir = fixture();
  await assert.rejects(() => createFolder(ro(dir), path.join(dir, "Nope")), /read-only/);
  assert.equal(fs.existsSync(path.join(dir, "Nope")), false);

  // Nested creation is two calls: the parent must exist first.
  await assert.rejects(() => createFolder(rw(dir), path.join(dir, "a", "b")), /parent of .* does not exist/);

  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-out-")));
  await assert.rejects(() => createFolder(rw(dir), path.join(outside, "x")), /outside every granted folder/);
});

test("a folder can be created, renamed and then recycled", { skip: !recycleSupported() }, async () => {
  const dir = fixture();
  const marker = `jarvis-folder-${Date.now()}`;
  const first = path.join(dir, `${marker}-old`);
  const renamed = path.join(dir, marker);

  await createFolder(rw(dir), first);
  fs.writeFileSync(path.join(first, "inside.txt"), "contents come along");

  await renameEntry(rw(dir), first, renamed);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(path.join(renamed, "inside.txt"), "utf8"), "contents come along");

  // DeleteDirectory is a different branch of the PowerShell script to
  // DeleteFile, so the folder path is asserted separately.
  const res = await deleteEntry(rw(dir), renamed);
  assert.equal(res.kind, "folder");
  assert.equal(fs.existsSync(renamed), false);

  const bin = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s=(New-Object -ComObject Shell.Application).Namespace(0xA); $s.Items() | ForEach-Object { $_.Name }",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.ok(bin.includes(marker), "a deleted folder should be restorable from the Recycle Bin too");
});
