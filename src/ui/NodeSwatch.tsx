import React from "react";
import type { SceneNode } from "../document/types";
import { resolveNodeColor, resolveNodeTransparent } from "../document/tree";

interface NodeSwatchProps {
  node?: SceneNode | null;
  color?: string;
  size?: number;
  borderRadius?: number;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * Renders a crisp, compact color swatch representing a 3D object/node.
 * Automatically resolves inheritance from groups and edits.
 */
export function NodeSwatch({
  node,
  color,
  size = 11,
  borderRadius = 3,
  style,
  className = "",
}: NodeSwatchProps) {
  const resolvedColor = color ?? (node ? resolveNodeColor(node) : null);
  const isHole = node?.isHole ?? false;
  const isTransparent = node ? resolveNodeTransparent(node) : false;

  if (!resolvedColor && !isHole) return null;

  return (
    <span
      className={`node-color-swatch ${className}`}
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius,
        backgroundColor: isHole ? "#94a3b8" : (resolvedColor ?? "#94a3b8"),
        backgroundImage: isHole
          ? "repeating-linear-gradient(45deg, #cbd5e1, #cbd5e1 2px, #94a3b8 2px, #94a3b8 4px)"
          : undefined,
        opacity: isTransparent ? 0.6 : 1,
        border: "1px solid rgba(0, 0, 0, 0.2)",
        boxShadow: "inset 0 1px 1px rgba(255, 255, 255, 0.35)",
        flexShrink: 0,
        verticalAlign: "middle",
        ...style,
      }}
    />
  );
}
