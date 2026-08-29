// Runs core and web together with prefixed output. `npm run dev`.
import { spawn } from "node:child_process";
import net from "node:net";

const HOST = "127.0.0.1";

// Mirrors apps/core/src/net.ts. Duplicated because this is a plain .mjs script
// that cannot import the TypeScript source, and it has to run before either
// child starts: Vite bakes the proxy target in at config time, so core and web
// must be told the same port up front rather than discovering it separately.
const isPortFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen({ host: HOST, port, exclusive: true });
  });

const start = Number(process.env.JARVIS_PORT ?? 8787);
let port = start;
while (port < start + 20 && !(await isPortFree(port))) port++;
if (port >= start + 20) {
  console.error(`No free port between ${start} and ${start + 19}. Is something holding the range?`);
  process.exit(1);
}
if (port !== start) console.log(`[dev]    port ${start} is busy — using ${port} for core and the web proxy`);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const procs = [
  ["core", ["run", "dev", "-w", "@jarvis/core"]],
  ["web", ["run", "dev", "-w", "@jarvis/web"]],
];

const children = procs.map(([name, args]) => {
  const child = spawn(npm, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: { ...process.env, JARVIS_PORT: String(port) },
  });
  const tag = `[${name}]`.padEnd(7);
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.write(`${tag} ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${tag} exited with ${code}\n`);
  });
  return child;
});

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
