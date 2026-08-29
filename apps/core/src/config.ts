import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
loadDotenv({ path: path.join(appRoot, ".env"), quiet: true });

export const env = {
  /** Core is bound to loopback only (PLAN §11 Binding). Not configurable on purpose. */
  host: "127.0.0.1",
  port: Number(process.env.JARVIS_PORT ?? 8787),
  token: process.env.JARVIS_TOKEN ?? "dev-local",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? "",
  elevenLabsKey: process.env.ELEVENLABS_API_KEY ?? "",
  dataDir: process.env.JARVIS_DATA_DIR ?? path.join(appRoot, "data"),
  appRoot,
  version: "0.1.0",
};

export const VOICE_SAMPLE_RATE = 16_000;
