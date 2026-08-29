import { z } from "zod";

/**
 * Account connections for the Calendar & Mail app (docs/CONNECTIONS.md).
 *
 * Only ever describes *status*. Access and refresh tokens live in core's
 * SQLite and never cross the WebSocket — the browser learns that a connection
 * exists, not what it is made of.
 */
export const ConnectionProviderSchema = z.enum(["google"]);
export type ConnectionProvider = z.infer<typeof ConnectionProviderSchema>;

export const ConnectionStatusSchema = z.enum([
  "unconfigured", // no OAuth client id/secret entered yet
  "disconnected", // client configured, nobody has consented
  "active",
  "expired", // refresh failed; needs re-consent
  "revoked", // withdrawn at the provider
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ConnectionStateSchema = z.object({
  provider: ConnectionProviderSchema,
  status: ConnectionStatusSchema,
  /** Which account consented, for display only. */
  account: z.string().optional(),
  /** Scopes the provider actually granted — not the ones requested. */
  scopes: z.array(z.string()).default([]),
  connectedAt: z.number().optional(),
  /** Last failure worth showing the user. */
  error: z.string().optional(),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

/** Read-only scope set for phase A. */
export const GOOGLE_SCOPES = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  mailRead: "https://www.googleapis.com/auth/gmail.readonly",
} as const;

export const DEFAULT_CONNECTIONS: ConnectionState[] = [
  { provider: "google", status: "unconfigured", scopes: [] },
];
