import type { DatabaseSync } from "node:sqlite";
import type { ConnectionProvider, ConnectionState, ConnectionStatus } from "@jarvis/shared";
import { decryptSecret, encryptSecret } from "./crypto.js";
import * as google from "./google.js";
import { OAuthError } from "./google.js";
import { runLoopbackFlow } from "./oauth.js";

interface Row {
  id: string;
  status: string;
  account: string | null;
  scopes: string;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  connected_at: number | null;
  error: string | null;
}

export interface ConnectionDeps {
  db: DatabaseSync;
  dataDir: string;
  onChange: (states: ConnectionState[]) => void;
  log: (msg: string, extra?: unknown) => void;
}

/**
 * Owns account connections end to end (docs/CONNECTIONS.md §3, §6): the OAuth
 * client, the consent flow, the tokens, and refresh. Nothing here is exposed
 * over the WebSocket except `publicState()`.
 */
export class ConnectionStore {
  /** In-flight refreshes, keyed by provider — the single-flight guard. */
  private refreshing = new Map<string, Promise<string>>();
  private connecting = new Set<string>();

  constructor(private deps: ConnectionDeps) {}

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private row(provider: ConnectionProvider): Row | undefined {
    return this.deps.db.prepare("SELECT * FROM connections WHERE id = ?").get(provider) as Row | undefined;
  }

