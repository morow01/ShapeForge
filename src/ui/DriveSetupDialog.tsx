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
          ShapeForge saves into your own Google Drive, in a folder it creates, and can only see the files it
          made itself. Google asks every app to register once. It is free and takes about ten minutes. Use the
          Google account you want your designs stored in.
        </p>
        <ol className="drive-steps">
          <li>
            <b>Make a project.</b> Open{" "}
            <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Create project</a>,
            type <code>ShapeForge</code> as the name, and click <b>Create</b>. Then check the project name at the top
            left of the page says ShapeForge (click it to switch if not).
          </li>
          <li>
            <b>Turn on Drive.</b> Open the{" "}
            <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API page</a>{" "}
            and click the blue <b>Enable</b> button.
          </li>
          <li>
            <b>Set up the sign-in screen.</b> Open{" "}
            <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a>{" "}
            and click <b>Get started</b>. Then:
            <ul>
              <li><b>App information:</b> App name <code>ShapeForge</code>, User support email: choose your email. Next.</li>
              <li><b>Audience:</b> choose <b>External</b>. Next.</li>
              <li><b>Contact information:</b> type your email. Next.</li>
              <li><b>Finish:</b> tick the agreement box, click <b>Continue</b>, then <b>Create</b>.</li>
            </ul>
          </li>
          <li>
            <b>Allow yourself to sign in.</b> In the left menu click <b>Audience</b>. Under <b>Test users</b> click{" "}
            <b>+ Add users</b>, type your Gmail address, and click <b>Save</b>. (While the app is in Testing, only
            listed people can sign in.)
          </li>
          <li>
            <b>Allow the Drive permission.</b> In the left menu click <b>Data Access</b>, then{" "}
            <b>Add or remove scopes</b>. In the filter box type <code>drive.file</code>, tick the row ending{" "}
            <code>/auth/drive.file</code>, click <b>Update</b> at the bottom, then <b>Save</b>.
          </li>
          <li>
            <b>Make the sign-in ID.</b> In the left menu click <b>Clients</b>, then <b>+ Create client</b>.
            <ul>
              <li>Application type: <b>Web application</b>. Name: <code>ShapeForge web</code>.</li>
              <li>
                Under <b>Authorised JavaScript origins</b> click <b>+ Add URI</b> and enter{" "}
                <code>{origin}</code>. Click <b>+ Add URI</b> again and enter <code>https://morow01.github.io</code>{" "}
                if you also use the website. Origins have no path and no trailing slash.
              </li>
              <li>Leave Authorised redirect URIs empty. Click <b>Create</b>.</li>
            </ul>
          </li>
          <li>
            <b>Copy the Client ID</b> from the box that appears (it ends in <code>.apps.googleusercontent.com</code>;
            you can find it again later under Clients). Paste it below and click Save.
          </li>
        </ol>
        <p className="drive-note">
          <b>First sign-in:</b> Google will say the app isn't verified. That is expected for your own app. Click{" "}
          <b>Advanced</b>, then <b>Go to ShapeForge (unsafe)</b>, then allow access.<br />
          <b>If you see "origin_mismatch"</b>, the address in step 6 doesn't match the page you are on.{" "}
          <b>If you see "access denied"</b>, add that Gmail address in step 4.
        </p>
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
