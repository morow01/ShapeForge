import { useEffect, useRef, useState } from "react";
import { isGroup } from "../document/types";
import { resolveNodeColor, resolveNodeTransparent } from "../document/tree";
import { beginHistoryBatch, endHistoryBatch } from "../document/store";
import { EyeIcon, EyeOffIcon, PencilIcon } from "./icons";
import type { SceneNode } from "../document/types";

interface Props {
  nodes: SceneNode[];
  selectedIds: string[];
  invalid: Record<string, string>;
  onSelect: (id: string, additive: boolean) => void;
  onToggleCollapsed: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

export function Tree({ nodes, selectedIds, invalid, onSelect, onToggleCollapsed, onToggleHidden, onRename }: Props) {
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <Row
          key={n.id}
          node={n}
          depth={0}
          selectedIds={selectedIds}
          invalid={invalid}
          onSelect={onSelect}
          onToggleCollapsed={onToggleCollapsed}
          onToggleHidden={onToggleHidden}
          onRename={onRename}
        />
      ))}
    </ul>
  );
}

function Row({ node, depth, selectedIds, invalid, onSelect, onToggleCollapsed, onToggleHidden, onRename }: {
  node: SceneNode;
  depth: number;
  selectedIds: string[];
  invalid: Record<string, string>;
  onSelect: (id: string, additive: boolean) => void;
  onToggleCollapsed: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const selected = selectedIds.includes(node.id);
  const bad = !!invalid[node.id];
  const group = isGroup(node);
  const open = group && !node.collapsed;
  const color = resolveNodeColor(node);
  const transparent = resolveNodeTransparent(node);
  const hidden = !!node.hidden;

  // Double-click the label to rename, in place — the standard outliner
  // gesture (Explorer, Blender, Illustrator's Layers panel). A single click
  // still just selects, exactly as before; double-click's own two leading
  // clicks already do that on the way in.
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // What the name was when editing began, so Escape has something to put
  // back — onChange below writes straight to the document on every
  // keystroke (live, like the Inspector's own name field), so there is no
  // local draft buffer to simply discard.
  const originalName = useRef(node.name);

  useEffect(() => {
    // .select() alone leaves focus to whatever the browser feels like doing
    // with it — reliable enough in ordinary use, but not guaranteed, and
    // without real focus here, Enter's own blur() later has nothing to blur
    // and the row is stuck in edit mode. Focus explicitly, then select.
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    originalName.current = node.name;
    setEditing(true);
  };
  const commit = () => {
    // An emptied name is worse than not renaming at all — nothing left to
    // identify the object by in the panel or in a future "select by name".
    if (!node.name.trim()) onRename(node.id, originalName.current);
    endHistoryBatch();
    setEditing(false);
  };
  const cancel = () => {
    onRename(node.id, originalName.current);
    endHistoryBatch();
    setEditing(false);
  };

  return (
    <>
      <li
        className={[selected ? "sel" : "", bad ? "bad" : "", hidden ? "row-hidden" : ""]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: 7 + depth * 13 }}
        onClick={(e) => onSelect(node.id, e.shiftKey || e.ctrlKey || e.metaKey)}
        title={bad ? invalid[node.id] : undefined}
      >
        {group ? (
          <button
            className="twisty"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapsed(node.id);
            }}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="twisty-spacer" />
        )}
        <span
          className={
            node.isHole
              ? "dot hole"
              : group
                ? "dot group"
                : node.type === "import" || node.type === "edit" || node.type === "build"
                  ? "dot import"
                  : "dot"
          }
          style={
            !node.isHole
              ? {
                  backgroundColor: color,
                  opacity: transparent ? 0.6 : 1,
                }
              : transparent
                ? { opacity: 0.6 }
                : undefined
          }
        />
        {editing ? (
          <input
            ref={inputRef}
            className="label-edit"
            value={node.name}
            // A click here is placing the cursor, not selecting the row —
            // and re-selecting an already-selected row mid-edit is harmless
            // but pointless. Stop it at the source, same as the eye button.
            onClick={(e) => e.stopPropagation()}
            onFocus={beginHistoryBatch}
            onChange={(e) => onRename(node.id, e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              // Not routed through blur(): a synthetic focus (or a browser
              // that resists it) would leave blur() with nothing to fire,
              // and the row stuck in edit mode with no way out but a real
              // click elsewhere. Enter commits directly, the same way
              // Escape already cancels directly.
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") cancel();
            }}
            aria-label="Object name"
          />
        ) : (
          <span className="label" onDoubleClick={() => startEditing()}>
            {node.name}
          </span>
        )}
        {!editing && (
          <button
            className="row-rename-btn"
            onClick={(e) => {
              e.stopPropagation();
              startEditing();
            }}
            title="Rename object"
            aria-label="Rename object"
          >
            <PencilIcon className="row-rename-icon" />
          </button>
        )}
        {group && <span className="op">{node.op[0].toUpperCase()}</span>}
        {bad && <span className="warn">!</span>}
        <button
          className="visibility"
          // A click here is about visibility, not selection — stop it from
          // also selecting (or additively toggling) the row underneath.
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden(node.id);
          }}
          title={hidden ? "Show" : "Hide"}
          aria-label={hidden ? "Show" : "Hide"}
          aria-pressed={hidden}
        >
          {hidden ? <EyeOffIcon className="visibility-icon" /> : <EyeIcon className="visibility-icon" />}
        </button>
      </li>

      {group &&
        open &&
        node.children.map((c) => (
          <Row
            key={c.id}
            node={c}
            depth={depth + 1}
            selectedIds={selectedIds}
            invalid={invalid}
            onSelect={onSelect}
            onToggleCollapsed={onToggleCollapsed}
            onToggleHidden={onToggleHidden}
            onRename={onRename}
          />
        ))}
    </>
  );
}
