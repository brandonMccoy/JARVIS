import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

/**
 * RFC 8252 loopback authorization flow.
 *
 * The system browser is used rather than an embedded webview so password
 * managers and 2FA behave normally, and so the user can see the real consent
 * screen on the real origin. The listener is bound to 127.0.0.1, opened only
 * for the duration of the flow, and closed in a `finally` — an abandoned
 * consent must not leave a port bound.
 */

export interface LoopbackResult {
  code: string;
  redirectUri: string;
  verifier: string;
}

export interface LoopbackOptions {
  /** Given the redirect URI we ended up on, build the provider's authorize URL. */
  buildAuthUrl: (params: { redirectUri: string; challenge: string; state: string }) => string;
  timeoutMs?: number;
  log?: (msg: string, extra?: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** PKCE S256 — required by RFC 8252, and the only thing protecting the code. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function safeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Open a URL in the user's default browser without going through a shell. */
export function openBrowser(url: string): void {
  const opts = { stdio: "ignore", detached: true, windowsHide: true } as const;
  let child;
  if (process.platform === "win32") {
    // rundll32 takes the URL as a single argv, so `&` in the query string is
    // not re-parsed the way `cmd /c start` would re-parse it.
    child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], opts);
  } else if (process.platform === "darwin") {
    child = spawn("open", [url], opts);
  } else {
    child = spawn("xdg-open", [url], opts);
  }
  child.on("error", () => undefined); // the URL is also shown in the HUD
  child.unref();
}

const DONE_PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0b0e13;color:#d8e0ea">` +
  `<div style="text-align:center"><h1 style="font-size:20px;font-weight:600">${title}</h1>` +
  `<p style="opacity:.7">${body}</p></div>`;

/**
 * Runs the whole dance: bind a port, open the browser, wait for the redirect.
 * Resolves with the authorization code, or rejects on timeout / mismatch /
 * provider error.
 */
export async function runLoopbackFlow(opts: LoopbackOptions): Promise<LoopbackResult> {
  const { verifier, challenge } = createPkce();
  const state = b64url(randomBytes(32));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const server = http.createServer();
  let timer: NodeJS.Timeout | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Port 0 = let the OS pick. Loopback only: nothing else on the network
      // can reach this, which is what makes plain HTTP acceptable here.
      server.listen(0, "127.0.0.1", resolve);
    });

    const { port } = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const authUrl = opts.buildAuthUrl({ redirectUri, challenge, state });

    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for consent.")), timeoutMs);

      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404).end();
          return;
        }
        const params = url.searchParams;
        const err = params.get("error");
        const returnedState = params.get("state") ?? "";
        const returnedCode = params.get("code");

        const fail = (message: string): void => {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(DONE_PAGE("Connection failed", message));
          reject(new Error(message));
        };

        if (err) return fail(`The provider returned "${err}".`);
        if (!safeEquals(returnedState, state)) return fail("State mismatch — the response did not match this request.");
        if (!returnedCode) return fail("No authorization code was returned.");

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE("Connected", "You can close this window and return to J.A.R.V.I.S."));
        resolve(returnedCode);
      });

      opts.log?.("opening browser for consent");
      openBrowser(authUrl);
    });

    return { code, redirectUri, verifier };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}