  private write(provider: ConnectionProvider, patch: Partial<Row>): void {
    const existing = this.row(provider);
    const next: Row = {
      id: provider,
      status: "unconfigured",
      account: null,
      scopes: "",
      client_id: null,
      client_secret: null,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      connected_at: null,
      error: null,
      ...existing,
      ...patch,
    };
    this.deps.db
      .prepare(
        `INSERT OR REPLACE INTO connections
         (id, status, account, scopes, client_id, client_secret, access_token, refresh_token, expires_at, connected_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.id,
        next.status,
        next.account,
        next.scopes,
        next.client_id,
        next.client_secret,
        next.access_token,
        next.refresh_token,
        next.expires_at,
        next.connected_at,
        next.error,
      );
    this.deps.onChange(this.publicState());
  }

  /** Status only — deliberately carries no token material. */
  publicState(): ConnectionState[] {
    const rows = this.deps.db.prepare("SELECT * FROM connections").all() as unknown as Row[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return (["google"] as ConnectionProvider[]).map((provider) => {
      const r = byId.get(provider);
      if (!r) return { provider, status: "unconfigured" as ConnectionStatus, scopes: [] };
      return {
        provider,
        status: r.status as ConnectionStatus,
        account: r.account ?? undefined,
        scopes: r.scopes ? r.scopes.split(" ").filter(Boolean) : [],
        connectedAt: r.connected_at ?? undefined,
        error: r.error ?? undefined,
      };
    });
  }

  isConnected(provider: ConnectionProvider): boolean {
    return this.row(provider)?.status === "active";
  }

  hasScope(provider: ConnectionProvider, scope: string): boolean {
    const r = this.row(provider);
    return Boolean(r && r.status === "active" && r.scopes.split(" ").includes(scope));
  }

  // -------------------------------------------------------------------------
  // Setup + consent
  // -------------------------------------------------------------------------

  /** Store the user's own OAuth client. Secret is encrypted like a token. */
  configure(provider: ConnectionProvider, clientId: string, clientSecret: string): void {
    this.write(provider, {
      client_id: clientId,
      client_secret: encryptSecret(this.deps.dataDir, clientSecret),
      status: "disconnected",
      error: null,
    });
    this.deps.log(`${provider}: OAuth client stored`);
  }

  async connect(provider: ConnectionProvider): Promise<void> {
    if (this.connecting.has(provider)) throw new Error("A connection attempt is already in progress.");
    const r = this.row(provider);
    const clientId = r?.client_id;
    const clientSecret = decryptSecret(this.deps.dataDir, r?.client_secret);
    if (!clientId || !clientSecret) throw new Error("Add your OAuth client ID and secret first.");

    this.connecting.add(provider);
    try {
      const scopes = google.READONLY_SCOPES;
      const { code, redirectUri, verifier } = await runLoopbackFlow({
        buildAuthUrl: ({ redirectUri: uri, challenge, state }) =>
          google.buildAuthUrl({ clientId, redirectUri: uri, challenge, state, scopes }),
        log: this.deps.log,
      });

      const tokens = await google.exchangeCode({ clientId, clientSecret, code, redirectUri, verifier });
      const account = await google.fetchAccountEmail(tokens.accessToken);

      this.write(provider, {
        status: "active",
        account: account ?? null,
        // What was *granted*, which can be narrower than what was asked for.
        scopes: tokens.scopes.join(" "),
        access_token: encryptSecret(this.deps.dataDir, tokens.accessToken),
        refresh_token: tokens.refreshToken ? encryptSecret(this.deps.dataDir, tokens.refreshToken) : null,
        expires_at: tokens.expiresAt,
        connected_at: Date.now(),
        error: null,
      });
      this.deps.log(`${provider}: connected as ${account ?? "unknown account"}`);

      if (!tokens.refreshToken) {
        this.deps.log(`${provider}: WARNING — no refresh token issued; re-consent will be needed when it expires`);
      }
    } finally {
      this.connecting.delete(provider);
    }
  }

  async disconnect(provider: ConnectionProvider): Promise<void> {
    const r = this.row(provider);
    const refresh = decryptSecret(this.deps.dataDir, r?.refresh_token);
    if (refresh) await google.revokeToken(refresh);
    this.write(provider, {
      status: r?.client_id ? "disconnected" : "unconfigured",
      account: null,
      scopes: "",
      access_token: null,
      refresh_token: null,
      expires_at: null,
      connected_at: null,
      error: null,
    });
    this.deps.log(`${provider}: disconnected`);
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /**
   * A valid access token, refreshing if needed. Concurrent callers share one
   * refresh: two tools firing in the same turn must not both spend the
   * refresh token, which can invalidate the other's result.
   */
  async accessToken(provider: ConnectionProvider): Promise<string> {
    const inFlight = this.refreshing.get(provider);
    if (inFlight) return inFlight;

    const r = this.row(provider);
    if (!r || r.status !== "active") throw new Error(`${provider} is not connected.`);

    const current = decryptSecret(this.deps.dataDir, r.access_token);
    if (current && r.expires_at && r.expires_at > Date.now()) return current;

    const promise = this.doRefresh(provider, r).finally(() => this.refreshing.delete(provider));
    this.refreshing.set(provider, promise);
    return promise;
  }

  private async doRefresh(provider: ConnectionProvider, r: Row): Promise<string> {
    const clientId = r.client_id;
    const clientSecret = decryptSecret(this.deps.dataDir, r.client_secret);
    const refreshToken = decryptSecret(this.deps.dataDir, r.refresh_token);
    if (!clientId || !clientSecret || !refreshToken) {
      this.write(provider, { status: "expired", error: "No refresh token stored. Reconnect to continue." });
      throw new Error(`${provider} needs reconnecting.`);
    }

    try {
      const tokens = await google.refreshTokens({
        clientId,
        clientSecret,
        refreshToken,
        knownScopes: r.scopes.split(" ").filter(Boolean),
      });
      this.write(provider, {
        status: "active",
        access_token: encryptSecret(this.deps.dataDir, tokens.accessToken),
        refresh_token: tokens.refreshToken ? encryptSecret(this.deps.dataDir, tokens.refreshToken) : r.refresh_token,
        expires_at: tokens.expiresAt,
        scopes: tokens.scopes.join(" "),
        error: null,
      });
      return tokens.accessToken;
    } catch (err) {
      const oauthErr = err instanceof OAuthError ? err : null;
      if (oauthErr?.needsReconsent) {
        // Most often: the project is still in "Testing", where Google expires
        // refresh tokens after 7 days. Publishing it fixes this for good.
        this.write(provider, {
          status: "revoked",
          error: "Authorisation expired or was revoked. Reconnect to continue.",
        });
      } else {
        this.write(provider, { status: "expired", error: oauthErr?.message ?? String(err) });
      }
      throw err;
    }
  }
}
