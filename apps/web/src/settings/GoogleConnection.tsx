import { useState } from "react";
import type { ConnectionState } from "@jarvis/shared";
import { useStore } from "../state/store.ts";
import { socket } from "../ws/client.ts";
import { Modal } from "../ui/Modal.tsx";

/**
 * Connect a Google account (docs/CONNECTIONS.md §4).
 *
 * The tile stays small — a status pill and one button. Everything else lives in
 * a modal, because the OAuth client is the user's own and the first run is a
 * genuine six-step chore that will not fit in a 220px card.
 */
export function GoogleConnection() {
  const conn = useStore((s) => s.connections.find((c) => c.provider === "google"));
  const pending = useStore((s) => s.connectionPending === "google");
  const [open, setOpen] = useState(false);

  const status = conn?.status ?? "unconfigured";

  return (
    <div className="acct">
      <div className="acct-head">
        <span className="acct-provider">Google</span>
        <StatusPill status={status} pending={pending} />
      </div>

      {status === "active" && conn?.account ? (
        <div className="acct-account" title={conn.account}>
          {conn.account}
        </div>
      ) : null}

      <button type="button" className="acct-open" onClick={() => setOpen(true)}>
        {status === "active" ? "Manage connection" : "Set up connection"}
      </button>

      <Modal open={open} title="Connect Google" onClose={() => setOpen(false)}>
        <GoogleSetup conn={conn} pending={pending} />
      </Modal>
    </div>
  );
}

function GoogleSetup({ conn, pending }: { conn?: ConnectionState; pending: boolean }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showClientForm, setShowClientForm] = useState(false);

  const status = conn?.status ?? "unconfigured";
  const configured = status !== "unconfigured";

  const saveClient = () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    socket.send({
      type: "connection.configure",
      provider: "google",
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });
    setClientSecret("");
    setShowClientForm(false);
  };

  if (status === "active") {
    return (
      <>
        <p className="muted">
          Connected{conn?.account ? <> as <code>{conn.account}</code></> : null}. {describeScopes(conn?.scopes ?? [])}
        </p>
        <p className="muted">
          J.A.R.V.I.S. can read your agenda and search your mail. He cannot create events, send, or delete
          anything — the connection only ever requested read access.
        </p>
        <div className="modal-actions">
          <button type="button" className="danger" onClick={() => socket.send({ type: "connection.disconnect", provider: "google" })}>
            Disconnect
          </button>
          <button type="button" className="ghost" onClick={() => setShowClientForm((v) => !v)}>
            Replace OAuth client
          </button>
        </div>
        {showClientForm ? (
          <ClientForm
            clientId={clientId}
            clientSecret={clientSecret}
            setClientId={setClientId}
            setClientSecret={setClientSecret}
            onSave={saveClient}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {conn?.error ? <p className="warn">{conn.error}</p> : null}

      <p className="muted">
        Read-only access to Google Calendar and Gmail. You create the OAuth client in your own Google Cloud
        project, so your data is never routed through anyone else.
      </p>

      <ol className="setup-steps">
        <li>
          Create a project in the{" "}
          <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
            Google Cloud Console
          </a>
          .
        </li>
        <li>
          Under <em>APIs &amp; Services → Library</em>, enable <strong>Google Calendar API</strong> and{" "}
          <strong>Gmail API</strong>.
        </li>
        <li>
          Under <em>OAuth consent screen</em>, choose <strong>External</strong> and fill in an app name and your
          email.
        </li>
        <li>
          Set the publishing status to <strong>In production</strong>.
          <small>
            This is the step people skip. Left in <em>Testing</em>, Google expires the login after 7 days and you
            would have to reconnect every week. Publishing removes that — verification is a separate thing and is
            not needed here.
          </small>
        </li>
        <li>
          Under <em>Credentials → Create credentials → OAuth client ID</em>, choose application type{" "}
          <strong>Desktop app</strong>.
        </li>
        <li>Paste the client ID and secret below.</li>
      </ol>

      <p className="muted">
        On first connect Google shows a “hasn’t verified this app” warning, because the app is your own and
        unverified. Choose <em>Advanced → Go to …</em> to continue.
      </p>

      {configured && !showClientForm ? (
        <p className="muted">OAuth client saved.</p>
      ) : (
        <ClientForm
          clientId={clientId}
          clientSecret={clientSecret}
          setClientId={setClientId}
          setClientSecret={setClientSecret}
          onSave={saveClient}
        />
      )}

      <div className="modal-actions">
        <button
          type="button"
          disabled={!configured || pending}
          onClick={() => socket.send({ type: "connection.start", provider: "google" })}
        >
          {pending ? "Waiting for consent…" : "Connect"}
        </button>
        {configured && !showClientForm ? (
          <button type="button" className="ghost" onClick={() => setShowClientForm(true)}>
            Replace OAuth client
          </button>
        ) : null}
      </div>

      {pending ? <p className="muted">A browser tab has opened. Approve access there, then return here.</p> : null}
    </>
  );
}

function ClientForm({
  clientId,
  clientSecret,
  setClientId,
  setClientSecret,
  onSave,
}: {
  clientId: string;
  clientSecret: string;
  setClientId: (v: string) => void;
  setClientSecret: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="acct-setup">
      <label className="acct-field">
        <span>Client ID</span>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="…apps.googleusercontent.com"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="acct-field">
        <span>Client secret</span>
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="GOCSPX-…"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="modal-actions">
        <button type="button" disabled={!clientId.trim() || !clientSecret.trim()} onClick={onSave}>
          Save client
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status, pending }: { status: string; pending: boolean }) {
  if (pending) return <span className="pill wait">Connecting…</span>;
  switch (status) {
    case "active":
      return <span className="pill on">Connected</span>;
    case "expired":
    case "revoked":
      return <span className="pill bad">Reconnect</span>;
    case "disconnected":
      return <span className="pill">Not connected</span>;
    default:
      return <span className="pill">Not set up</span>;
  }
}

function describeScopes(scopes: string[]): string {
  const has = (s: string) => scopes.some((x) => x.includes(s));
  const parts = [has("calendar") && "Calendar", has("gmail") && "Gmail"].filter(Boolean);
  return parts.length ? `Read-only access to ${parts.join(" and ")}.` : "No data scopes were granted.";
}
