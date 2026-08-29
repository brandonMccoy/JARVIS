import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Directory browsing for the folder picker in Settings.
 *
 * Deliberately *not* bound by the granted folders: this is the mechanism by
 * which folders get granted, so binding it to them would be circular. It is
 * reachable only over the authenticated loopback WebSocket, is never exposed
 * to Claude as a tool, and returns directory *names* only — never file
 * contents, and not even file names.
 */

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface Listing {
  path?: string;
  parent?: string;
  entries: BrowseEntry[];
  error?: string;
}

/** Where the picker opens: home, plus the drives on Windows. */
async function roots(): Promise<BrowseEntry[]> {
  const home = os.homedir();
  const entries: BrowseEntry[] = [{ name: `Home (${path.basename(home)})`, path: home }];

  if (process.platform === "win32") {
    const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const present = await Promise.all(
      letters.map(async (l) => {
        const root = `${l}:\\`;
        return (await fs.access(root).then(() => true).catch(() => false)) ? root : null;
      }),
    );
    for (const drive of present.filter((d): d is string => d !== null)) {
      entries.push({ name: drive, path: drive });
    }
  } else {
    entries.push({ name: "/", path: "/" });
  }
  return entries;
}

export async function browse(requested?: string): Promise<Listing> {
  if (!requested) return { entries: await roots() };

  let dir: string;
  try {
    dir = await fs.realpath(path.resolve(requested));
  } catch {
    return { entries: [], error: "That folder could not be opened." };
  }

  let found;
  try {
    found = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Permission denied is ordinary here — plenty of system folders are unreadable.
    return { path: dir, parent: parentOf(dir), entries: [], error: "That folder cannot be read." };
  }

  const entries = found
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { path: dir, parent: parentOf(dir), entries };
}

/** Undefined at a filesystem or drive root, so the picker can fall back to the roots list. */
function parentOf(dir: string): string | undefined {
  const parent = path.dirname(dir);
  return parent === dir ? undefined : parent;
}
