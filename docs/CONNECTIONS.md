# Connecting apps — mail & calendar

How a user links a Google or Microsoft account to J.A.R.V.I.S., and why the
flow is shaped the way it is.

PLAN §7 already says every app is an MCP server behind a three-layer permission
gate, and JOBS J5.12 wires GitHub with a personal access token pasted into
`apps/core/.env`. Mail and calendar cannot work that way. There is no "paste a
token" path for Google or Microsoft: the user has to consent in a browser, and
what comes back has to be refreshed for the rest of time. That is the whole of
the problem this document addresses.

---

## 1. What the ecosystem settled on

Every serious local integration converges on the same shape, and it is worth
knowing that before designing anything.

**The loopback redirect.** [RFC 8252 (OAuth 2.0 for Native Apps)][rfc8252] is
the governing standard. An app running on the user's machine opens the *system
browser* — never an embedded webview — and receives the authorization code back
on a `http://127.0.0.1:<port>/…` redirect. Plain HTTP is explicitly acceptable
here because the request never leaves the machine. The RFC asks that the port be
opened only for the duration of the flow, closed immediately after, and bound to
the loopback interface so nothing else on the network can reach it.

**PKCE is mandatory, and the client secret is not a secret.** RFC 8252 requires
PKCE, and states plainly that a secret shipped to many installs of a native app
must not be treated as confidential. This kills any design where J.A.R.V.I.S.
ships with an embedded Google client secret.

**So the user brings their own OAuth client.** This is what every community
Google MCP server does — [nspady/google-calendar-mcp][nspady],
[taylorwilsdon/google_workspace_mcp][taylor], and Google's own
[MCP configuration guide][gmcp] all walk the user through creating a Cloud
project, enabling the APIs, creating an OAuth client of type **Desktop App**,
and dropping the downloaded JSON next to the server. The consent screen then
runs against *their* project, and their data never passes through anyone else's
infrastructure. Slightly more setup, dramatically less trust required.

---

## 2. The gotcha that decides the design

