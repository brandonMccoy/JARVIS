import { useEffect } from "react";
import { handleServerEvent, interrupt } from "./app/events.ts";
import { ActivityIndicator } from "./hud/ActivityIndicator.tsx";
import { ControlDock } from "./hud/ControlDock.tsx";
import { TapToWake } from "./hud/TapToWake.tsx";
import { TopBar } from "./hud/TopBar.tsx";
import { TranscriptDrawer } from "./hud/TranscriptDrawer.tsx";
import { Orb } from "./orb/Orb.tsx";
import { toggleShare } from "./screen/share.ts";
import { SettingsPage } from "./settings/SettingsPage.tsx";
import { useStore } from "./state/store.ts";
import { assistantSpeaking, listening } from "./voice/listening.ts";
import { socket } from "./ws/client.ts";

export function App() {
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);

  useEffect(() => {
    const off = socket.on(handleServerEvent);
    socket.connect();
    return () => {
      off();
      socket.close();
    };
  }, []);

  // Keyboard shortcuts (PLAN §6.1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (e.key === "Escape") {
        if (useStore.getState().view === "settings") set({ view: "main" });
        else interrupt();
        return;
      }
      if (typing) return;
      const s = useStore.getState();
      if (e.key === " ") {
        e.preventDefault();
        if (assistantSpeaking()) interrupt();
        else listening.listenOnce();
        return;
      }
      // Letter shortcuts need Shift so stray typing can't start a screen share.
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "l":
          void listening.setMode(s.settings.hud.listening === "always" ? "off" : "always");
          break;
        case "s":
          void toggleShare();
          break;
        case "t":
          socket.send({ type: "settings.patch", patch: { hud: { transcriptOpen: !s.settings.hud.transcriptOpen } } });
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  const onOrbClick = () => {
    if (!useStore.getState().awake) return;
    if (assistantSpeaking()) interrupt();
    else listening.listenOnce();
  };

  return (
    <div className="app">
      <TopBar />
      <Orb onClick={onOrbClick} />
      {view === "settings" ? (
        <main className="page">
          <SettingsPage />
        </main>
      ) : (
        <main className="hud">
          <ActivityIndicator />
          <ControlDock />
        </main>
      )}
      <TranscriptDrawer />
      <TapToWake />
    </div>
  );
}
