import { GOOGLE_SCOPES } from "@jarvis/shared";

/**
 * Google endpoints and the read-only API surface (docs/CONNECTIONS.md).
 *
 * Phase A is read-only on purpose: `calendar.readonly` is a *sensitive* scope,
 * while Gmail's are *restricted*. Both work unverified for personal use, but
 * the project must be published "In production" rather than left in "Testing",
 * or Google expires the refresh token after 7 days.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3";
const GMAIL_URL = "https://gmail.googleapis.com/gmail/v1";

export const READONLY_SCOPES = [GOOGLE_SCOPES.email, GOOGLE_SCOPES.calendarRead, GOOGLE_SCOPES.mailRead];

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes: string[];
}): string {
  const q = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scopes.join(" "),
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
    // Without both of these Google returns no refresh token on a repeat
    // authorization — a silent failure that looks like it worked.
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new OAuthError(json.error ?? `http_${res.status}`, json.error_description ?? res.statusText);
  }
  return json;
}

/** Distinguishes "needs re-consent" from transient network trouble. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
  /** `invalid_grant` means the refresh token is dead — only re-consent fixes it. */
  get needsReconsent(): boolean {
    return this.code === "invalid_grant";
  }
}

function toTokenSet(res: TokenResponse, fallbackScopes: string[]): TokenSet {
  if (!res.access_token) throw new OAuthError("no_access_token", "The provider returned no access token.");
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    // 60s of slack so a call never starts with a token about to expire.
    expiresAt: Date.now() + Math.max(0, (res.expires_in ?? 3600) - 60) * 1000,
    scopes: res.scope ? res.scope.split(" ") : fallbackScopes,
  };
}

export async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<TokenSet> {
  const res = await postToken(
    new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      code_verifier: params.verifier,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
    }),
  );
  return toTokenSet(res, []);
}

export async function refreshTokens(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  knownScopes: string[];
}): Promise<TokenSet> {
  const res = await postToken(
    new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
      grant_type: "refresh_token",
    }),
  );
  // A refresh response usually omits refresh_token; keep the one we hold.
  return { ...toTokenSet(res, params.knownScopes), refreshToken: res.refresh_token ?? params.refreshToken };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined); // best effort; local state is cleared regardless
}

async function apiGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) throw new OAuthError("invalid_grant", "The access token was rejected.");
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new OAuthError("forbidden", body.error?.message ?? "Access to that resource was refused.");
  }
  if (!res.ok) throw new OAuthError(`http_${res.status}`, `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function fetchAccountEmail(accessToken: string): Promise<string | undefined> {
  try {
    const me = await apiGet<{ email?: string }>(USERINFO_URL, accessToken);
    return me.email;
  } catch {
    return undefined; // display-only; never fail a connection over this
  }
}

// ---------------------------------------------------------------------------
// Calendar (read-only)
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  summary: string;
  start?: string;
  end?: string;
  allDay: boolean;
  location?: string;
}

interface RawEvent {
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export async function listEvents(
  accessToken: string,
  params: { timeMin: Date; timeMax: Date; maxResults?: number },
): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({
    timeMin: params.timeMin.toISOString(),
    timeMax: params.timeMax.toISOString(),
    singleEvents: "true", // expand recurrence, else you get the rule not the instances
    orderBy: "startTime",
    maxResults: String(params.maxResults ?? 25),
  });
  const data = await apiGet<{ items?: RawEvent[] }>(`${CALENDAR_URL}/calendars/primary/events?${q}`, accessToken);
  return (data.items ?? []).map((e) => ({
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location,
  }));
}

// ---------------------------------------------------------------------------
// Gmail (read-only)
// ---------------------------------------------------------------------------

export interface MailSummary {
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export async function listMessages(
  accessToken: string,
  params: { query: string; maxResults?: number },
): Promise<MailSummary[]> {
  const q = new URLSearchParams({ q: params.query, maxResults: String(params.maxResults ?? 10) });
  const list = await apiGet<{ messages?: { id: string }[] }>(`${GMAIL_URL}/users/me/messages?${q}`, accessToken);
  const ids = (list.messages ?? []).slice(0, params.maxResults ?? 10);

  // `format=metadata` keeps bodies out of core entirely — headers and the
  // snippet Gmail already generates are enough to answer out loud.
  const detail = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "Subject", "Date"]) detail.append("metadataHeaders", h);

  const messages = await Promise.all(
    ids.map((m) =>
      apiGet<{ snippet?: string; payload?: { headers?: { name: string; value: string }[] } }>(
        `${GMAIL_URL}/users/me/messages/${m.id}?${detail}`,
        accessToken,
      ).catch(() => null),
    ),
  );

  return messages.filter((m): m is NonNullable<typeof m> => m !== null).map((m) => {
    const header = (name: string): string =>
      m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    return {
      from: header("From"),
      subject: header("Subject") || "(no subject)",
      date: header("Date"),
      snippet: m.snippet ?? "",
    };
  });
}
