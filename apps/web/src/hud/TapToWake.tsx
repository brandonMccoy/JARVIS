import { useStore } from "../state/store.ts";
import { unlockAudio, earcon } from "../voice/audio.ts";

/** JOBS J2.1 — the one user gesture the browser requires before audio can play. */
export function TapToWake() {
  const awake = useStore((s) => s.awake);
  const set = useStore((s) => s.set);
  if (awake) return null;
  const wake = async () => {
    await unlockAudio();
    set({ awake: true });
    earcon("wake");
  };
  return (
    <button type="button" className="wake-overlay" onClick={() => void wake()}>
      <span className="wake-title">J.A.R.V.I.S.</span>
      <span className="wake-sub">Tap to wake</span>
    </button>
  );
}
