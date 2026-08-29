import { z } from "zod";

/**
 * Per-app permission record (PLAN §7.2). Defaults are all-off.
 * Every app is an MCP server hosted by core; these flags decide which of its
 * tools Claude is allowed to see (visibility) and run (runtime gate).
 */
/**
 * One granted folder for the Filesystem app.
 *
 * A grant is recursive: it covers the folder and everything beneath it. Write
 * is per folder rather than per app, so read-only and writable folders can sit
 * side by side — which is why the Filesystem card has no Read/Write chips and
 * no confirm-writes checkbox. The decision is made once, while looking at the
 * list, instead of as a prompt before every write that trains you to say yes.
 */
export const FolderGrantSchema = z.object({
  /** Absolute, as resolved by core — never as typed. */
  path: z.string().min(1),
  write: z.boolean().default(false),
});

export type FolderGrant = z.infer<typeof FolderGrantSchema>;

export const FOLDERS_KEY = "folders";

/** Grants for the Filesystem app. Unparseable scope means no access, never all access. */
export function folderGrants(app: AppPermission | undefined): FolderGrant[] {
  const parsed = z.array(FolderGrantSchema).safeParse(app?.scope?.[FOLDERS_KEY]);
  return parsed.success ? parsed.data : [];
}

export const AppPermissionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean().default(false),
  read: z.boolean().default(true),
  write: z.boolean().default(false),
  confirmWrites: z.boolean().default(true),
  scope: z.record(z.string(), z.unknown()).optional(),
});

export type AppPermission = z.infer<typeof AppPermissionSchema>;

/**
 * Whether Claude may fetch the *body* of a mail message, not just its headers
 * and Gmail's own snippet (docs/CONNECTIONS.md §8).
 *
 * This is off by default and deliberately separate from the app's `read` flag.
 * Reading who wrote and roughly what about is a much smaller disclosure than
 * reading the message itself, and bodies are what reach the Anthropic API when
 * a question needs them — so it gets its own switch and its own confirmation.
 *
 * It lives in the calendar app's free-form `scope` rather than as a new
 * top-level setting, alongside the filesystem app's `directories`.
 */
export const MAIL_BODIES_KEY = "mailBodies";

export function mailBodiesEnabled(app: AppPermission | undefined): boolean {
  return app?.scope?.[MAIL_BODIES_KEY] === true;
}

/** Apps known to the UI before any MCP server is wired (Phase 5). */
export const KNOWN_APPS: AppPermission[] = [
  // read/write/confirmWrites are inert for this app — access is per folder.
  { id: "filesystem", label: "Filesystem", enabled: false, read: true, write: false, confirmWrites: true, scope: { [FOLDERS_KEY]: [] } },
  { id: "github", label: "GitHub", enabled: false, read: true, write: false, confirmWrites: true },
  { id: "calendar", label: "Calendar & Mail", enabled: false, read: true, write: false, confirmWrites: true, scope: { [MAIL_BODIES_KEY]: false } },
  { id: "browser", label: "Browser", enabled: false, read: true, write: false, confirmWrites: true },
];
