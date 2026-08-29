import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Core walks upward from 8787 if that port is busy, so the proxy cannot assume
// the default. `scripts/dev.mjs` resolves the port first and passes it to both
// processes; this is the fallback for running web on its own.
const corePort = Number(process.env.JARVIS_PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${corePort}`, ws: true, changeOrigin: false },
      "/health": { target: `http://127.0.0.1:${corePort}` },
    },
  },
  build: { target: "es2022", sourcemap: true },
  optimizeDeps: { exclude: ["@picovoice/porcupine-web", "@picovoice/web-voice-processor"] },
});
