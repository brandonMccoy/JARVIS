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
  /** Gmail message id, so `mail_read` can fetch this specific message. */
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface MailBody extends MailSummary {
  body: string;
  truncated: boolean;
}

/** Bodies are capped: a newsletter can be enormous and none of it is worth the context. */
export const MAX_BODY_CHARS = 4000;

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/**
 * Depth-first search of the MIME tree for readable text.
 *
 * Gmail nests parts arbitrarily — multipart/alternative for text+HTML,
 * multipart/mixed once attachments appear. `text/plain` is preferred because
 * the HTML alternative of the same message is mostly markup; HTML is the
 * fallback for senders who omit a plain part, which many marketing mails do.
 * Parts with a filename are attachments and are skipped whatever their type.
 */
function findPart(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.filename) return null; // an attachment, not the message
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

/** Crude but adequate: this text is read aloud, never rendered. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractBody(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain !== null) return plain.replace(/\r\n/g, "\n").trim();
  const html = findPart(payload, "text/html");
  return html !== null ? stripHtml(html) : "";
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

  return messages
    .map((m, i) => (m === null ? null : { ...m, id: ids[i]!.id }))
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .map((m) => {
      const header = (name: string): string =>
        m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
      return {
        id: m.id,
        from: header("From"),
        subject: header("Subject") || "(no subject)",
        date: header("Date"),
        snippet: m.snippet ?? "",
      };
    });
}

/**
 * One message including its body. Separate from `listMessages` on purpose: a
 * search that returned ten full bodies would pull far more of the mailbox into
 * the model than any single question needs, so the body is fetched only when
 * Claude asks for this specific message (docs/CONNECTIONS.md §8).
 */
export async function getMessage(accessToken: string, id: string): Promise<MailBody> {
  const m = await apiGet<{
    id: string;
    snippet?: string;
    payload?: GmailPart & { headers?: { name: string; value: string }[] };
  }>(`${GMAIL_URL}/users/me/messages/${encodeURIComponent(id)}?format=full`, accessToken);

  const header = (name: string): string =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const full = extractBody(m.payload);
  const truncated = full.length > MAX_BODY_CHARS;

  return {
    id: m.id,
    from: header("From"),
    subject: header("Subject") || "(no subject)",
    date: header("Date"),
    snippet: m.snippet ?? "",
    body: truncated ? `${full.slice(0, MAX_BODY_CHARS)}…` : full,
    truncated,
  };
}
