import { useEffect, useRef, useState } from "react";
import { APP_VERSION } from "../version";
import { runSync, syncNotesWithDrive } from "../drive/sync";
import { useDrive } from "../drive/state";

// TEMPORARY dev aid: a scratch pad for feedback while the app is being built.
// Notes are saved to FEEDBACK-NOTES.json in the project root through the Vite
// dev server (see vite.config.ts), so they can be read straight from disk. When
// that endpoint isn't there (built app), they fall back to localStorage.
// To remove: delete this file, its <FeedbackNotes/> line in App.tsx, the
// `feedbackNotesPlugin` in vite.config.ts and the .feedback-* rules in style.css.

interface Note { id: string; text: string; version: string; at: number; done: boolean; updatedAt?: number }

const LS_KEY = "shapeforge.feedbackNotes";
// Notes deleted on this computer, remembered so the delete reaches Drive and the other computers too.
const DELETED_KEY = "shapeforge.feedbackNotes.deleted";

function readDeleted(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(DELETED_KEY) ?? "{}"); } catch { return {}; }
}
function writeDeleted(d: Record<string, number>) {
  try { localStorage.setItem(DELETED_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}
const ENDPOINT = "/__feedback";

function readLocal(): Note[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}

const svg = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const NoteIcon = () => <svg {...svg} width={20} height={20}><path d="M4 4h16v12H9l-5 4z" /><path d="M8 9h8M8 12h5" /></svg>;
const EditIcon = () => <svg {...svg}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>;
const TrashIcon = () => <svg {...svg}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;

export function FeedbackNotes() {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [toDisk, setToDisk] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const loaded = useRef(false);
  const [ready, setReady] = useState(false);
  const notesRef = useRef<Note[]>([]);
  const deletedRef = useRef<Record<string, number>>(readDeleted());
  const lastSig = useRef("");
  const syncTimer = useRef<number | undefined>(undefined);
  const driveStatus = useDrive((s) => s.status);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : Promise.reject()))
      .then((d: Note[]) => { notesRef.current = d; setNotes(d); setToDisk(true); })
      .catch(() => { const d = readLocal(); notesRef.current = d; setNotes(d); })
      .finally(() => { loaded.current = true; setReady(true); });
  }, []);

  // While connected to Google Drive the notes are kept level with the copy there, so every computer sees them.
  useEffect(() => {
    if (open) lastSig.current = "";
  }, [open]);
  useEffect(() => {
    if (driveStatus !== "signedIn" || !ready) return;
    const signature = JSON.stringify(notes) + JSON.stringify(deletedRef.current);
    if (signature === lastSig.current) return;
    window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(async () => {
      const result = await runSync(() => syncNotesWithDrive(notesRef.current, deletedRef.current));
      if (!result) return;
      deletedRef.current = result.deleted;
      writeDeleted(result.deleted);
      lastSig.current = JSON.stringify(result.notes) + JSON.stringify(result.deleted);
      if (JSON.stringify(result.notes) !== JSON.stringify(notesRef.current)) save(result.notes as Note[]);
    }, 1500);
    return () => window.clearTimeout(syncTimer.current);
    // save only writes locally, so it is left out on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, driveStatus, ready, open]);

  const save = (next: Note[], removed: string[] = []) => {
    notesRef.current = next;
    if (removed.length) {
      const stamp = Date.now();
      const d = { ...deletedRef.current };
      for (const id of removed) d[id] = stamp;
      deletedRef.current = d;
      writeDeleted(d);
    }
    setNotes(next);
    if (!loaded.current) return;
    if (toDisk) {
      fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next, null, 2) }).catch(() => {});
    } else {
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    }
  };

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const now = Date.now();
    save([{ id: String(now), text, version: APP_VERSION, at: now, updatedAt: now, done: false }, ...notes]);
    setDraft("");
  };

  const commitEdit = () => {
    const text = editText.trim();
    if (editId && text) save(notes.map((m) => (m.id === editId ? { ...m, text, updatedAt: Date.now() } : m)));
    setEditId(null);
  };

  const openCount = notes.filter((n) => !n.done).length;

  return (
    <>
      <button className="feedback-fab" onClick={() => setOpen((o) => !o)} title="Feedback notes (temporary)">
        <NoteIcon />{openCount > 0 && <span className="feedback-count">{openCount}</span>}
      </button>
      {open && (
        <div className="feedback-panel">
          <div className="feedback-head">
            <strong>Feedback notes</strong>
            <span className="feedback-where">{(toDisk ? "saved to FEEDBACK-NOTES.json" : "saved in browser") + (driveStatus === "signedIn" ? " · synced with Google Drive" : "")}</span>
            <button onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          <textarea
            value={draft}
            placeholder="What would you change? (Ctrl+Enter to add)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) add(); }}
            rows={3}
          />
          <div className="feedback-actions">
            <button onClick={add} disabled={!draft.trim()}>Add note</button>
          </div>
          <ul className="feedback-list">
            {notes.length === 0 && <li className="feedback-empty">No notes yet.</li>}
            {notes.map((n) => (
              <li key={n.id} className={n.done ? "done" : ""}>
                <input type="checkbox" checked={n.done} title="Mark done" onChange={() => save(notes.map((m) => (m.id === n.id ? { ...m, done: !m.done, updatedAt: Date.now() } : m)))} />
                <div>
                  {editId === n.id ? (
                    <>
                      <textarea
                        autoFocus
                        value={editText}
                        rows={3}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setEditId(null); else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commitEdit(); }}
                      />
                      <div className="feedback-edit-actions">
                        <button className="save" onClick={commitEdit} disabled={!editText.trim()}>Save</button>
                        <button onClick={() => setEditId(null)}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <div className="feedback-text" onDoubleClick={() => { setEditId(n.id); setEditText(n.text); }}>{n.text}</div>
                  )}
                  <div className="feedback-meta">v{n.version} · {new Date(n.at).toLocaleString()}</div>
                </div>
                <button title="Edit (or double-click the text)" onClick={() => { setEditId(n.id); setEditText(n.text); }}><EditIcon /></button>
                <button title="Delete" onClick={() => save(notes.filter((m) => m.id !== n.id), [n.id])}><TrashIcon /></button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
