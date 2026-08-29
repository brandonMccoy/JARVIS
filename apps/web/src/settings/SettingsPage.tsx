import { MODELS, MODEL_ALIASES, type Settings, type SettingsPatch } from "@jarvis/shared";
import { useStore } from "../state/store.ts";
import { socket } from "../ws/client.ts";
import { pickVoice } from "../voice/browserTts.ts";
import { GoogleConnection } from "./GoogleConnection.tsx";

/** Settings (PLAN §9). Personality has no page — it is voice-only. */
export function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const caps = useStore((s) => s.capabilities);
  const patch = (p: SettingsPatch) => socket.send({ type: "settings.patch", patch: p });
  const model = MODELS[settings.brain.model];
  const browserVoice = pickVoice(settings.voice.browserVoice);

  return (
    <div className="settings">
      <section>
        <h2>Brain</h2>
        <Row label="Model" hint={`${model.label} · ${model.contextWindow / 1000}K context`}>
          <select value={settings.brain.model} onChange={(e) => patch({ brain: { model: e.target.value as Settings["brain"]["model"] } })}>
            {MODEL_ALIASES.map((a) => (
              <option key={a} value={a}>{MODELS[a].label}</option>
            ))}
          </select>
        </Row>
        <Row label="Effort" hint={model.supportsEffort ? "Lower is snappier for conversation; analysis turns use high automatically." : `${model.label} does not support effort — not sent.`}>
          <select value={settings.brain.effort} disabled={!model.supportsEffort} onChange={(e) => patch({ brain: { effort: e.target.value as Settings["brain"]["effort"] } })}>
            {(["low", "medium", "high", "xhigh", "max"] as const).map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </Row>
        <Row label="Web search" hint="Lets him look things up. Shows as “Researching”.">
          <Toggle value={settings.brain.webSearch} onChange={(v) => patch({ brain: { webSearch: v } })} />
        </Row>
        <Row label="Spoken reply cap" hint="Max tokens of speech per turn.">
          <input type="number" min={64} max={4000} step={50} value={settings.brain.maxSpokenTokens} onChange={(e) => patch({ brain: { maxSpokenTokens: Number(e.target.value) } })} />
        </Row>
        {!caps.anthropic ? <p className="warn">No Anthropic key detected. Add ANTHROPIC_API_KEY to apps/core/.env and restart core.</p> : null}
      </section>

      <section>
        <h2>Personality</h2>
        <p className="muted">Voice-only, by design. Say “Jarvis, humour to seventy” or “candor to full”. Ask “what are your settings?” to hear them.</p>
        <Row label="Honorific" hint="How he addresses you.">
          <input type="text" value={settings.personality.honorific} onChange={(e) => patch({ personality: { honorific: e.target.value || "Sir" } })} />
        </Row>
      </section>

      <section>
        <h2>Voice</h2>
        <Row label="Provider" hint={caps.elevenlabs ? "ElevenLabs key detected." : "No ElevenLabs key — the browser voice is used."}>
          <select value={settings.voice.ttsProvider} onChange={(e) => patch({ voice: { ttsProvider: e.target.value as Settings["voice"]["ttsProvider"] } })}>
            <option value="auto">Auto</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="browser">Browser</option>
          </select>
        </Row>
        <Row label="ElevenLabs voice ID" hint="Blank uses a default British male voice.">
          <input type="text" value={settings.voice.voiceId} placeholder="voice id" onChange={(e) => patch({ voice: { voiceId: e.target.value } })} />
        </Row>
        <Row label="Browser voice" hint={browserVoice ? `Using: ${browserVoice.name}` : "No matching voice found; the default will be used."}>
          <input type="text" value={settings.voice.browserVoice} onChange={(e) => patch({ voice: { browserVoice: e.target.value } })} />
        </Row>
        <Row label="Wake word engine" hint="Porcupine needs VITE_PICOVOICE_ACCESS_KEY; otherwise the browser recogniser listens for “Hey Jarvis”.">
          <select value={settings.voice.wakeWordEngine} onChange={(e) => patch({ voice: { wakeWordEngine: e.target.value as Settings["voice"]["wakeWordEngine"] } })}>
            <option value="auto">Auto</option>
            <option value="porcupine">Porcupine (local)</option>
            <option value="speech">Browser recogniser</option>
          </select>
        </Row>
        <Row label="Wake sensitivity" hint="Porcupine only.">
          <input type="range" min={0} max={1} step={0.05} value={settings.voice.wakeSensitivity} onChange={(e) => patch({ voice: { wakeSensitivity: Number(e.target.value) } })} />
        </Row>
        <Row label="Follow-up window" hint="ms the mic stays open after he answers (always-listening).">
          <input type="number" min={0} max={30000} step={500} value={settings.voice.followUpWindowMs} onChange={(e) => patch({ voice: { followUpWindowMs: Number(e.target.value) } })} />
        </Row>
        <Row label="Volume">
          <input type="range" min={0} max={1} step={0.05} value={settings.voice.volume} onChange={(e) => patch({ voice: { volume: Number(e.target.value) } })} />
        </Row>
        <Row label="Earcons" hint="Short tones on wake / captured / denied.">
          <Toggle value={settings.voice.earcons} onChange={(v) => patch({ voice: { earcons: v } })} />
        </Row>
      </section>

      <section>
        <h2>Screen</h2>
        <Row label="Mode" hint="On-demand grabs a frame when you ask. Watch mode arrives in a later phase.">
          <select value={settings.screen.mode} onChange={(e) => patch({ screen: { mode: e.target.value as Settings["screen"]["mode"] } })}>
            <option value="off">Off</option>
            <option value="on-demand">On demand</option>
            <option value="watch" disabled>Watch (soon)</option>
          </select>
        </Row>
      </section>

      <section>
        <h2>Apps &amp; permissions</h2>
        <p className="muted">
          Calendar &amp; Mail connects a Google account for read-only access. The remaining apps store their toggles
          now and are enforced when wired (Phase 5).
        </p>
        <div className="apps">
          {settings.apps.map((app) => (
            <div key={app.id} className={`app-card ${app.enabled ? "on" : ""}`}>
              <div className="app-head">
                <strong>{app.label}</strong>
                <Toggle value={app.enabled} onChange={(v) => patch({ apps: settings.apps.map((a) => (a.id === app.id ? { ...a, enabled: v } : a)) })} />
              </div>
              <div className="chips">
                <Chip on={app.read} label="Read" onClick={() => patch({ apps: settings.apps.map((a) => (a.id === app.id ? { ...a, read: !a.read } : a)) })} />
                <Chip on={app.write} label="Write" gold onClick={() => patch({ apps: settings.apps.map((a) => (a.id === app.id ? { ...a, write: !a.write } : a)) })} />
                <label className="chk">
                  <input type="checkbox" checked={app.confirmWrites} onChange={(e) => patch({ apps: settings.apps.map((a) => (a.id === app.id ? { ...a, confirmWrites: e.target.checked } : a)) })} />
                  Confirm writes
                </label>
              </div>
              {app.id === "calendar" ? (
                app.enabled ? <GoogleConnection /> : <div className="app-status">Enable to connect an account</div>
              ) : (
                <div className="app-status">Not wired yet</div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="srow">
      <span className="slabel">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <span className="sctl">{children}</span>
    </label>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={value} className={`toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)}>
      <span />
    </button>
  );
}

function Chip({ on, label, gold, onClick }: { on: boolean; label: string; gold?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`chip ${on ? "on" : ""} ${gold ? "gold" : ""}`} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}
