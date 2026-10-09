import { useEffect, useRef, useState } from "react";
import { useDoc } from "../document/store";
import { MAX_TAG_LENGTH, cleanTag, sameTag, uniqueTags } from "../document/tags";
import type { ProjectMeta } from "../document/types";
import { TagIcon } from "./NavIcons";

/** Offered until the person has tags of their own, so there is something to click straight away. */
const SAMPLE_TAGS = ["Idea", "Prototype", "Final", "Printed", "Client", "Needs fixing", "Archive"];

type TagsDialogProps = {
  /** The designs being tagged; null keeps the dialog closed. */
  designs: ProjectMeta[] | null;
  /** Every tag in use anywhere, offered for one-click reuse. */
  known: string[];
  onClose: () => void;
};

type Mark = "all" | "some" | "none";

/** Adds and removes tags on one design or several. Tags only some of the designs have show as partly ticked. */
export function TagsDialog({ designs, known, onClose }: TagsDialogProps) {
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [initial, setInitial] = useState<Record<string, Mark>>({});
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // Read when the dialog opens only: the list is rebuilt on every render and must not reset what is being typed.
  const knownRef = useRef(known);
  knownRef.current = known;

  useEffect(() => {
    if (!designs) return;
    const names = uniqueTags([...knownRef.current, ...designs.flatMap((d) => d.tags ?? [])]);
    const start: Record<string, Mark> = {};
    for (const t of names) {
      const has = designs.filter((d) => (d.tags ?? []).some((x) => sameTag(x, t))).length;
      start[t] = has === 0 ? "none" : has === designs.length ? "all" : "some";
    }
    setMarks(start);
    setInitial(start);
    setDraft("");
    setProblem(null);
  }, [designs]);

  useEffect(() => {
    if (!designs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [designs, onClose]);

  if (!designs) return null;

  const cycle = (tag: string) =>
    setMarks((m) => ({ ...m, [tag]: m[tag] === "all" ? "none" : "all" }));

  const addDraft = () => {
    const tag = cleanTag(draft);
    if (!tag) return;
    const existing = Object.keys(marks).find((t) => sameTag(t, tag));
    setMarks((m) => ({ ...m, [existing ?? tag]: "all" }));
    setDraft("");
  };

  const save = () => {
    const add: string[] = [];
    const remove: string[] = [];
    for (const [tag, mark] of Object.entries(marks)) {
      if (mark === initial[tag] || (initial[tag] === undefined && mark === "none")) continue;
      if (mark === "all") add.push(tag);
      else if (mark === "none") remove.push(tag);
    }
    // A tag typed in the box but not yet added still counts.
    const pending = cleanTag(draft);
    if (pending && !add.some((t) => sameTag(t, pending))) add.push(pending);
    const ok = useDoc.getState().editTags(designs.map((d) => d.id), add, remove);
    if (!ok) {
      setProblem("Some designs can't hold that many tags. Tags are kept short so they fit in Google Drive; remove a few.");
      return;
    }
    onClose();
  };

  const names = Object.keys(marks).sort((a, b) => a.localeCompare(b));

  return (
    <div className="modal-backdrop" style={{ zIndex: 3000 }} onClick={onClose}>
      <div className="save-dialog tags-dialog" role="dialog" aria-label="Tags" onClick={(e) => e.stopPropagation()}>
        <h2>{designs.length === 1 ? `Tags for "${designs[0].name}"` : `Tags for ${designs.length} designs`}</h2>
        <div className="tag-chips">
          {names.length === 0 && <span className="tag-hint">No tags yet. Type one below.</span>}
          {names.map((t) => (
            <button
              key={t}
              type="button"
              className={`tag-chip ${marks[t]}`}
              aria-pressed={marks[t] === "all"}
              onClick={() => cycle(t)}
              title={marks[t] === "some" ? "Only some of the selected designs have this tag" : undefined}
            >
              <TagIcon size={11} className="tag-chip-icon" />
              {t}
              {marks[t] === "all" ? <span className="tag-chip-mark"> ✓</span> : marks[t] === "some" ? <span className="tag-chip-mark"> –</span> : null}
            </button>
          ))}
        </div>
        {SAMPLE_TAGS.some((t) => !names.some((n) => sameTag(n, t))) && (
          <>
            <div className="save-label">Suggestions</div>
            <div className="tag-chips">
              {SAMPLE_TAGS.filter((t) => !names.some((n) => sameTag(n, t))).map((t) => (
                <button key={t} type="button" className="tag-chip suggestion" onClick={() => setMarks((m) => ({ ...m, [t]: "all" }))}>
                  + {t}
                </button>
              ))}
            </div>
          </>
        )}
        <label className="save-label" htmlFor="tag-new">New tag</label>
        <input
          id="tag-new"
          className="save-name"
          value={draft}
          maxLength={MAX_TAG_LENGTH}
          placeholder="For example: printed, client, to fix"
          onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) addDraft();
              else save();
            }
          }}
          autoFocus
        />
        {problem && <p className="drive-problem">{problem}</p>}
        <div className="save-buttons">
          <button className="modal-btn" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
