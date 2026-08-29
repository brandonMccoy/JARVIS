import { spawn } from "node:child_process";

/**
 * Deletion that can be undone.
 *
 * Nothing here ever calls `fs.unlink`. A voice assistant that can delete needs
 * a way back, so items go to the Recycle Bin and are restored from Explorer
 * like anything else the user deleted themselves.
 *
 * Windows has no Node API for this, so it goes through PowerShell's
 * `Microsoft.VisualBasic.FileIO.FileSystem` — the same shell-out precedent set
 * by the DPAPI key wrapping, and for the same reason: it avoids a native module
 * the project has deliberately done without. The path crosses on stdin rather
 * than argv, so quoting can never turn a path into an argument.
 *
 * On platforms without an implementation this throws rather than falling back
 * to an unrecoverable delete. Refusing is the safe failure; a silent permanent
 * delete is not.
 */

/** Windows may bypass the bin entirely for very large items; refuse those instead. */
export const MAX_RECYCLE_BYTES = 2 * 1024 * 1024 * 1024;

export class RecycleError extends Error {
  constructor(
    message: string,
    readonly spoken: string,
  ) {
    super(message);
    this.name = "RecycleError";
  }
}

const PS_SCRIPT = [
  "Add-Type -AssemblyName Microsoft.VisualBasic;",
  "$p = [Console]::In.ReadToEnd().Trim();",
  "$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs;",
  "$bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin;",
  "$cancel = [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException;",
  "if (Test-Path -LiteralPath $p -PathType Container) {",
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, $ui, $bin, $cancel);",
  "} else {",
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $bin, $cancel);",
  "}",
].join("");

export function recycleSupported(): boolean {
  return process.platform === "win32";
}

export async function moveToRecycleBin(absolutePath: string): Promise<void> {
  if (!recycleSupported()) {
    throw new RecycleError(
      `no Recycle Bin implementation for ${process.platform}`,
      "I can only delete things on Windows, where they can be recovered from the Recycle Bin.",
    );
  }

  try {
    await runPowerShell(PS_SCRIPT, absolutePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RecycleError(`recycle failed for ${absolutePath}: ${detail}`, "I could not move that to the Recycle Bin.");
  }
}

/**
 * Spawn PowerShell, feed `input` on stdin, and resolve on a clean exit.
 *
 * `child_process.execFile` is deliberately not used: its `input` option exists
 * only on the *Sync* variants, so the async form silently never writes stdin
 * and the script blocks on ReadToEnd forever.
 */
function runPowerShell(script: string, input: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    // A prompt Windows decides to show would otherwise hang the turn forever.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `exited with ${code}`));
    });

    child.stdin.end(input, "utf8");
  });
}
