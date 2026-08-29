import { useStore } from "../state/store.ts";

export function TopBar() {
  const connection = useStore((s) => s.connection);
  const caps = useStore((s) => s.capabilities);
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  const model = useStore((s) => s.settings.brain.model);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">J.A.R.V.I.S.</span>
        <span className={`conn ${connection}`} title={`core ${connection}`} />
        <span className="brand-sub">
          {connection !== "open" ? "core offline" : !caps.anthropic ? "no API key" : model}
        </span>
      </div>
      <button
        type="button"
        className={`icon-btn ${view === "settings" ? "lit" : ""}`}
        title={view === "settings" ? "Back to orb (Esc)" : "Settings"}
        onClick={() => set({ view: view === "settings" ? "main" : "settings" })}
        aria-label="Settings"
      >
        {view === "settings" ? (
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </header>
  );
}
