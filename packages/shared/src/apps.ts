import { z } from "zod";

/**
 * Per-app permission record (PLAN §7.2). Defaults are all-off.
 * Every app is an MCP server hosted by core; these flags decide which of its
 * tools Claude is allowed to see (visibility) and run (runtime gate).
 */
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

/** Apps known to the UI before any MCP server is wired (Phase 5). */
export const KNOWN_APPS: AppPermission[] = [
  { id: "filesystem", label: "Filesystem", enabled: false, read: true, write: false, confirmWrites: true, scope: { directories: [] } },
  { id: "github", label: "GitHub", enabled: false, read: true, write: false, confirmWrites: true },
  { id: "calendar", label: "Calendar & Mail", enabled: false, read: true, write: false, confirmWrites: true },
  { id: "browser", label: "Browser", enabled: false, read: true, write: false, confirmWrites: true },
];
