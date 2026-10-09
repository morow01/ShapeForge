import { useEffect, useRef, useState } from "react";
import { useDoc } from "../document/store";
import { MAX_TAG_LENGTH, cleanTag, sameTag, uniqueTags } from "../document/tags";
import type { ProjectMeta } from "../document/types";
import { StarIcon, TagIcon } from "./NavIcons";

/** How many unused tags show before "Show all". Keeps the dialog short however many tags exist. */
const COLLAPSED_COUNT = 10;

type EditDialogProps = {
  /** The designs being edited; null keeps the dialog closed. */
  designs: ProjectMeta[] | null;
  /** Every tag in use anywhere or kept for later, offered for one-click reuse. */
  known: string[];
  onClose: () => void;
};

type Mark = "all" | "some" | "none";

/**
 * The one place to edit a design: its name, its star and its tags. Tags the design has are shown first,
 * each with a × to remove it; below is a search box that also makes new tags, and the tags it does not
 * have yet. With several designs selected only the tags can be changed together, and a tag only some
 * of them have shows as partly applied.
 */
export function EditDialog({ designs, known, onClose }: EditDialogProps) {
  const single = designs && designs.length === 1 ? designs[0] : null;
  const projects = useDoc((s) => s.projects);
  const [name, setName] = useState("");
  const [starred, setStarred] = useState(false);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [initial, setInitial] = useState<Record<string, Mark>>({});
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);
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
    setShowAll(false);
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

  const setMark = (tag: string, mark: Mark) => {
    setMarks((m) => ({ ...m, [tag]: mark }));
    setProblem(null);
  };

  /** Applies the typed text: an existing tag with that name is switched on, otherwise it becomes a new tag. */
  const addDraft = () => {
    const tag = cleanTag(draft);
    if (!tag) return;
    const existing = Object.keys(marks).find((t) => sameTag(t, tag));
    setMark(existing ?? tag, "all");
    setDraft("");
    setShowAll(false);
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

  const usage = (tag: string) => projects.filter((p) => (p.tags ?? []).some((t) => sameTag(t, tag))).length;
  const names = Object.keys(marks);
  const applied = names.filter((t) => marks[t] !== "none").sort((a, b) => a.localeCompare(b));
  const needle = draft.trim().toLowerCase();
  const available = names
    .filter((t) => marks[t] === "none" && (!needle || t.toLowerCase().includes(needle)))
    .sort((a, b) => usage(b) - usage(a) || a.localeCompare(b));
  const shown = showAll || needle ? available : available.slice(0, COLLAPSED_COUNT);
  const cleaned = cleanTag(draft);
  const canCreate = cleaned.length > 0 && !names.some((t) => sameTag(t, cleaned));
  const many = designs.length > 1;

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

        <div className="save-label">{many ? "On these designs" : "On this design"}</div>
        <div className="tag-chips tag-applied">
          {applied.length === 0 && <span className="tag-hint">No tags yet. Add one below.</span>}
          {applied.map((t) => (
            <span key={t} className={`tag-chip applied${marks[t] === "some" ? " some" : ""}`}>
              <button
                type="button"
                className="tag-chip-body"
                onClick={() => marks[t] === "some" && setMark(t, "all")}
                title={marks[t] === "some" ? "Only some of the selected designs have this tag. Click to give it to all of them." : undefined}
              >
                <TagIcon size={11} className="tag-chip-icon" />
                {t}
                {marks[t] === "some" && <span className="tag-chip-part"> · some</span>}
              </button>
              <button type="button" className="tag-chip-x" aria-label={`Remove the tag ${t}`} title="Remove" onClick={() => setMark(t, "none")}>
                ×
              </button>
            </span>
          ))}
        </div>

        <div className="save-label">Add a tag</div>
        <input
          id="tag-new"
          className="save-name"
          aria-label="Search or create a tag"
          value={draft}
          maxLength={MAX_TAG_LENGTH}
          placeholder="Search tags, or type a new one and press Enter"
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
        <div className="tag-chips tag-available">
          {shown.map((t) => (
            <button key={t} type="button" className="tag-chip available" onClick={() => setMark(t, "all")}>
              <TagIcon size={11} className="tag-chip-icon" />
              {t}
              <span className="tag-chip-count">{usage(t)}</span>
            </button>
          ))}
          {canCreate && (
            <button type="button" className="tag-chip create" onClick={addDraft}>
              + Create "{cleaned}"
            </button>
          )}
          {!showAll && !needle && available.length > COLLAPSED_COUNT && (
            <button type="button" className="tag-more" onClick={() => setShowAll(true)}>
              Show all {available.length}
            </button>
          )}
          {showAll && !needle && available.length > COLLAPSED_COUNT && (
            <button type="button" className="tag-more" onClick={() => setShowAll(false)}>
              Show fewer
            </button>
          )}
          {shown.length === 0 && !canCreate && <span className="tag-hint">{needle ? "No other tags match." : "Every tag is already on this design."}</span>}
        </div>

        {problem && <p className="drive-problem">{problem}</p>}
        <div className="save-buttons">
          <button className="modal-btn" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
