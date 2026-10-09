import { useEffect, useState } from "react";
import type { ProjectLocation } from "../document/types";
import { connectDrive } from "../drive/actions";
import { useDrive } from "../drive/state";

type SaveDialogProps = {
  open: boolean;
  name: string;
  onClose: () => void;
  onSave: (name: string, location: ProjectLocation) => void;
};

/**
 * Asked the first time a new design is saved: where should it live? Until now the
 * design is a draft, kept in this browser so nothing is lost, but with no home chosen.
 * Google Drive is offered once it is connected; until then the row explains how.
 */
export function SaveDialog({ open, name, onClose, onSave }: SaveDialogProps) {
  const [draftName, setDraftName] = useState(name);
  const [location, setLocation] = useState<ProjectLocation>("browser");
  const driveConfigured = useDrive((s) => s.configured);
  const driveStatus = useDrive((s) => s.status);
  const driveEmail = useDrive((s) => s.email);
  const signedIn = driveStatus === "signedIn";

  // Once connected from this dialog, Drive is the natural choice.
  useEffect(() => {
    if (open && signedIn) setLocation("drive");
  }, [open, signedIn]);

  useEffect(() => {
    if (open) setDraftName(name);
  }, [open, name]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => onSave(draftName.trim() || "Untitled Project", location);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="save-dialog" role="dialog" aria-label="Save design" onClick={(e) => e.stopPropagation()}>
        <h2>Save design</h2>
        <label className="save-label" htmlFor="save-name">Name</label>
        <input
          id="save-name"
          className="save-name"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          autoFocus
        />
        <div className="save-label">Where should it be kept?</div>
        <label className={`save-choice${location === "browser" ? " on" : ""}`}>
          <input type="radio" name="save-where" checked={location === "browser"} onChange={() => setLocation("browser")} />
          <span className="save-choice-text">
            <b>This browser</b>
            <span>Stays on this computer. Clearing this site's data erases it, so download a backup now and then.</span>
          </span>
        </label>
        <label className={`save-choice${location === "drive" ? " on" : ""}${signedIn ? "" : " disabled"}`}>
          <input type="radio" name="save-where" checked={location === "drive"} disabled={!signedIn} onChange={() => setLocation("drive")} />
          <span className="save-choice-text">
            <b>Google Drive</b>
            <span>
              {signedIn
                ? `Saved to the ShapeForge folder in ${driveEmail ?? "your Drive"}, and available on every computer you sign in on.`
                : driveConfigured
                  ? "Your own Drive, available on every computer you sign in on."
                  : "Set up Google Drive from the Home page first."}
            </span>
            {!signedIn && driveConfigured && (
              <button type="button" className="modal-btn primary save-connect" disabled={driveStatus === "connecting"} onClick={() => void connectDrive()}>
                {driveStatus === "connecting" ? "Connecting…" : "Connect Google Drive"}
              </button>
            )}
          </span>
        </label>
        <div className="save-buttons">
          <button className="modal-btn" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}
