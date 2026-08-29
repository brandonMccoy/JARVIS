import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bin-"));
const file = path.join(dir, "probe.txt");
fs.writeFileSync(file, "x");

const script = [
  "Add-Type -AssemblyName Microsoft.VisualBasic;",
  "$p = [Console]::In.ReadToEnd().Trim();",
  "Write-Output \"path=[$p]\";",
  "$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs;",
  "$bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin;",
  "$cancel = [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException;",
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $bin, $cancel);",
  "Write-Output 'deleted-ok';",
].join("");
try {
  const { stdout, stderr } = await run("powershell.exe", ["-NoProfile","-NonInteractive","-Command",script],
    { input: file, windowsHide: true } as never);
  console.log("STDOUT:", stdout);
  console.log("STDERR:", stderr);
} catch (e) {
  console.log("ERR stdout:", (e as {stdout?:string}).stdout);
  console.log("ERR stderr:", (e as {stderr?:string}).stderr);
}
console.log("exists after?", fs.existsSync(file));
