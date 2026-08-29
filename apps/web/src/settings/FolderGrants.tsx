import { useEffect, useState } from "react";
import { FOLDERS_KEY, folderGrants, type AppPermission, type FolderGrant, type SettingsPatch } from "@jarvis/shared";
import { useStore } from "../state/store.ts";
import { socket } from "../ws/client.ts";
import { Modal } from "../ui/Modal.tsx";

/**
 * The Filesystem app's permission surface.
 *
 * Access is per folder, so this card has no Read/Write chips and no
 * confirm-writes checkbox: a grant *is* the permission, and its Write flag is
 * the authorisation. That decision is made once, here, looking at the list —
 * rather than as a prompt before every write, which only teaches you to say
 * yes without reading.
 */
export function FolderGrants({
  app,
  apps,
  patch,
}: {
  app: AppPermission;
  apps: AppPermission[];
  patch: (p: SettingsPatch) => void;
}) {
  const [picking, setPicking] = useState(false);
  const grants = folderGrants(app);

  const save = (next: FolderGrant[]) =>
    patch({ apps: apps.map((a) => (a.id === app.id ? { ...a, scope: { ...a.scope, [FOLDERS_KEY]: next } } : a)) });

  const add = (path: string) => {
    if (grants.some((g) => g.path === path)) return;
    save([...grants, { path, write: false }]);
    setPicking(false);
  };

  return (
    <>
      {grants.length === 0 ? (
        <div className="app-status">No folders shared. J.A.R.V.I.S. cannot see any of your files.</div>
      ) : (
        <ul className="grants">
          {grants.map((g) => (
            <li key={g.path}>
              <code title={g.path}>{g.path}</code>
              <div className="grant-actions">
                <button
                  type="button"
                  className={`chip ${g.write ? "on gold" : ""}`}
                  aria-pressed={g.write}
                  title={g.write ? "Writable — J.A.R.V.I.S. can change files here" : "Read-only"}
                  onClick={() => save(grants.map((x) => (x.path === g.path ? { ...x, write: !x.write } : x)))}
                >
                  {g.write ? "Read + write" : "Read only"}
                </button>
                <button
                  type="button"
                  className="grant-remove"
                  aria-label={`Stop sharing ${g.path}`}
                  onClick={() => save(grants.filter((x) => x.path !== g.path))}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="acct-open" onClick={() => setPicking(true)}>
        Add a folder
      </button>
      <p className="app-status">Sharing a folder also shares everything inside it.</p>

      <FolderPicker open={picking} onClose={() => setPicking(false)} onPick={add} />
    </>
  );
}

/**
 * Core does the walking: a browser tab cannot turn a chosen directory into an
 * absolute path, so typing one by hand would be the alternative — and a typo
 * that silently grants the wrong folder is exactly the mistake worth avoiding
 * on a permission screen.
 */
function FolderPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const listing = useStore((s) => s.fsListing);

  useEffect(() => {
    if (open) socket.send({ type: "fs.browse" });
  }, [open]);

  return (
    <Modal open={open} title="Add a folder" onClose={onClose}>
      <p className="muted">
        Pick a folder to share. J.A.R.V.I.S. will be able to read everything inside it, including subfolders. Files
        that look like credentials — <code>.env</code>, keys, <code>.ssh</code> — are always refused.
      </p>

      <div className="picker-path">
        <code>{listing?.path ?? "This computer"}</code>
      </div>

      {listing?.error ? <p className="warn">{listing.error}</p> : null}

      <ul className="picker">
        {listing?.parent !== undefined || listing?.path ? (
          <li>
            <button type="button" onClick={() => socket.send({ type: "fs.browse", path: listing?.parent })}>
              ../ <span className="muted">up</span>
            </button>
          </li>
        ) : null}
        {(listing?.entries ?? []).map((e) => (
          <li key={e.path}>
            <button type="button" onClick={() => socket.send({ type: "fs.browse", path: e.path })}>
              {e.name}/
            </button>
          </li>
        ))}
        {listing && !listing.entries.length && !listing.error ? (
          <li className="muted">No subfolders here.</li>
        ) : null}
      </ul>

      <div className="modal-actions">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" disabled={!listing?.path} onClick={() => listing?.path && onPick(listing.path)}>
          Share this folder
        </button>
      </div>
    </Modal>
  );
}
