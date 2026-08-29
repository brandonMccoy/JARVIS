import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true, changeOrigin: false },
      "/health": { target: "http://127.0.0.1:8787" },
    },
  },
  build: { target: "es2022", sourcemap: true },
  optimizeDeps: { exclude: ["@picovoice/porcupine-web", "@picovoice/web-voice-processor"] },
});
