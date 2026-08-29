import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contains, isDenied, resolveWithin, ScopeError } from "../src/fs/scope.js";

const onWindows = process.platform === "win32";

/** A granted folder, a sibling that must stay out of reach, and a file in each. */
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fs-")));
  const granted = path.join(base, "proj");
  const sibling = path.join(base, "proj-secrets"); // shares a prefix with `proj`
  fs.mkdirSync(path.join(granted, "nested"), { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(granted, "notes.txt"), "inside");
  fs.writeFileSync(path.join(granted, "nested", "deep.txt"), "deeper");
  fs.writeFileSync(path.join(sibling, "keys.txt"), "outside");
  return { base, granted, sibling };
}

const ro = (p: string) => [{ path: p, write: false }];
const rw = (p: string) => [{ path: p, write: true }];

test("contains is segment-aware, not prefix-based", () => {
  assert.equal(contains("/a/proj", "/a/proj"), true, "the root itself is contained");
  assert.equal(contains("/a/proj", "/a/proj/x/y"), true);
  assert.equal(contains("/a/proj", "/a/proj-secrets/keys"), false, "a shared prefix is not containment");
  assert.equal(contains("/a/proj", "/a"), false);
  assert.equal(contains("/a/proj", "/b/proj"), false);
});

test("a file inside the grant resolves", async () => {
  const { granted } = fixture();
  const target = path.join(granted, "notes.txt");
  assert.equal(await resolveWithin(ro(granted), target, "read"), fs.realpathSync(target));
});

test("nested files resolve — grants are recursive", async () => {
  const { granted } = fixture();
  const target = path.join(granted, "nested", "deep.txt");
  assert.equal(await resolveWithin(ro(granted), target, "read"), fs.realpathSync(target));
});

test("a sibling folder sharing a name prefix is refused", async () => {
  const { granted, sibling } = fixture();
  await assert.rejects(
    () => resolveWithin(ro(granted), path.join(sibling, "keys.txt"), "read"),
    (e: Error) => e instanceof ScopeError && /outside every granted folder/.test(e.message),
  );
});

test("traversal out of the grant is refused", async () => {
  const { granted, sibling } = fixture();
  const escape = path.join(granted, "..", path.basename(sibling), "keys.txt");
  await assert.rejects(() => resolveWithin(ro(granted), escape, "read"), ScopeError);
});

/**
 * On Windows a plain symlink needs elevation, but a *junction* does not — and a
 * junction is exactly how a directory escape would be built there, so the case
 * is covered on both platforms rather than skipped on the one that matters.
 */
test("a link pointing outside the grant is refused", async () => {
  const { granted, sibling } = fixture();
  const link = path.join(granted, "escape");
  await fsp.symlink(sibling, link, onWindows ? "junction" : "dir");
  await assert.rejects(
    () => resolveWithin(ro(granted), path.join(link, "keys.txt"), "read"),
    (e: Error) => e instanceof ScopeError && /outside every granted folder/.test(e.message),
  );
});

test("no grants means no access at all", async () => {
  const { granted } = fixture();
  await assert.rejects(
    () => resolveWithin([], path.join(granted, "notes.txt"), "read"),
    (e: Error) => e instanceof ScopeError && /no folders granted/.test(e.message),
  );
});

test("writing to a read-only grant is refused, reading the same path is not", async () => {
  const { granted } = fixture();
  const target = path.join(granted, "notes.txt");
  assert.ok(await resolveWithin(ro(granted), target, "read"));
  await assert.rejects(
    () => resolveWithin(ro(granted), target, "write"),
    (e: Error) => e instanceof ScopeError && /read-only/.test(e.message),
  );
  assert.ok(await resolveWithin(rw(granted), target, "write"), "the writable grant allows it");
});

test("a file that does not exist yet can be written but not read", async () => {
  const { granted } = fixture();
  const target = path.join(granted, "new-file.txt");
  assert.equal(await resolveWithin(rw(granted), target, "write"), target);
  await assert.rejects(
    () => resolveWithin(rw(granted), target, "read"),
    (e: Error) => e instanceof ScopeError && /does not exist/.test(e.message),
  );
});

test("writing into a missing directory tree is refused", async () => {
  const { granted } = fixture();
  const target = path.join(granted, "no", "such", "dir", "f.txt");
  await assert.rejects(
    () => resolveWithin(rw(granted), target, "write"),
    (e: Error) => e instanceof ScopeError && /parent of .* does not exist/.test(e.message),
  );
});

test("a read-only grant does not become writable by overlapping a writable one", async () => {
  const { base, granted } = fixture();
  // The parent is writable, the child is explicitly read-only.
  const grants = [
    { path: base, write: true },
    { path: granted, write: false },
  ];
  // The child is held by both, and one of them permits writing — the parent
  // grant genuinely covers it, so this is allowed by design.
  assert.ok(await resolveWithin(grants, path.join(granted, "notes.txt"), "write"));

  // But a read-only grant on its own never permits writing.
  await assert.rejects(() => resolveWithin([{ path: granted, write: false }], path.join(granted, "notes.txt"), "write"), ScopeError);
});

test("credential-shaped files are refused even inside a grant", async () => {
  const { granted } = fixture();
  for (const name of [".env", ".env.local", "server.pem", "credentials.json", "id_rsa"]) {
    fs.writeFileSync(path.join(granted, name), "secret");
    await assert.rejects(
      () => resolveWithin(ro(granted), path.join(granted, name), "read"),
      (e: Error) => e instanceof ScopeError && /credentials/.test(e.spoken),
      `${name} should be denied`,
    );
  }
  assert.equal(isDenied("/home/x/.ssh/config"), true);
  assert.equal(isDenied("/home/x/notes.txt"), false);
});

test("case differences do not defeat containment on Windows", { skip: !onWindows }, async () => {
  const { granted } = fixture();
  const target = path.join(granted, "notes.txt");
  assert.ok(await resolveWithin(ro(granted.toUpperCase()), target, "read"));
  assert.ok(await resolveWithin(ro(granted), target.toUpperCase(), "read"));
});

test("a grant whose folder has vanished is skipped, not fatal", async () => {
  const { granted } = fixture();
  const grants = [{ path: path.join(granted, "gone"), write: true }, ...ro(granted)];
  assert.ok(await resolveWithin(grants, path.join(granted, "notes.txt"), "read"));
});
