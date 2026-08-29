import fs from "node:fs/promises";
import path from "node:path";
import type { FolderGrant } from "@jarvis/shared";
import { isDenied, resolveWithin } from "./scope.js";

/**
 * File operations for the Filesystem app. Every one of them resolves through
 * `resolveWithin` first and then works on the *resolved* path, never the
 * requested one — what was checked is what gets opened.
 */

/** A voice assistant reads results aloud; whole files are neither useful nor affordable. */
export const MAX_READ_BYTES = 100_000;
export const MAX_ENTRIES = 500;
export const MAX_MATCHES = 50;

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
  size?: number;
}

export async function listDir(grants: FolderGrant[], requested: string): Promise<{ path: string; entries: DirEntry[]; truncated: boolean }> {
  const dir = await resolveWithin(grants, requested, "read");
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error(`${requested} is a file, not a folder.`);

  const found = await fs.readdir(dir, { withFileTypes: true });
  const visible = found.filter((e) => !isDenied(path.join(dir, e.name)));
  const truncated = visible.length > MAX_ENTRIES;

  const entries = await Promise.all(
    visible.slice(0, MAX_ENTRIES).map(async (e): Promise<DirEntry> => {
      if (e.isDirectory()) return { name: e.name, kind: "dir" };
      const s = await fs.stat(path.join(dir, e.name)).catch(() => null);
      return { name: e.name, kind: "file", size: s?.size };
    }),
  );

  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { path: dir, entries, truncated };
}

/** Null bytes in the first few KB is the usual heuristic, and good enough here. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 4096).includes(0);
}

export async function readFile(
  grants: FolderGrant[],
  requested: string,
): Promise<{ path: string; text: string; truncated: boolean }> {
  const file = await resolveWithin(grants, requested, "read");
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new Error(`${requested} is a folder, not a file.`);

  const handle = await fs.open(file, "r");
  try {
    // Read one byte past the cap so truncation is detectable without loading
    // a gigabyte to discover it was a gigabyte.
    const buf = Buffer.alloc(MAX_READ_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytesRead);
    if (looksBinary(slice)) throw new Error(`${path.basename(file)} is a binary file, so there is nothing to read out.`);
    const truncated = bytesRead > MAX_READ_BYTES;
    return { path: file, text: slice.subarray(0, MAX_READ_BYTES).toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

export interface Match {
  file: string;
  line: number;
  text: string;
}

/**
 * Walk the granted folders looking for a name or a line of content.
 *
 * Deliberately simple: no index, no ripgrep dependency, and it stops at
 * MAX_MATCHES. Denied files are skipped so a search can never surface the
 * contents of a `.env` the direct read would have refused.
 */
export async function search(
  grants: FolderGrant[],
  query: string,
  root?: string,
): Promise<{ matches: Match[]; truncated: boolean }> {
  const roots = root ? [await resolveWithin(grants, root, "read")] : grants.map((g) => g.path);
  const needle = query.toLowerCase();
  const matches: Match[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (matches.length >= MAX_MATCHES || depth > 8) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const e of entries) {
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        return;
      }
      const full = path.join(dir, e.name);
      if (isDenied(full)) continue;
      if (e.isSymbolicLink()) continue; // the walk stays inside what it was given
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await walk(full, depth + 1);
        continue;
      }
      if (e.name.toLowerCase().includes(needle)) {
        matches.push({ file: full, line: 0, text: "(filename match)" });
        continue;
      }
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > MAX_READ_BYTES) continue;
      const buf = await fs.readFile(full).catch(() => null);
      if (!buf || looksBinary(buf)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.toLowerCase().includes(needle)) continue;
        matches.push({ file: full, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
        break; // one hit per file keeps the spoken answer usable
      }
    }
  };

  for (const r of roots) {
    const real = await fs.realpath(r).catch(() => null);
    if (real) await walk(real, 0);
  }
  return { matches, truncated };
}

/**
 * Write a file, atomically.
 *
 * Temp file plus rename, so an interrupted write leaves the previous contents
 * intact rather than a half-written file. The temp file is created beside the
 * target so the rename stays on one volume.
 */
export async function writeFile(
  grants: FolderGrant[],
  requested: string,
  content: string,
): Promise<{ path: string; bytes: number; existed: boolean }> {
  const file = await resolveWithin(grants, requested, "write");
  const existed = await fs
    .stat(file)
    .then((s) => {
      if (s.isDirectory()) throw new Error(`${requested} is a folder.`);
      return true;
    })
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return false;
      throw e;
    });

  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.jarvis-${process.pid}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  return { path: file, bytes: Buffer.byteLength(content, "utf8"), existed };
}
