import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_SETTINGS, SettingsSchema, applySettingsPatch, type Settings, type SettingsPatch } from "@jarvis/shared";

type Listener = (settings: Settings) => void;

/** Load / patch / persist / broadcast (JOBS J0.12). */
export class SettingsService {
  private current: Settings;
  private listeners = new Set<Listener>();

  constructor(private db: DatabaseSync) {
    this.current = this.load();
  }

  private load(): Settings {
    const row = this.db.prepare("SELECT json FROM settings WHERE key = 'settings'").get() as { json?: string } | undefined;
    if (!row?.json) return DEFAULT_SETTINGS;
    try {
      // Merge over defaults so newly added fields get their defaults.
      const stored = JSON.parse(row.json) as Partial<Settings>;
      return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...stored });
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  get(): Settings {
    return this.current;
  }

  patch(patch: SettingsPatch): Settings {
    this.current = applySettingsPatch(this.current, patch);
    this.db
      .prepare("INSERT OR REPLACE INTO settings (key, json) VALUES ('settings', ?)")
      .run(JSON.stringify(this.current));
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
