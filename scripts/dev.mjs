// Runs core and web together with prefixed output. `npm run dev`.
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const procs = [
  ["core", ["run", "dev", "-w", "@jarvis/core"]],
  ["web", ["run", "dev", "-w", "@jarvis/web"]],
];

const children = procs.map(([name, args]) => {
  const child = spawn(npm, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
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
