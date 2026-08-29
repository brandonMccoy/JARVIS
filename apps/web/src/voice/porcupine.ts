/**
 * Optional local wake word via Picovoice Porcupine (JOBS J2.7).
 * Requires VITE_PICOVOICE_ACCESS_KEY and the model file at /porcupine_params.pv
 * (copy from node_modules/@picovoice/porcupine-web or the Picovoice repo into apps/web/public/).
 * Loaded lazily; when unavailable the speech-recogniser fallback is used.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
let worker: any = null;
let processorMod: any = null;

export function porcupineConfigured(): boolean {
  return Boolean(import.meta.env.VITE_PICOVOICE_ACCESS_KEY);
}

export async function startPorcupine(sensitivity: number, onWake: () => void): Promise<boolean> {
  const accessKey = import.meta.env.VITE_PICOVOICE_ACCESS_KEY as string | undefined;
  if (!accessKey) return false;
  try {
    const porcupine: any = await import("@picovoice/porcupine-web");
    processorMod = await import("@picovoice/web-voice-processor");
    const keyword = { builtin: porcupine.BuiltInKeyword.Jarvis, sensitivity };
    worker = await porcupine.PorcupineWorker.create(
      accessKey,
      [keyword],
      () => onWake(),
      { publicPath: "/porcupine_params.pv", forceWrite: true },
    );
    await processorMod.WebVoiceProcessor.subscribe(worker);
    return true;
  } catch (err) {
    console.warn("Porcupine unavailable, falling back to speech recogniser:", err);
    await stopPorcupine();
    return false;
  }
}

export async function stopPorcupine(): Promise<void> {
  try {
    if (worker && processorMod) await processorMod.WebVoiceProcessor.unsubscribe(worker);
    if (worker) {
      await worker.release?.();
      worker.terminate?.();
    }
  } catch {
    /* ignore */
  }
  worker = null;
}
