import fs from "node:fs/promises";
import path from "node:path";
import type { FolderGrant } from "@jarvis/shared";

/**
 * The single choke point for filesystem access (docs/PLAN.md §7).
 *
 * No tool touches `node:fs` with a model-supplied path directly; every one of
 * them resolves through here first. One function to get right, one to test, and
 * nowhere else for a traversal bug to hide.
 *
 * The rules:
 *
 *  - **realpath first.** Symlinks and Windows junctions are resolved before any
 *    comparison, so a link inside a granted folder pointing at `C:\Users` is
 *    judged on where it lands, not where it sits.
 *  - **Segment-aware containment.** `path.relative` decides, not `startsWith`:
 *    a grant on `C:\proj` must not also grant `C:\proj-secrets`.
 *  - **Checked on every call.** Never cached, never validated only at the point
 *    the folder was added — a symlink can be created at any time afterwards.
 *  - **Writes need the parent.** The target may not exist yet, so containment is
 *    judged on its resolved parent directory.
 */

export type AccessMode = "read" | "write";

export class ScopeError extends Error {
  constructor(
    message: string,
    /** Phrasing meant to be spoken aloud — it never names a path outside scope. */
    readonly spoken: string,
  ) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Files that are readable by the OS but should not be read into a conversation
 * and sent to a model. Granting a project folder should not quietly hand over
 * the API keys that live in it.
 */
const DENIED = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.git[\\/]config$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|pfx|p12|keystore)$/i,
  /(^|[\\/])credentials\.json$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/i,
];

export function isDenied(absolute: string): boolean {
  return DENIED.some((re) => re.test(absolute));
}

/** Windows paths compare case-insensitively; POSIX ones do not. */
function fold(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** True when `target` is `root` or sits beneath it, by path segment. */
export function contains(root: string, target: string): boolean {
  const rel = path.relative(fold(root), fold(target));
  if (rel === "") return true; // the root itself
  return !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

/** realpath, falling back to the nearest existing ancestor for paths not yet created. */
async function realpathOfNearest(target: string): Promise<{ real: string; missing: string[] }> {
  const missing: string[] = [];
  let current = path.resolve(target);

  for (;;) {
    try {
      return { real: await fs.realpath(current), missing };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      // At a drive or filesystem root with nothing resolvable beneath it.
      if (parent === current) throw new Error(`No existing ancestor for ${target}`);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a model-supplied path against the granted folders, or throw.
 *
 * Returns the real, absolute path — callers must use *this*, never the input,
 * so that what was checked is what gets opened.
 */
export async function resolveWithin(
  grants: FolderGrant[],
  requested: string,
  mode: AccessMode,
): Promise<string> {
  if (!grants.length) {
    throw new ScopeError("no folders granted", "No folders have been shared with me yet.");
  }
  if (!requested.trim()) {
    throw new ScopeError("empty path", "I need a path to work with.");
  }

  let real: string;
  let missing: string[];
  try {
    ({ real, missing } = await realpathOfNearest(requested));
  } catch {
    throw new ScopeError(`cannot resolve ${requested}`, "I could not find that path.");
  }

  // Reads must land on something that exists; writes may create the last segment
  // but never a whole missing tree.
  if (mode === "read" && missing.length) {
    throw new ScopeError(`${requested} does not exist`, "That file does not exist.");
  }
  if (mode === "write" && missing.length > 1) {
    throw new ScopeError(`parent of ${requested} does not exist`, "That folder does not exist, so I cannot write there.");
  }

  const resolved = missing.length ? path.join(real, ...missing) : real;

  // Containment is judged on the *existing* part: `real` has been through
  // realpath, so symlinks are already collapsed. Appending a missing basename
  // cannot escape, because the parent is what was checked.
  const matching = await Promise.all(
    grants.map(async (g) => {
      try {
        return { grant: g, root: await fs.realpath(g.path) };
      } catch {
        return null; // a folder that has since been deleted or unmounted
      }
    }),
  );

  const holders = matching
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .filter((m) => contains(m.root, real));

  if (!holders.length) {
    throw new ScopeError(
      `${resolved} is outside every granted folder`,
      "That is outside the folders you have shared with me.",
    );
  }

  if (mode === "write" && !holders.some((h) => h.grant.write)) {
    throw new ScopeError(
      `${resolved} is in a read-only grant`,
      "That folder is read-only — you would need to allow writing to it first.",
    );
  }

  if (mode === "read" && isDenied(resolved)) {
    throw new ScopeError(
      `${resolved} matches the secrets denylist`,
      "That file looks like it holds credentials, so I have left it alone.",
    );
  }

  return resolved;
}
