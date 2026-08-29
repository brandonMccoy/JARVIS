import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config.js";
import { openDatabase } from "./store/db.js";
import { SettingsService } from "./store/settings.js";
import { SessionStore } from "./store/sessions.js";
import { Brain } from "./brain/chat.js";
import { ConnectionStore } from "./connections/store.js";
import { Hub } from "./ws/hub.js";
import { chooseTts } from "./voice/tts.js";

const log = (msg: string, extra?: unknown): void => {
  const ts = new Date().toISOString().slice(11, 19);
  if (extra === undefined) console.log(`${ts} ${msg}`);
  else console.log(`${ts} ${msg}`, extra);
};

async function main(): Promise<void> {
  const db = openDatabase(env.dataDir);
  const settings = new SettingsService(db);
  const sessions = new SessionStore(db);

  if (!env.anthropicKey) {
    log("WARNING: ANTHROPIC_API_KEY is not set. Copy apps/core/.env.example to apps/core/.env and add your key. J.A.R.V.I.S. will answer only fast-path intents until then.");
  } else if (env.anthropicKey.length && !env.anthropicWorkspaceId) {
    log("Note: ANTHROPIC_WORKSPACE_ID is not set. If your key is identity-linked (Console -> Settings -> API Keys shows it tied to your user), requests will fail with a 400 until you set it.");
  }
  if (!env.elevenLabsKey) {
    log("Note: ELEVENLABS_API_KEY not set — using the browser's built-in voice.");
  }
  const client = env.anthropicKey
    ? new Anthropic({
        apiKey: env.anthropicKey,
        defaultHeaders: env.anthropicWorkspaceId ? { "anthropic-workspace-id": env.anthropicWorkspaceId } : undefined,
      })
    : null;

  const connections = new ConnectionStore({
    db,
    dataDir: env.dataDir,
    onChange: (states) => hub.broadcast({ type: "connection.changed", connections: states }),
    log,
  });

  const hub = new Hub({
    settings,
    sessions,
    connections,
    capabilities: { anthropic: Boolean(client), elevenlabs: Boolean(env.elevenLabsKey), version: env.version },
    log,
  });
  hub.brain = new Brain({
    client,
    settings,
    sessions,
    connections,
    tts: () => chooseTts(settings.get(), env.elevenLabsKey),
    emit: hub.broadcast,
    requestScreenshot: hub.requestScreenshot,
    screenShareActive: () => hub.screenShareActive,
    log,
  });

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  app.get("/health", async () => ({ ok: true, version: env.version, anthropic: Boolean(client), elevenlabs: Boolean(env.elevenLabsKey) }));

  app.get("/ws", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    const origin = req.headers.origin;
    if (token !== env.token || !isAllowedOrigin(origin)) {
      socket.close(4401, "unauthorised");
      return;
    }
    hub.attach(socket);
  });

  await app.listen({ host: env.host, port: env.port });
  log(`J.A.R.V.I.S. core listening on ws://${env.host}:${env.port}/ws  (brain: ${client ? "Anthropic" : "OFFLINE"}, voice: ${env.elevenLabsKey ? "ElevenLabs" : "browser"})`);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, tests) — token still required
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
