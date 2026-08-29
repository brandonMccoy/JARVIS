import type { ImagePayload } from "@jarvis/shared";
import { store } from "../state/store.ts";
import { socket } from "../ws/client.ts";

/**
 * Screen share (JOBS J4.1, J4.2). Started only from a user gesture — the
 * browser will not let J.A.R.V.I.S. begin one himself.
 */
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;

export function screenActive(): boolean {
  return stream !== null;
}

export async function startShare(): Promise<boolean> {
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
  } catch {
    return false;
  }
  video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const track = stream.getVideoTracks()[0];
  const label = track?.label ?? "screen";
  track?.addEventListener("ended", () => stopShare());
  store.getState().set({ screen: { active: true, label } });
  socket.send({ type: "screen.status", active: true, label });
  return true;
}

export function stopShare(): void {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
  stream = null;
  video = null;
  store.getState().set({ screen: { active: false, label: "" } });
  socket.send({ type: "screen.status", active: false });
}

export async function toggleShare(): Promise<void> {
  if (stream) stopShare();
  else await startShare();
}

/** Downscale to ≤ 1568 px on the long side, JPEG q0.8. */
export function captureFrame(): ImagePayload | null {
  if (!video || video.readyState < 2) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, 1568 / Math.max(vw, vh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  return { mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}
