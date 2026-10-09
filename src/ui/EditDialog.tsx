import { useEffect, useRef, useState } from "react";
import { useDoc } from "../document/store";
import { MAX_TAG_LENGTH, cleanTag, sameTag, uniqueTags } from "../document/tags";
import type { ProjectMeta } from "../document/types";
import { StarIcon, TagIcon } from "./NavIcons";

/** Offered until the person has tags of their own, so there is something to click straight away. */
const SAMPLE_TAGS = ["Idea", "Prototype", "Final", "Printed", "Client", "Needs fixing", "Archive"];

type EditDialogProps = {
  /** The designs being edited; null keeps the dialog closed. */
  designs: ProjectMeta[] | null;
  /** Every tag in use anywhere, offered for one-click reuse. */
  known: string[];
  onClose: () => void;
};

type Mark = "all" | "some" | "none";

/**
 * The one place to edit a design: its name, its star and its tags. With several designs selected only
 * the tags can be changed together; a tag only some of them have shows as partly ticked.
 */
export function EditDialog({ designs, known, onClose }: EditDialogProps) {
  const single = designs && designs.length === 1 ? designs[0] : null;
  const [name, setName] = useState("");
  const [starred, setStarred] = useState(false);
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
    setName(designs.length === 1 ? designs[0].name : "");
    setStarred(designs.length === 1 ? !!designs[0].starred : false);
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

  const cycle = (tag: string) => setMarks((m) => ({ ...m, [tag]: m[tag] === "all" ? "none" : "all" }));

  const addDraft = () => {
    const tag = cleanTag(draft);
    if (!tag) return;
    const existing = Object.keys(marks).find((t) => sameTag(t, tag));
    setMarks((m) => ({ ...m, [existing ?? tag]: "all" }));
    setDraft("");
  };

  const save = () => {
    const store = useDoc.getState();
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
    if (!store.editTags(designs.map((d) => d.id), add, remove)) {
      setProblem("Some designs can't hold that many tags. Tags are kept short so they fit in Google Drive; remove a few.");
      return;
    }
    if (single) {
      const trimmed = name.trim();
      if (trimmed && trimmed !== single.name) store.renameProjectById(single.id, trimmed);
      if (starred !== !!single.starred) store.toggleStar([single.id]);
    }
    onClose();
  };

  const tagNames = Object.keys(marks).sort((a, b) => a.localeCompare(b));
  const suggestions = SAMPLE_TAGS.filter((t) => !tagNames.some((n) => sameTag(n, t)));

  return (
    <div className="modal-backdrop" style={{ zIndex: 3000 }} onClick={onClose}>
      <div className="save-dialog tags-dialog" role="dialog" aria-label="Edit design" onClick={(e) => e.stopPropagation()}>
        <h2>{single ? "Edit design" : `Edit ${designs.length} designs`}</h2>

        {single && (
          <>
            <label className="save-label" htmlFor="edit-name">Name</label>
            <input
              id="edit-name"
              className="save-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              autoFocus
            />
            <button
              type="button"
              className={`edit-star${starred ? " on" : ""}`}
              aria-pressed={starred}
              onClick={() => setStarred((v) => !v)}
            >
              <StarIcon size={16} />
              <span>{starred ? "Starred" : "Add a star"}</span>
            </button>
          </>
        )}

        <div className="save-label">Tags</div>
        <div className="tag-chips">
          {tagNames.length === 0 && <span className="tag-hint">No tags yet. Type one below or pick a suggestion.</span>}
          {tagNames.map((t) => (
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
        {suggestions.length > 0 && (
          <div className="tag-chips">
            {suggestions.map((t) => (
              <button key={t} type="button" className="tag-chip suggestion" onClick={() => setMarks((m) => ({ ...m, [t]: "all" }))}>
                + {t}
              </button>
            ))}
          </div>
        )}
        <input
          id="tag-new"
          className="save-name"
          aria-label="New tag"
          value={draft}
          maxLength={MAX_TAG_LENGTH}
          placeholder="Add a tag and press Enter"
          autoFocus={!single}
          onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) addDraft();
              else save();
            }
          }}
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
