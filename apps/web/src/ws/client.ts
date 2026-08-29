import { parseServerEvent, type ClientEvent, type ServerEvent } from "@jarvis/shared";
import { store } from "../state/store.ts";

type Handler = (e: ServerEvent) => void;

/** Reconnecting WebSocket client (JOBS J0.10). */
class JarvisSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private attempt = 0;
  private closedByUser = false;
  private queue: string[] = [];

  connect(): void {
    this.closedByUser = false;
    const token = import.meta.env.VITE_JARVIS_TOKEN ?? "dev-local";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    store.getState().set({ connection: "connecting" });
    const ws = new WebSocket(url);
    this.ws = ws;
    // A React StrictMode double-mount (or a slow proxy hop) can leave a superseded
    // socket's handshake completing after `this.ws` has already moved on to a newer
    // one. Every handler below checks it's still the current socket before acting,
    // so a stray duplicate connection can never deliver events twice.
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.attempt = 0;
      store.getState().set({ connection: "open" });
      for (const q of this.queue.splice(0)) ws.send(q);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      let event: ServerEvent;
      try {
        event = parseServerEvent(JSON.parse(String(ev.data)));
      } catch (err) {
        console.warn("bad server event", err);
        return;
      }
      for (const h of this.handlers) h(event);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      store.getState().set({ connection: "closed" });
      if (this.closedByUser) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  send(event: ClientEvent): void {
    const data = JSON.stringify(event);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (event.type === "user.utterance" || event.type === "screen.frame") this.queue.push(data);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}

export const socket = new JarvisSocket();
