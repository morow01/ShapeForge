import { isGroup } from "../document/types";
import type { SceneNode } from "../document/types";

interface Props {
  nodes: SceneNode[];
  selectedIds: string[];
  invalid: Record<string, string>;
  onSelect: (id: string, additive: boolean) => void;
  onToggleCollapsed: (id: string) => void;
}

export function Tree({ nodes, selectedIds, invalid, onSelect, onToggleCollapsed }: Props) {
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
        />
      ))}
    </ul>
  );
}

interface RowProps extends Omit<Props, "nodes"> {
  node: SceneNode;
  depth: number;
}

function Row({ node, depth, selectedIds, invalid, onSelect, onToggleCollapsed }: RowProps) {
  const group = isGroup(node);
  const open = group && !node.collapsed;
  const bad = invalid[node.id];

  return (
    <>
      <li
        className={[selectedIds.includes(node.id) ? "sel" : "", bad ? "bad" : ""]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: 7 + depth * 13 }}
        title={bad ?? undefined}
        onClick={(e) => onSelect(node.id, e.ctrlKey || e.metaKey || e.shiftKey)}
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
        <span className={node.isHole ? "dot hole" : group ? "dot group" : "dot"} />
        <span className="label">{node.name}</span>
        {group && <span className="op">{node.op[0].toUpperCase()}</span>}
        {bad && <span className="warn">!</span>}
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
          />
        ))}
    </>
  );
}
