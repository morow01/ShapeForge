import { useCallback, useEffect, useState } from "react";
import { useDoc } from "../document/store";
import { deleteVersion, listDesignVersions, restoreVersion, runSync, saveVersion, versionAsCopy } from "../drive/sync";
import type { DesignVersion } from "../drive/sync";
import { useDrive } from "../drive/state";
import { useConfirm } from "./ConfirmDialog";

type VersionHistoryDialogProps = {
  open: boolean;
  onClose: () => void;
};

function whenText(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Older versions of the open design, kept in Google Drive: automatic snapshots while editing
 * plus any the person saves by name. Restoring never loses work, because what it replaces
 * is saved as a version first.
 */
export function VersionHistoryDialog({ open, onClose }: VersionHistoryDialogProps) {
  const projectId = useDoc((s) => s.currentProjectId);
  const projectName = useDoc((s) => s.projectName);
  const signedIn = useDrive((s) => s.status) === "signedIn";
  const driveError = useDrive((s) => s.lastError);
  const [versions, setVersions] = useState<DesignVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const { ask, dialog: confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    setBusy(true);
    const list = await runSync(() => listDesignVersions(projectId));
    setVersions(list ?? []);
    setBusy(false);
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    setLabel("");
    if (signedIn) void load();
  }, [open, signedIn, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    // Whatever is on screen is written first, so the version is the latest state.
    useDoc.getState().saveCurrentTo("drive");
    await runSync(() => saveVersion(projectId, label));
    setLabel("");
    await load();
  };

  const restore = async (v: DesignVersion) => {
    const ok = await ask({
      title: "Restore this version?",
      message: `"${projectName}" goes back to how it was on ${whenText(v.at)}. How it is now is saved as a version first, so you can come back to it.`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    setBusy(true);
    useDoc.getState().saveCurrentTo("drive");
    const done = await runSync(() => restoreVersion(projectId, v.id));
    if (done) {
      // Reloads the design from what was just written.
      useDoc.getState().openProject(projectId);
      onClose();
    } else {
      await load();
    }
  };

  const openCopy = async (v: DesignVersion) => {
    setBusy(true);
    const data = await runSync(() => versionAsCopy(projectId, v.id));
    if (data) {
      const meta = useDoc.getState().projects.find((p) => p.id === projectId);
      const id = useDoc.getState().importProjectData(data);
      useDoc.getState().saveCurrentTo("drive");
      if (meta?.folderId) useDoc.getState().moveProjectToFolder(id, meta.folderId);
      onClose();
    } else {
      setBusy(false);
    }
  };

  const remove = async (v: DesignVersion) => {
    const ok = await ask({
      title: "Delete this version?",
      message: `The version from ${whenText(v.at)} will be removed. The design itself is not affected.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    await runSync(() => deleteVersion(v.id));
    await load();
  };

  return (
    <>
    <div className="modal-backdrop" style={{ zIndex: 3000 }} onClick={onClose}>
      <div className="save-dialog version-dialog" role="dialog" aria-label="Version history" onClick={(e) => e.stopPropagation()}>
        <h2>Version history</h2>
        {!signedIn ? (
          <p className="confirm-message">Connect Google Drive from the Home page to keep a history of this design.</p>
        ) : (
          <>
            <p className="confirm-message">
              ShapeForge saves a snapshot of "{projectName}" now and then while you work. Save one yourself
              before a risky change.
            </p>
            <div className="version-save">
              <input
                className="save-name"
                value={label}
                placeholder="Name this version (optional)"
                maxLength={60}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(); }}
              />
              <button className="modal-btn primary" disabled={busy} onClick={() => void save()}>Save version</button>
            </div>
            {driveError && <p className="drive-problem">{driveError}</p>}
            <div className="version-list">
              {versions === null ? (
                <p className="version-empty">Loading…</p>
              ) : versions.length === 0 ? (
                <p className="version-empty">No versions yet. The first snapshot appears after your next change syncs.</p>
              ) : (
                versions.map((v, i) => (
                  <div key={v.id} className="version-row">
                    <div className="version-text">
                      <b>{v.label ?? (v.manual ? "Saved version" : "Automatic snapshot")}</b>
                      <span>
                        {whenText(v.at)}
                        {v.shapes !== null ? ` · ${v.shapes} ${v.shapes === 1 ? "shape" : "shapes"}` : ""}
                        {i === 0 ? " · latest" : ""}
                      </span>
                    </div>
                    <div className="version-actions">
                      <button className="modal-btn" disabled={busy} onClick={() => void restore(v)}>Restore</button>
                      <button className="modal-btn" disabled={busy} onClick={() => void openCopy(v)} title="Open it as a separate design">Open as copy</button>
                      <button className="home-link version-delete" disabled={busy} onClick={() => void remove(v)}>Delete</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
        <div className="save-buttons">
          <button className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
    {confirmDialog}
    </>
  );
}
