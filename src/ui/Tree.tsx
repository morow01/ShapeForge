import { isGroup } from "../document/types";
import { resolveNodeColor, resolveNodeTransparent } from "../document/tree";
import { EyeIcon, EyeOffIcon } from "./icons";
import type { SceneNode } from "../document/types";

interface Props {
  nodes: SceneNode[];
  selectedIds: string[];
  invalid: Record<string, string>;
  onSelect: (id: string, additive: boolean) => void;
  onToggleCollapsed: (id: string) => void;
  onToggleHidden: (id: string) => void;
}

export function Tree({ nodes, selectedIds, invalid, onSelect, onToggleCollapsed, onToggleHidden }: Props) {
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
        />
      ))}
    </ul>
  );
}

function Row({ node, depth, selectedIds, invalid, onSelect, onToggleCollapsed, onToggleHidden }: {
  node: SceneNode;
  depth: number;
  selectedIds: string[];
  invalid: Record<string, string>;
  onSelect: (id: string, additive: boolean) => void;
  onToggleCollapsed: (id: string) => void;
  onToggleHidden: (id: string) => void;
}) {
  const selected = selectedIds.includes(node.id);
  const bad = !!invalid[node.id];
  const group = isGroup(node);
  const open = group && !node.collapsed;
  const color = resolveNodeColor(node);
  const transparent = resolveNodeTransparent(node);
  const hidden = !!node.hidden;

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
        <span className="label">{node.name}</span>
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
          />
        ))}
    </>
  );
}