**Google expires refresh tokens after 7 days while a project's publishing
status is "Testing".** ([Google's OAuth docs][gauth], and it is the single most
common complaint about self-hosted Google integrations.) A weekly re-consent is
not something to discover after building the feature. The ways out:

| Path | Cost | Verdict |
|---|---|---|
| Stay in Testing | Re-consent every 7 days | Fine for a first spike, wrong to live with |
| **Publish to Production, skip verification** | A one-time "Google hasn't verified this app" interstitial (*Advanced → Go to …*) at consent | **Chosen.** The 7-day expiry is a property of *Testing* status, not of verification — publishing lifts it even while unverified |
| Publish **and** verify | Gmail's restricted scopes additionally require a [CASA Tier 2 security audit][gverify] | Only needed to distribute to other people |
| Google Workspace **Internal** app | Exempt from both the 7-day expiry and the 100-test-user cap — but requires a Workspace, not consumer, account | Not available on consumer Gmail |
| Microsoft instead | Refresh tokens up to ~90 days, no verification gauntlet | Deferred to phase C |

The distinction in row two is the one that matters and is easy to miss:
**verification governs the warning screen; publishing status governs token
lifetime.** A personal, unverified, *published* project gets long-lived refresh
tokens — which is why the setup panel makes "In production" a numbered step
rather than a footnote.

Two consequences worth internalising:

- **Calendar is much cheaper than mail.** Calendar scopes are *sensitive*;
  Gmail's are largely *restricted*, and restricted is what triggers the security
  audit. Ship calendar first.
- **Ask which account the user actually has before writing code.** Consumer
  Gmail, Google Workspace, and Microsoft 365 lead to three different answers on
  the table above.

---

## 3. Where the credentials live

Core already holds the Anthropic key and `apps/core/.env` states that "the
browser never sees this key". OAuth tokens inherit that rule exactly: **the web
app never receives an access or refresh token.** It sees connection *status*
only — provider, account email, granted scopes, expiry. Core performs every API
call.

This falls out of the existing architecture rather than being bolted on: core is
already the only process with secrets, already bound to `127.0.0.1`, and already
gates the WebSocket on a shared token and origin check.

Storage goes in SQLite alongside everything else, as a new numbered migration in
`apps/core/src/store/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS connections (
  id            TEXT PRIMARY KEY,   -- 'google' | 'microsoft'
  account       TEXT,               -- email, for display
  scopes        TEXT NOT NULL,      -- space-delimited, as granted
  access_token  TEXT,               -- encrypted; short-lived anyway
  refresh_token TEXT,               -- encrypted; the thing that matters
  expires_at    INTEGER,
  connected_at  INTEGER NOT NULL,
  status        TEXT NOT NULL       -- 'active' | 'expired' | 'revoked'
);
```

**On encryption, honestly:** tokens are sealed with AES-256-GCM under a key kept
beside the database. A key file *alone* stops casual disclosure — a backup, a
synced folder, someone glancing at the DB — and stops nothing against anyone who
copies the directory, because they get both halves.

So on Windows the key is itself wrapped with **DPAPI** (`CryptProtectData`,
`CurrentUser` scope) before it touches disk. The data directory is then inert on
another machine or under another Windows account. This is done by shelling out
to PowerShell's `ProtectedData` rather than adding a native module, which keeps
faith with the `node:sqlite` decision in PLAN §11; the key crosses on stdin, never
argv, since command lines are readable machine-wide. Key files written before this
are upgraded in place on first read, and the key does not change, so existing
tokens stay readable.

On macOS and Linux the key is still a bare file — see §8.

**What this does not do:** DPAPI defeats a stolen directory, not a compromised
session. Code running as this user can always ask J.A.R.V.I.S. to decrypt,
because J.A.R.V.I.S. has to be able to. The UI should not imply otherwise.

---

## 4. The connection flow

What the user sees:

1. **Settings → Apps → Calendar & Mail → Connect.**
2. **Pick a provider** — Google or Microsoft.
3. **First time only:** a setup panel with numbered steps and a deep link to the
   provider console, ending in two fields — Client ID and Client Secret. This is
   the BYO-client step from §1. It is the ugliest part of the experience and
   deserves the most care: the exact clicks, the exact API names to enable, and
   an explicit "choose **Desktop App**".
4. **Connect** → the system browser opens on the real consent screen. Password
   managers and 2FA work because it is a real browser, not a webview.
5. Consent → provider redirects to the loopback listener → the tab shows
   "Connected. You can close this window."
6. The HUD card flips to **Connected as name@example.com**, listing granted
   scopes and a **Disconnect** button.

What core does:

```
web ──"connection.start"──► core
                              ├─ generate state (CSRF) + PKCE verifier/challenge
                              ├─ bind one-shot listener on 127.0.0.1:<random>
                              ├─ return the authorize URL
web ── opens system browser ─────────────────────────────────────────► provider
provider ── 302 with ?code&state ──► 127.0.0.1:<port>/oauth/callback
                              ├─ constant-time compare state, else abort
                              ├─ POST code + verifier → token endpoint
                              ├─ encrypt + store refresh token
                              ├─ close the listener
                              └─ broadcast "connection.changed" ──► web
```

Non-obvious details that cause bugs if skipped:

- **`state` must be compared, not just present** — it is the CSRF defence.
- **Close the listener in a `finally`**, and time it out (~2 min). A listener
  left open after an abandoned consent is exactly what RFC 8252 warns against.
- **Google needs `access_type=offline` and `prompt=consent`** or you get no
  refresh token on re-authorization — a classic silent failure.
- **Store the scopes the provider *granted*, not the ones requested.** Users can
  untick individual permissions on Google's consent screen, and the difference
  has to reach the permission gate.

---

## 5. Mapping onto the existing permission model

`AppPermission` already carries `read`, `write`, and `confirmWrites`. Scopes
should be *derived* from those toggles rather than invented alongside them, so
the Apps page stays the single source of truth:

| Toggle | Google | Microsoft Graph |
|---|---|---|
| Calendar read | `calendar.readonly` | `Calendars.Read` |
| Calendar write | `calendar.events` | `Calendars.ReadWrite` |
| Mail read | `gmail.readonly` *(restricted)* | `Mail.Read` |
| Mail write | `gmail.send` *(restricted)* | `Mail.Send` |

Request only what is toggled on. Both providers support incremental
authorization, so enabling Write later re-prompts for the added scope instead of
forcing a full reconnect — and the request stays honest about what it wants,
which is what makes the consent screen believable.

The three existing layers apply unchanged: disabled apps' tools never enter the
`tools` array (J5.4), the runtime gate re-checks on every call (J5.5), and every
call is audited (J5.6). A revoked or expired connection is simply a fourth
reason the gate says no.

---

## 6. MCP server, or direct API calls?

PLAN §7 commits to MCP, and community servers already exist for both providers.
But every one of them owns its own OAuth and its own on-disk token file, which
fights the flow in §4 — the user would authenticate to a child process, not to
J.A.R.V.I.S., and the HUD would have nothing to show.

The resolution is to split the two concerns:

- **Core owns the connection.** The OAuth broker, the tokens, the refresh loop,
  and the Connect/Disconnect UX live in core regardless of what calls the API.
- **The API surface can be either.** Start with direct REST calls against
  Calendar and Graph — a handful of endpoints, no subprocess lifecycle, and it
  proves the broker end-to-end. Move to an MCP server later by injecting a live
  access token, at which point core is a token broker for it.

This keeps PLAN §7 intact while refusing to let a community server dictate the
authentication experience.

---

## 7. Proposed jobs

Sized in the style of JOBS.md. Phase A is the whole point; B and C are
extensions that reuse the broker.

| # | Job | Size | Deps | Proof |
|---|---|---|---|---|
| **A — Google Calendar, read-only** | | | | |
| C1.1 | `connections` table + migration; encrypted-at-rest helper with a key file in `dataDir` | M | J0.11 | Row survives restart; DB inspection shows no plaintext token |
| C1.2 | OAuth broker: PKCE, `state`, one-shot loopback listener with timeout and `finally` close | L | C1.1 | Abandoned consent leaves no listener bound (verified with `netstat`) |
| C1.3 | Token refresh with a single-flight mutex; `invalid_grant` → status `revoked` | M | C1.2 | Forced-expiry test refreshes exactly once under concurrent calls |
| C1.4 | `connection.start` / `connection.changed` / `connection.disconnect` events in `packages/shared` | S | J0.5 | Typecheck; web sees status only, never a token |
| C1.5 | Apps page: provider picker, BYO-client setup panel, connected state, Disconnect | L | C1.4, J5.9 | Full connect → disconnect → reconnect cycle by hand |
| C1.6 | `calendar_today` / `calendar_search` tools behind the permission gate | M | C1.3, J5.5 | "What's on my calendar?" answers correctly; disabling the app removes the tools from the payload |
| C1.7 | Spoken failure paths — not connected, expired, scope missing | S | C1.6 | Each surfaces as speech, not a stack trace |
| **B — Mail** | | | | |
| C2.1 | Gmail read tools (`mail_unread`, `mail_search`) | M | C1.6 | Unread count matches the web UI |
| C2.2 | Send behind `confirmWrites` (J5.7) | M | C2.1, J5.7 | "No" reliably cancels a send |
| **C — Microsoft** | | | | |
| C3.1 | Graph provider behind the same broker interface | L | C1.3 | Both providers connect independently; tokens never cross |

**Phase A acceptance:** a clean machine, following the setup panel only, reaches
"What's on my calendar today?" answered out loud — and the SQLite file contains
no plaintext token.

---

## 8. Status

**Decided:** consumer Gmail, read-only, Google first. Phase A is built —
C1.1 through C1.7 and C2.1, covering the broker, storage, both read-only tool
sets, and the Apps-page flow. Write access (C2.2) and Microsoft (C3.1) remain
untouched.

Still open:

1. **Key protection on macOS and Linux.** Windows is done — the key is DPAPI-wrapped
   under the current user (§3), with no native dependency. The same idea needs
   `security add-generic-password` on macOS and libsecret on Linux, neither of
   which has an equivalent already-installed shell out. Until then those
   platforms keep the bare key file and the weaker guarantee that comes with it.
2. **Is `format=metadata` enough for mail?** Bodies are deliberately never
   fetched, so he can say who wrote and roughly what about, but cannot summarise
   a thread. Raising that means pulling message bodies into core, which is a
   real change in what this process holds.

[rfc8252]: https://www.rfc-editor.org/rfc/rfc8252.html
[gauth]: https://developers.google.com/identity/protocols/oauth2
[gverify]: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
[gmcp]: https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server
[nspady]: https://github.com/nspady/google-calendar-mcp
[taylor]: https://github.com/taylorwilsdon/google_workspace_mcp
