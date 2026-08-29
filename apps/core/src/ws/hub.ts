import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { parseClientEvent, type ImagePayload, type ServerEvent } from "@jarvis/shared";
import type { Brain } from "../brain/chat.js";
import type { ConnectionStore } from "../connections/store.js";
import type { SessionStore } from "../store/sessions.js";
import type { SettingsService } from "../store/settings.js";

interface HubDeps {
  settings: SettingsService;
  sessions: SessionStore;
  connections: ConnectionStore;
  capabilities: { anthropic: boolean; elevenlabs: boolean; version: string };
  log: (msg: string, extra?: unknown) => void;
}

/**
 * Connection registry + event router (JOBS J0.8). All connections share one
 * session and one brain (single user, possibly several tabs).
 */
export class Hub {
  private conns = new Set<WebSocket>();
  private pendingFrames = new Map<string, { resolve: (img: ImagePayload | null) => void; timer: NodeJS.Timeout }>();
  private screenActive = false;
  private screenLabel = "";
  brain!: Brain;

  constructor(private deps: HubDeps) {
    deps.settings.onChange((settings) => this.broadcast({ type: "settings.changed", settings }));
  }

  get screenShareActive(): boolean {
    return this.screenActive;
  }

  broadcast = (event: ServerEvent): void => {
    const data = JSON.stringify(event);
    for (const ws of this.conns) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  requestScreenshot = (): Promise<ImagePayload | null> => {
    if (!this.screenActive) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFrames.delete(requestId);
        resolve(null);
      }, 5000);
      this.pendingFrames.set(requestId, { resolve, timer });
      this.broadcast({ type: "screen.request", requestId });
    });
  };

  attach(ws: WebSocket): void {
    this.conns.add(ws);
    const hello: ServerEvent = {
      type: "hello",
      sessionId: this.deps.sessions.id,
      settings: this.deps.settings.get(),
      history: this.deps.sessions.getTranscript(),
      capabilities: this.deps.capabilities,
      connections: this.deps.connections.publicState(),
    };
    ws.send(JSON.stringify(hello));

    ws.on("message", (raw) => {
      let event;
      try {
        event = parseClientEvent(JSON.parse(raw.toString()));
      } catch (err) {
        this.deps.log("bad client event", String(err));
        return;
      }
      this.handle(event).catch((err) => this.deps.log("handler error", String(err)));
    });
    ws.on("close", () => {
      this.conns.delete(ws);
      if (this.conns.size === 0 && this.screenActive) {
        this.screenActive = false;
      }
    });
    ws.on("error", (err) => this.deps.log("ws error", String(err)));
  }

  private async handle(event: ReturnType<typeof parseClientEvent>): Promise<void> {
    switch (event.type) {
      case "user.utterance":
        await this.brain.handleUtterance(event.text, event.source, event.images);
        break;
      case "user.interrupt":
        this.brain.interrupt();
        break;
      case "mode.set":
        this.deps.settings.patch({ hud: { listening: event.listening } });
        break;
      case "screen.status":
        this.screenActive = event.active;
        this.screenLabel = event.label ?? "";
        break;
      case "screen.frame": {
        if (!event.requestId) break;
        const pending = this.pendingFrames.get(event.requestId);
        if (!pending) break;
        clearTimeout(pending.timer);
        this.pendingFrames.delete(event.requestId);
        pending.resolve(event.image ?? null);
        break;
      }
      case "settings.patch":
        this.deps.settings.patch(event.patch);
        break;
      case "session.new":
        this.brain.newSession();
        break;
      case "tool.confirm.reply":
        // Phase 5: routed to the permission gate.
        break;
      case "connection.configure":
        this.deps.connections.configure(event.provider, event.clientId, event.clientSecret);
        break;
      case "connection.start": {
        // Consent happens in the system browser and can take a while; tell the
        // HUD immediately, then report the outcome through connection.changed.
        this.broadcast({ type: "connection.pending", provider: event.provider });
        try {
          await this.deps.connections.connect(event.provider);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.log("connection failed", message);
          this.broadcast({ type: "error", message: `Could not connect ${event.provider}: ${message}` });
          this.broadcast({ type: "connection.changed", connections: this.deps.connections.publicState() });
        }
        break;
      }
      case "connection.disconnect":
        await this.deps.connections.disconnect(event.provider);
        break;
      case "audio.playback":
      case "client.listening":
        // Metrics hooks (Phase 2 J2.24). Nothing to do server-side yet.
        break;
      default:
        break;
    }
  }
}
