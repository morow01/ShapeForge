import { useEffect, useState } from "react";
import { MAX_TAG_LENGTH, cleanTag, sameTag } from "../document/tags";
import { TagIcon } from "./NavIcons";

type TagManagerProps = {
  open: boolean;
  /** Every tag, in use or not. */
  tags: string[];
  /** How many designs carry each tag. */
  count: (tag: string) => number;
  onAdd: (tag: string) => void;
  /** Returns a message when the rename could not be done. */
  onRename: (oldTag: string, newTag: string) => string | null;
  onDelete: (tag: string) => void;
  onClose: () => void;
};

/** One place to look after the whole list of tags: make new ones, rename them everywhere, delete the ones not wanted. */
export function TagManager({ open, tags, count, onAdd, onRename, onDelete, onClose }: TagManagerProps) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft("");
      setEditing(null);
      setProblem(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) setEditing(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing, onClose]);

  if (!open) return null;

  const add = () => {
    const tag = cleanTag(draft);
    if (!tag) return;
    if (tags.some((t) => sameTag(t, tag))) {
      setProblem(`"${tag}" already exists.`);
      return;
    }
    onAdd(tag);
    setDraft("");
    setProblem(null);
  };

  const commitRename = (oldTag: string) => {
    const next = cleanTag(editValue);
    if (!next || next === oldTag) {
      setEditing(null);
      return;
    }
    if (tags.some((t) => sameTag(t, next) && !sameTag(t, oldTag))) {
      setProblem(`"${next}" already exists. Delete one of them, or give this tag another name.`);
      return;
    }
    const error = onRename(oldTag, next);
    if (error) {
      setProblem(error);
      return;
    }
    setEditing(null);
    setProblem(null);
  };

  const sorted = [...tags].sort((a, b) => a.localeCompare(b));

  return (
    <div className="modal-backdrop" style={{ zIndex: 3000 }} onClick={onClose}>
      <div className="save-dialog tag-manager" role="dialog" aria-label="Manage tags" onClick={(e) => e.stopPropagation()}>
        <h2>Manage tags</h2>
        <div className="tag-manager-add">
          <input
            className="save-name"
            aria-label="New tag"
            value={draft}
            maxLength={MAX_TAG_LENGTH}
            placeholder="New tag"
            autoFocus
            onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          />
          <button className="modal-btn primary" disabled={!cleanTag(draft)} onClick={add}>Add</button>
        </div>
        {problem && <p className="drive-problem">{problem}</p>}
        <div className="tag-manager-list">
          {sorted.length === 0 && <p className="version-empty">No tags yet. Add your first above.</p>}
          {sorted.map((tag) => {
            const n = count(tag);
            return (
              <div key={tag} className="tag-manager-row">
                <TagIcon size={13} className="tag-manager-icon" />
                {editing === tag ? (
                  <input
                    className="save-name tag-manager-edit"
                    value={editValue}
                    maxLength={MAX_TAG_LENGTH}
                    autoFocus
                    onChange={(e) => { setEditValue(e.target.value); setProblem(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(tag);
                      if (e.key === "Escape") setEditing(null);
                    }}
                    onBlur={() => commitRename(tag)}
                  />
                ) : (
                  <span className="tag-manager-name">{tag}</span>
                )}
                <span className="tag-manager-count">{n === 0 ? "unused" : `${n} ${n === 1 ? "design" : "designs"}`}</span>
                <button className="home-link" onClick={() => { setEditing(tag); setEditValue(tag); setProblem(null); }}>Rename</button>
                <button className="home-link tag-manager-delete" onClick={() => onDelete(tag)}>Delete</button>
              </div>
            );
          })}
        </div>
        <p className="tag-manager-note">Renaming or deleting a tag changes it on every design that has it.</p>
        <div className="save-buttons">
          <button className="modal-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
