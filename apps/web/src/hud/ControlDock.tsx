import { useStore } from "../state/store.ts";
import { listening } from "../voice/listening.ts";
import { toggleShare } from "../screen/share.ts";

/** JOBS J2.6 — three icon buttons: always listening / listen once / view screen. */
export function ControlDock() {
  const mode = useStore((s) => s.settings.hud.listening);
  const micOpen = useStore((s) => s.micOpen);
  const screen = useStore((s) => s.screen);
  const wakeEngine = useStore((s) => s.wakeEngine);

  const always = mode === "always";

  return (
    <div className="dock" role="toolbar" aria-label="Controls">
      <button
        type="button"
        className={`dock-btn ${always ? "lit" : ""} ${always && micOpen ? "pulse" : ""}`}
        aria-pressed={always}
        title={`Always listening (Shift+L)${wakeEngine === "porcupine" ? " · local wake word" : wakeEngine === "speech" ? " · browser recogniser" : ""}`}
        onClick={() => void listening.setMode(always ? "off" : "always")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 13a8 8 0 0 1 16 0v4a2 2 0 0 1-2 2h-1v-6h3M4 13v4a2 2 0 0 0 2 2h1v-6H4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Always</span>
      </button>

      <button
        type="button"
        className={`dock-btn big ${micOpen && !always ? "lit pulse" : ""}`}
        title="Listen once (Space)"
        onClick={() => listening.listenOnce()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span>Once</span>
      </button>

      <button
        type="button"
        className={`dock-btn ${screen.active ? "lit gold" : ""}`}
        aria-pressed={screen.active}
        title={screen.active ? `Stop viewing (${screen.label})` : "View screen (Shift+S)"}
        onClick={() => void toggleShare()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 20h8M12 16v4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          {screen.active ? <circle cx="12" cy="10" r="2.2" fill="currentColor" /> : null}
        </svg>
        <span>View</span>
      </button>
    </div>
  );
}
