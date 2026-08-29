/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JARVIS_TOKEN?: string;
  readonly VITE_PICOVOICE_ACCESS_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
