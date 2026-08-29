import { useEffect, useState } from "react";
import { useStore } from "../state/store.ts";

const LABELS: Record<string, string> = {
  idle: "",
  listening: "Listening…",
  thinking: "Thinking…",
  researching: "Researching",
  viewing_screen: "Viewing screen",
  tool: "Working",
  awaiting_confirmation: "Awaiting your confirmation, Sir",
  speaking: "Speaking",
};

/** JOBS J0.24 — driven by core events; 30 s watchdog resets to idle. */
export function ActivityIndicator() {
  const activity = useStore((s) => s.activity);
  const micOpen = useStore((s) => s.micOpen);
  const setActivity = useStore((s) => s.setActivity);
  const connection = useStore((s) => s.connection);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    setStale(false);
    if (activity.kind === "idle") return;
    const t = window.setTimeout(() => {
      setStale(true);
      setActivity({ kind: "idle" });
    }, 30_000);
    return () => window.clearTimeout(t);
  }, [activity, setActivity]);

  let kind: string = activity.kind;
  let label = LABELS[kind] ?? "";
  let detail = activity.detail ?? "";
  if (kind === "idle" && micOpen) {
    kind = "listening";
    label = LABELS.listening!;
  }
  if (kind === "tool" && detail) {
    label = detail;
    detail = "";
  }
  if (connection !== "open") {
    kind = "offline";
    label = connection === "connecting" ? "Reconnecting…" : "Core offline";
    detail = "";
  }

  return (
    <div className={`activity ${kind}`} aria-live="polite" data-stale={stale || undefined}>
      {label ? (
        <>
          <span className="dot" />
          <span className="label">{label}</span>
          {detail ? <span className="detail">“{detail}”</span> : null}
        </>
      ) : null}
    </div>
  );
}
