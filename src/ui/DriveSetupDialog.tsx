import { useEffect, useState } from "react";
import { getClientId, looksLikeClientId, setClientId } from "../drive/config";
import { useDrive } from "../drive/state";

type DriveSetupDialogProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * One-time set-up: Google needs to know which app is asking, so a free "client ID" is made in
 * the Google Cloud console and pasted here. It is not a password and is safe to share.
 */
export function DriveSetupDialog({ open, onClose }: DriveSetupDialogProps) {
  const setConfigured = useDrive((s) => s.setConfigured);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(getClientId());
      setProblem(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const origin = window.location.origin;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setClientId("");
      setConfigured(false);
      onClose();
      return;
    }
    if (!looksLikeClientId(trimmed)) {
      setProblem("That doesn't look like a client ID. It ends in .apps.googleusercontent.com");
      return;
    }
    setClientId(trimmed);
    setConfigured(true);
    onClose();
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 3000 }} onClick={onClose}>
      <div className="save-dialog drive-setup" role="dialog" aria-label="Set up Google Drive" onClick={(e) => e.stopPropagation()}>
        <h2>Set up Google Drive</h2>
        <p className="confirm-message">
          ShapeForge saves into your own Google Drive, in a folder it creates. Google asks every app to
          register once. It takes about five minutes and is free.
        </p>
        <ol className="drive-steps">
          <li>
            Open the{" "}
            <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud console</a>{" "}
            and create a project named ShapeForge.
          </li>
          <li>
            Turn on the{" "}
            <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API</a>{" "}
            for that project.
          </li>
          <li>
            Under <b>OAuth consent screen</b>, choose <b>External</b>, name it ShapeForge, add your email, and add
            yourself as a <b>test user</b>. In Scopes add <code>.../auth/drive.file</code>.
          </li>
          <li>
            Under <b>Credentials</b>, create an <b>OAuth client ID</b> of type <b>Web application</b>. Under
            Authorised JavaScript origins add <code>{origin}</code> (and <code>https://morow01.github.io</code> for the website).
          </li>
          <li>Copy the Client ID it shows and paste it below.</li>
        </ol>
        <label className="save-label" htmlFor="drive-client-id">Client ID</label>
        <input
          id="drive-client-id"
          className="save-name"
          value={value}
          placeholder="123456789-abc123.apps.googleusercontent.com"
          onChange={(e) => { setValue(e.target.value); setProblem(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          autoFocus
          spellCheck={false}
        />
        {problem && <p className="drive-problem">{problem}</p>}
        <div className="save-buttons">
          <button className="modal-btn" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}
