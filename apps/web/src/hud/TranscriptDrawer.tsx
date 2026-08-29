import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store.ts";
import { socket } from "../ws/client.ts";

/** JOBS J0.23 + J2.14 — collapsible transcript that prints what he says as he says it. */
export function TranscriptDrawer() {
  const open = useStore((s) => s.settings.hud.transcriptOpen);
  const transcript = useStore((s) => s.transcript);
  const live = useStore((s) => s.live);
  const interim = useStore((s) => s.interim);
  const connection = useStore((s) => s.connection);
  const metrics = useStore((s) => s.lastMetrics);
  const cost = useStore((s) => s.sessionCostUsd);
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinned || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [transcript, live?.revealed, interim, pinned]);

  const toggle = () => socket.send({ type: "settings.patch", patch: { hud: { transcriptOpen: !open } } });

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    socket.send({ type: "user.utterance", text: t, source: "text" });
    setText("");
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const copy = () => {
    const lines = transcript.map((e) => `${e.role === "assistant" ? "J.A.R.V.I.S." : e.role === "user" ? "You" : e.role}: ${e.text}`);
    void navigator.clipboard?.writeText(lines.join("\n"));
  };

  return (
    <section className={`drawer ${open ? "open" : ""}`} aria-label="Transcript">
      <header className="drawer-head">
        <button type="button" className="drawer-toggle" onClick={toggle} aria-expanded={open} title="Toggle transcript (Shift+T)">
          <span className="chev">{open ? "▾" : "▸"}</span> Transcript
        </button>
        <div className="drawer-meta">
          {metrics?.ttfwMs ? <span title="time to first word">{metrics.ttfwMs} ms</span> : null}
          {metrics?.model ? <span>{metrics.model.replace("claude-", "")}</span> : null}
          {cost > 0 ? <span>${cost.toFixed(4)}</span> : null}
        </div>
        <div className="drawer-actions">
          <button type="button" onClick={copy} title="Copy transcript">Copy</button>
          <button type="button" onClick={() => socket.send({ type: "session.new" })} title="New session">New session</button>
        </div>
      </header>

      {open ? (
        <>
          <div className="drawer-list" ref={listRef} onScroll={onScroll}>
            {transcript.length === 0 && !live ? (
              <div className="row system"><span className="who" /><span className="txt">Say “Hey Jarvis”, press Space, or type below.</span></div>
            ) : null}
            {transcript.map((e) => (
              <div key={e.id} className={`row ${e.role}`}>
                <span className="who">{e.role === "assistant" ? "J.A.R.V.I.S." : e.role === "user" ? "You" : e.role === "tool" ? "·" : "!"}</span>
                <span className="txt">
                  {e.text}
                  {e.truncated ? <em className="trunc"> — interrupted</em> : null}
                </span>
              </div>
            ))}
            {live && (live.revealed || !live.done) ? (
              <div className="row assistant live">
                <span className="who">J.A.R.V.I.S.</span>
                <span className="txt">{live.revealed}{!live.done || live.revealed !== live.streamed ? <span className="cursor" /> : null}</span>
              </div>
            ) : null}
            {interim ? (
              <div className="row user interim"><span className="who">You</span><span className="txt">{interim}</span></div>
            ) : null}
          </div>
          <form
            className="drawer-input"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={connection === "open" ? "Type to J.A.R.V.I.S.…" : "Core offline — reconnecting…"}
              aria-label="Message"
              autoComplete="off"
            />
            <button type="submit" disabled={!text.trim()}>Send</button>
          </form>
        </>
      ) : null}
    </section>
  );
}
