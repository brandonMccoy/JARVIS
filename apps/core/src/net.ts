import net from "node:net";

/**
 * Port selection for development.
 *
 * The default port is frequently still held by a previous core — a `--watch`
 * restart that has not let go, or a terminal closed without stopping the
 * process. Failing with EADDRINUSE is correct behaviour for a server, but it is
 * a poor way to start a dev session, so core walks upward to the first free
 * port instead.
 *
 * The port has to reach the browser too: Vite proxies `/ws` at it. `scripts/dev.mjs`
 * therefore picks the port *before* spawning either child and passes it to both
 * as JARVIS_PORT, which is why the same walk lives there in plain JS.
 */

/** Resolves true if `host:port` can be bound right now. */
export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen({ host, port, exclusive: true });
  });
}

/**
 * The first free port at or above `start`. Throws rather than binding something
 * wildly unrelated — if twenty consecutive ports are taken, something is wrong
 * that a different port will not fix.
 */
export async function findFreePort(host: string, start: number, attempts = 20): Promise<number> {
  for (let port = start; port < start + attempts; port++) {
    if (await isPortFree(host, port)) return port;
  }
  throw new Error(`No free port between ${start} and ${start + attempts - 1} on ${host}.`);
}
