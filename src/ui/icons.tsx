import type { PrimitiveKind } from "../document/types";

export type FaceModifierKind = "push" | "wall" | "resize" | "offset" | "fillet" | "chamfer";

/** ShapeForge face modifiers: different silhouettes, one restrained line style. */
export function FaceModifierIcon({ kind, className = "tool-icon modifier-icon" }: {
  kind: FaceModifierKind;
  className?: string;
}) {
  const accent = { className: "modifier-accent", fill: "none", strokeWidth: 1.35, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const ghostCorner = <path d="M5.5 19V5h13.5" fill="none" stroke="currentColor" strokeWidth={1.15} strokeDasharray="1.6 1.8" opacity={.4} />;
  let drawing;
  if (kind === "push") drawing = <>
    {/* Face the operation acts on, kept pale so the arrow reads clearly on top of it. */}
    <path d="M4 9 12 5 20 9 12 13Z" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth={1.3} strokeOpacity={.55} />
    {/* White knockout behind the arrow so it never blends into the face outline it crosses. */}
    <path d="M9 5.2 12 2 15 5.2M12 2V17M9 13.8 12 17 15 13.8" fill="none" stroke="#fff" strokeWidth={4.2} strokeLinecap="round" strokeLinejoin="round" />
    <path {...accent} d="M9 5.2 12 2 15 5.2M12 2V17M9 13.8 12 17 15 13.8" strokeWidth={2.1} />
  </>;
  else if (kind === "wall") drawing = <>
    {/* Outer wall + inner cavity reads as "hollow" without a caption. */}
    <rect x={5} y={5} width={14} height={14} rx={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
    <rect {...accent} x={9} y={9} width={6} height={6} rx={1} strokeDasharray="1.6 1.8" />
    <path {...accent} d="M6.6 6.6 8.6 8.6M17.4 6.6 15.4 8.6M6.6 17.4 8.6 15.4M17.4 17.4 15.4 15.4" />
  </>;
  else if (kind === "resize") drawing = <>
    {/* Corner drag-handles instead of ambiguous inward arrows. */}
    <rect x={6} y={7} width={12} height={10} rx={1.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
    <path {...accent} d="M3 21 8 16M3 21v-4M3 21h4" />
    <path {...accent} d="M21 3 16 8M21 3h-4M21 3v4" />
  </>;
  else if (kind === "offset") drawing = <>
    {/* The actual stepped result: shrinking tiers stacked upward, not a face-plus-arrow
        that read as a duplicate of Push/Pull. */}
    <rect x={4} y={15} width={16} height={6} rx={1} fill="none" stroke="currentColor" strokeWidth={1.3} />
    <rect x={7} y={9} width={10} height={6} rx={1} fill="none" stroke="currentColor" strokeWidth={1.3} />
    <rect {...accent} x={9.5} y={4} width={5} height={5} rx={1} />
  </>;
  else if (kind === "fillet") drawing = <>
    {/* The icon *is* a filleted corner, sharing its anchor points with Chamfer below
        so the two read as one pair. */}
    {ghostCorner}
    <path {...accent} d="M5.5 19V14A9 9 0 0 1 14.5 5H19" strokeWidth={2.4} />
  </>;
  else drawing = <>
    {ghostCorner}
    <path {...accent} d="M5.5 19V14L14.5 5H19" strokeWidth={2.4} />
  </>;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {drawing}
    </svg>
  );
}

/** Select tool: a cursor-arrow silhouette with a marquee-corner accent. */
export function SelectIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M6 3.4 6 18.6 9.7 15.3 12.4 20.4 15 19.1 12.3 14 17.8 13.8Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path className="icon-accent" d="M15 4.5h4.5V9" fill="none" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2.4 2.4" />
    </svg>
  );
}

/** Edge finishing tool: one edge drawn bold on a faint box, its own height
 *  exactly matching the box's front edge, with a pick handle at its middle. */
export function EdgeToolIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* Same proportioned cube used by Transparency / View Modes, so every
          side reads as equal instead of a squat tray. */}
      <path
        d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".32"
      />
      <path
        d="M12 12 4 7.5M12 12l8-4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".32"
      />
      <path className="icon-accent" d="M12 12v9" fill="none" strokeWidth="2.4" strokeLinecap="round" />
      <circle className="icon-accent-fill" cx="12" cy="16.5" r="1.4" />
    </svg>
  );
}

/** Add text tool: a filled serif "T" glyph — reads as an actual letterform
 *  (crossbar + flared foot) rather than a plus-sign-like block. */
export function TextToolIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 4H20V7H13.5V17H16V20H8V17H10.5V7H4Z" fill="currentColor" />
    </svg>
  );
}

/** Move tool: the standard 4-way cross. */
export function MoveToolIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v18M3 12h18" />
        <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
      </g>
    </svg>
  );
}

/** Rotate tool: a pivot arc ending in a small chevron arrowhead, with a
 *  pivot-point dot at the object's centre. */
export function RotateToolIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* Exact circle (center 12,12 r=7) so the chevron below lands precisely
          tangent to the arc's end, instead of floating near it. */}
      <path d="M18.06 8.5A7 7 0 1 1 12 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9.4 3.3 12 5 9.4 6.7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="icon-accent-fill" cx="12" cy="12" r="1.3" />
    </svg>
  );
}

/** Drop-direction arrow: shaft + chevron on the four axes, shaft + corner
 *  bracket on the two diagonals — the same construction as Move's arms and
 *  Resize's corner handles, applied to a single direction. Replaces the
 *  plain ← → ↙ ↗ ↓ ↑ glyphs in the drop-direction menu. */
export function DirectionArrowIcon({
  direction,
  className = "tool-icon",
}: {
  direction: "left" | "right" | "up" | "down" | "front" | "back";
  className?: string;
}) {
  const d =
    direction === "left" ? "M19 12H10M10 8.5 6 12 10 15.5"
    : direction === "right" ? "M5 12h9M14 8.5 18 12 14 15.5"
    : direction === "up" ? "M12 19V10M8.5 10 12 6 15.5 10"
    : direction === "down" ? "M12 5V14M8.5 14 12 18 15.5 14"
    : direction === "front" ? "M19 5 12 12M19 5h-5M19 5v5"
    : "M5 19 12 12M5 19h5M5 19v-5";
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Align tool: two objects meeting a shared dashed guide line — replaces the
 *  old vertical-dots glyph, which read as unrelated to alignment. */
export function AlignToolIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="icon-accent" d="M12 3v18" fill="none" strokeWidth="1.6" strokeDasharray="2 2" />
      <rect x="5" y="6" width="7" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="9" y="15" width="10" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function SettingsIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M9.7 2.8h4.6l.55 2.35c.55.22 1.06.52 1.53.88l2.3-.72 2.3 3.98-1.77 1.63c.04.36.06.72.06 1.08s-.02.72-.06 1.08l1.77 1.63-2.3 3.98-2.3-.72c-.47.36-.98.66-1.53.88l-.55 2.35H9.7l-.55-2.35a7.6 7.6 0 0 1-1.53-.88l-2.3.72-2.3-3.98 1.77-1.63A9.4 9.4 0 0 1 4.73 12c0-.36.02-.72.06-1.08L3.02 9.29l2.3-3.98 2.3.72c.47-.36.98-.66 1.53-.88L9.7 2.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.55" />
    </svg>
  );
}

/**
 * A wireframe cube you can see through: the three dashed lines are the far
 * edges, all running from the back-bottom corner, which in this projection
 * lands dead centre. Shared by the tool rail and the colour popover so the
 * two ways of toggling transparency read as the same thing.
 */
export function TransparencyIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" fill="currentColor" opacity=".14" />
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
        <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
        <path d="M12 12V3M12 12l-8 4.5M12 12l8 4.5" opacity=".55" strokeDasharray="2 2" />
      </g>
    </svg>
  );
}

export function SolidCubeIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" fill="currentColor" opacity=".35" />
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
        <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
      </g>
    </svg>
  );
}

/**
 * A wireframe icon that reflects the active wireframe mode:
 * - "outlined": cube outline, no fill, hidden back edges shown faint grey
 * - "edges": clean cube outline, no fill, no hidden edges at all
 * - "mesh": cube outline with a facet line across each face
 * - "xray": ghosted cube with dashed hidden edges in the teal accent
 * - "transparent": ghosted cube with dashed hidden edges, subtler still
 * - "off" (Solid): plain filled cube, identical to SolidCubeIcon — this is
 *   ShapeForge's default view
 */
export function WireframeIcon({
  mode = "off",
  className = "tool-icon",
}: {
  mode?: "off" | "outlined" | "edges" | "mesh" | "xray" | "transparent" | boolean;
  className?: string;
}) {
  if (mode === "outlined") {
    // Same "see through to the hidden edges" idea as X-Ray, but dialed down
    // to plain light grey instead of the teal accent — was previously
    // identical to Clean Edges, with no hidden-line indication at all.
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
          <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
        </g>
        <path d="M12 12V3M12 12l-8 4.5M12 12l8 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 2" opacity=".35" />
      </svg>
    );
  }
  if (mode === "transparent") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" fill="currentColor" opacity=".18" />
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
          <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
        </g>
        <path className="icon-accent" d="M12 12V3M12 12l-8 4.5M12 12l8 4.5" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 2" opacity=".7" />
      </svg>
    );
  }
  if (mode === "edges") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
          <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
        </g>
      </svg>
    );
  }
  if (mode === "mesh") {
    // Had no case of its own before — it was silently falling through to
    // the default branch, so it rendered identically to "Solid" and the
    // two became impossible to tell apart in the flyout. A facet line
    // across each face reads as "full triangulated mesh".
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
          <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
        </g>
        <path className="icon-accent" d="M4 7.5H20M4 7.5 12 21M20 7.5 12 21" fill="none" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (mode === "xray") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 20 7.5V16.5L12 21 4 16.5V7.5Z" />
          <path d="M12 12 4 7.5M12 12l8-4.5M12 12v9" />
        </g>
        <path className="icon-accent" d="M12 12V3M12 12l-8 4.5M12 12l8 4.5" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 2" opacity=".85" />
      </svg>
    );
  }
  // Default (solid-shaded) state. Two redesigns of this icon (a split
  // cube, then a split swatch) both ended up looking unrelated to the
  // "Solid" entry in this same flyout, which has always used a plain
  // filled cube (SolidCubeIcon) — so the closed button showed one icon
  // and picking it from the menu showed a completely different one.
  // Reusing that exact icon here keeps the two in sync.
  return <SolidCubeIcon className={className} />;
}

/**
 * Drop: a body falling onto the surface that stops it. The bar underneath is
 * what makes it read as "lands on something" rather than a plain download or
 * move-down arrow.
 */
export function DropIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* fill-opacity (not opacity) so the box keeps a crisp, fully-visible outline
          instead of fading the stroke along with the fill. */}
      <rect x="8" y="3" width="8" height="6" rx="1.2" fill="currentColor" fillOpacity=".22" stroke="currentColor" strokeWidth="1.3" />
      {/* Trailing dashes = "just fell from here", not ambiguous side marks. */}
      <path d="M10 .6v1.7M14 .6v1.7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".32" />
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 10.5v5" />
        <path d="M8.8 13 12 16.2 15.2 13" />
      </g>
      <path className="icon-accent" d="M4.5 19.5h15" fill="none" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Illustrator-style flyout indicator: a small folded-corner triangle.
 *  Deliberately a separate, tiny element (not part of DropIcon's own
 *  viewBox) — the icon's viewBox only fills the button's inner 21px glyph
 *  area, so anything drawn inside it is stuck well short of the button's
 *  actual corner no matter where in that viewBox it sits. This renders on
 *  its own, positioned by the caller against the real button edge. */
export function CornerFlyoutMark({ className = "corner-flyout-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M10 10 10 2.5 2.5 10Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Shape Builder: two overlapping outlines with only their shared region
 * filled — the regions, and the fact that you pick between them, is the whole
 * idea, so the icon shows an arrangement rather than a finished solid.
 */
export function ShapeBuilderIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* The lens where the two circles meet, drawn as the intersection of
          their paths via even-odd on a single filled shape. */}
      <path
        className="icon-accent-fill"
        d="M12 6.1a6.3 6.3 0 0 1 0 11.8 6.3 6.3 0 0 1 0-11.8Z"
        opacity=".5"
      />
      <g fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="9.2" cy="12" r="6.3" />
        <circle cx="14.8" cy="12" r="6.3" />
      </g>
    </svg>
  );
}

/**
 * Smart Guides / Snapping Magnet Icon:
 * Classic U-magnet with distinct banded magnetic pole caps.
 */
export function MagnetIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* Shaded pole tips at bottom */}
      <path
        d="M4.5 15h4.2v4.5H4.5ZM15.3 15h4.2v4.5h-4.2Z"
        fill="currentColor"
        opacity=".2"
      />
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {/* Magnet U-body */}
        <path d="M4.5 19.5V12a7.5 7.5 0 0 1 15 0v7.5h-4.2V12a3.3 3.3 0 0 0-6.6 0v7.5H4.5Z" />
        {/* North/South pole separation bands */}
        <path d="M4.5 15h4.2M15.3 15h4.2" />
      </g>
    </svg>
  );
}

/**
 * Zoom to fit / focus selected object: 4 corner brackets around a solid cube.
 */
export function ZoomToFitIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 8V5a1 1 0 0 1 1-1h3" />
        <path d="M16 4h3a1 1 0 0 1 1 1v3" />
        <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
        <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
      </g>
      <rect className="icon-accent-fill" x="8.5" y="8.5" width="7" height="7" rx="1.5" opacity=".6" />
    </svg>
  );
}

/** Open eye — shown on a visible object's row; click to hide it. */
export function EyeIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.6" />
      </g>
    </svg>
  );
}

/** Home / Reset view icon */
export function HomeIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M3.5 10.5 12 3.5l8.5 7M6 9.5V20a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 21v-6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Outline Pencil / Edit icon */
export function PencilIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        <path d="m14.5 5.5 3 3" />
      </g>
    </svg>
  );
}

/** Slashed eye — shown on a hidden object's row; click to show it again. */
export function EyeOffIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 12S6 5.5 12 5.5c1.83 0 3.4.51 4.71 1.24M21.5 12S18 18.5 12 18.5c-1.83 0-3.4-.51-4.71-1.24" />
        <path d="M9.6 10.1a2.6 2.6 0 0 0 3.6 3.6" />
        <path d="M4 4l16 16" />
      </g>
    </svg>
  );
}

/** Projects / Dashboard folder icon */
export function ProjectsIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M2.5 6.5A1.5 1.5 0 0 1 4 5h4.5c.45 0 .88.2 1.18.52l1.3 1.48c.3.32.73.5 1.18.5H20a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V6.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** New Design / Plus file icon */
export function NewDesignIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 3H5.5A1.5 1.5 0 0 0 4 4.5v15A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V8.5L14.5 3Z" />
        <path d="M14.5 3v5.5H20" />
        <path d="M12 11.5v6M9 14.5h6" strokeWidth="2" />
      </g>
    </svg>
  );
}

/** TinkerCAD-style Undo curved counter-clockwise arrow */
export function UndoIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7.5 6.5 3 11l4.5 4.5" />
        <path d="M3 11h11a6 6 0 0 1 6 6v1.5" />
      </g>
    </svg>
  );
}

/** TinkerCAD-style Redo curved clockwise arrow */
export function RedoIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16.5 6.5l4.5 4.5-4.5 4.5" />
        <path d="M21 11H10a6 6 0 0 0-6 6v1.5" />
      </g>
    </svg>
  );
}

/** Assembly / Group icon: bounding frame enclosing multiple parts */
export function GroupIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="20" rx="3" strokeDasharray="3 2" opacity=".6" />
        <rect x="5" y="8" width="7" height="7" rx="1" fill="currentColor" opacity=".18" />
        <circle cx="15.5" cy="14.5" r="3.5" fill="currentColor" opacity=".18" />
        <rect x="5" y="8" width="7" height="7" rx="1" />
        <circle cx="15.5" cy="14.5" r="3.5" />
      </g>
    </svg>
  );
}

/** Combine / Solid Fusion icon: fused overlapping square and circle */
export function CombineIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="8.5" width="10.5" height="10.5" rx="1.5" fill="currentColor" opacity=".18" />
        <circle cx="16" cy="8" r="5.5" fill="currentColor" opacity=".18" />
        <path d="M3.5 12v6a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-6" />
        <path d="M11 6.8a5.5 5.5 0 1 1 8.2 6.8" />
        <path d="M3.5 12V10a1.5 1.5 0 0 1 1.5-1.5H11" />
      </g>
    </svg>
  );
}

/** Ungroup / Separate icon: separated square and circle */
export function UngroupIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="10.5" width="9" height="9" rx="1.5" />
        <circle cx="17" cy="7" r="5" />
        <path d="M11.5 7l-2.5-2.5M13.5 13.5l2.5 2.5" strokeDasharray="1.8 1.8" opacity=".8" strokeWidth="1.6" />
      </g>
    </svg>
  );
}

/** Objects panel / hierarchy list icon */
export function ObjectsIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3.5" width="18" height="17" rx="2" />
        <path d="M8.5 3.5v17" />
        <path d="M12 8h6M12 12h6M12 16h4" />
      </g>
    </svg>
  );
}

/** 3D Perspective view cube icon with converging lines (pure outline) */
export function PerspectiveIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {/* Top face spreading out wide with perspective */}
        <path d="M12 2.5 L21.5 3.8 L12 6.5 L2.5 3.8 Z" />
        {/* Center vertical edge */}
        <path d="M12 6.5 V21.5" />
        {/* Left face & tapering outer left edge */}
        <path d="M2.5 3.8 L5.5 15 L12 21.5" />
        {/* Right face & tapering outer right edge */}
        <path d="M21.5 3.8 L18.5 15 L12 21.5" />
      </g>
    </svg>
  );
}

/** Orthographic / Isometric view cube icon with parallel lines (pure outline) */
export function OrthographicIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {/* Top diamond with parallel edges */}
        <path d="M12 2.5 L20.5 7 L12 11.5 L3.5 7 Z" />
        {/* Center vertical edge */}
        <path d="M12 11.5 V21.5" />
        {/* Left vertical edge and bottom seam */}
        <path d="M3.5 7 V17 L12 21.5" />
        {/* Right vertical edge and bottom seam */}
        <path d="M20.5 7 V17 L12 21.5" />
      </g>
    </svg>
  );
}

/** Save project file icon */
export function SaveFileIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 3.5a1.5 1.5 0 0 1 1.5-1.5h11.5l3.5 3.5v14a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19.5V3.5Z" />
        <path d="M7.5 2v5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V2" />
        <rect x="7" y="12.5" width="10" height="7" rx="1" />
      </g>
    </svg>
  );
}

/** TinkerCAD-style Export icon (tray with upward arrow) */
export function ExportIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 14v4.5A1.5 1.5 0 0 0 5 20h14a1.5 1.5 0 0 0 1.5-1.5V14" />
        <path d="M12 3v12" />
        <path d="m7 7.5 5-5 5 5" />
      </g>
    </svg>
  );
}

/**
 * 3D Isometric Vector Icons for Shape Library Primitives
 */
export function PrimitiveShapeIcon({
  kind,
  className = "shape-icon-svg",
}: {
  kind: PrimitiveKind;
  className?: string;
}) {
  switch (kind) {
    case "box":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Top Face */}
          <path d="M16 4 L27 10 L16 16 L5 10 Z" fill="#78d5f8" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          {/* Left Face */}
          <path d="M5 10 L16 16 V27 L5 21 Z" fill="#38a7d5" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          {/* Right Face */}
          <path d="M27 10 L16 16 V27 L27 21 Z" fill="#2087b2" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "cylinder":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="cyl-body-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#4bb9e5" />
              <stop offset="50%" stopColor="#309cc8" />
              <stop offset="100%" stopColor="#1e7d9f" />
            </linearGradient>
          </defs>
          {/* Cylinder Body */}
          <path
            d="M6 9 V22 C6 25.5 10.5 27 16 27 C21.5 27 26 25.5 26 22 V9 Z"
            fill="url(#cyl-body-grad)"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Top Ellipse */}
          <ellipse cx="16" cy="9" rx="10" ry="4.5" fill="#78d5f8" stroke="#1d7a9f" strokeWidth="1.2" />
        </svg>
      );
    case "sphere":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id="sphere-3d-grad" cx="35%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#c5f0ff" />
              <stop offset="25%" stopColor="#67cdf4" />
              <stop offset="70%" stopColor="#2991bc" />
              <stop offset="100%" stopColor="#156485" />
            </radialGradient>
          </defs>
          <circle cx="16" cy="16" r="11.5" fill="url(#sphere-3d-grad)" stroke="#1d7a9f" strokeWidth="1.2" />
        </svg>
      );
    case "cone":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="cone-body-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#67cdf4" />
              <stop offset="45%" stopColor="#33a1ce" />
              <stop offset="100%" stopColor="#1b7294" />
            </linearGradient>
          </defs>
          {/* 3D Round Cone with Curved Elliptical Base */}
          <path
            d="M16 4.5 L5.5 23 C5.5 26.5 10.2 27.5 16 27.5 C21.8 27.5 26.5 26.5 26.5 23 L16 4.5 Z"
            fill="url(#cone-body-grad)"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Curved base contour line */}
          <path
            d="M5.5 23 C5.5 20.2 10.2 19 16 19 C21.8 19 26.5 20.2 26.5 23"
            fill="none"
            stroke="#1d7a9f"
            strokeWidth="1"
            strokeDasharray="2 2"
            opacity=".5"
          />
        </svg>
      );
    case "triangle":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* 3D Triangular Roof Prism */}
          {/* Right sloped roof face (top/side illuminated) */}
          <path
            d="M11 7 L23 5 L29 18 L17 25 Z"
            fill="#78d5f8"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Front triangular face */}
          <path
            d="M11 7 L4 21 L17 25 Z"
            fill="#38a7d5"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "torus":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id="torus-grad" cx="42%" cy="32%" r="65%">
              <stop offset="0%" stopColor="#89dcfb" />
              <stop offset="50%" stopColor="#35a4d1" />
              <stop offset="100%" stopColor="#186989" />
            </radialGradient>
          </defs>
          {/* Outer Ring & Inner Hole using evenodd fill rule */}
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M16 6.5 C7.5 6.5 1.5 10.5 1.5 16 C1.5 21.5 7.5 25.5 16 25.5 C24.5 25.5 30.5 21.5 30.5 16 C30.5 10.5 24.5 6.5 16 6.5 Z M16 12.2 C12 12.2 9.5 13.8 9.5 16 C9.5 18.2 12 19.8 16 19.8 C20 19.8 22.5 18.2 22.5 16 C22.5 13.8 20 12.2 16 12.2 Z"
            fill="url(#torus-grad)"
            stroke="#1d7a9f"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          {/* Top illuminated rim highlight curve */}
          <path
            d="M5 15.2 C7 10.5 11 8.2 16 8.2 C21 8.2 25 10.5 27 15.2"
            fill="none"
            stroke="#d4f4ff"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity=".7"
          />
        </svg>
      );
    case "pyramid":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Right sloping facet (illuminated) */}
          <path
            d="M16 4 L28 20 L16 27 Z"
            fill="#78d5f8"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Left sloping facet */}
          <path
            d="M16 4 L4 20 L16 27 Z"
            fill="#38a7d5"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Center ridge seam */}
          <path
            d="M16 4 L16 27"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "wedge":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Left vertical side wall */}
          <path
            d="M5 8 L18 5 L18 24 L5 24 Z"
            fill="#38a7d5"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Top sloped ramp face (illuminated) */}
          <path
            d="M5 8 L18 5 L28 21 L15 24 Z"
            fill="#78d5f8"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Right sloped triangular side */}
          <path
            d="M18 5 L28 21 L18 24 Z"
            fill="#2087b2"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "polygonPrism":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Top hexagon face (illuminated) */}
          <path
            d="M16 4 L25 8 L25 14 L16 18 L7 14 L7 8 Z"
            fill="#78d5f8"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Left front side */}
          <path
            d="M7 14 L16 18 L16 27 L7 23 Z"
            fill="#38a7d5"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Right front side */}
          <path
            d="M16 18 L25 14 L25 23 L16 27 Z"
            fill="#2087b2"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "hemisphere":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id="dome-grad" cx="40%" cy="32%" r="65%">
              <stop offset="0%" stopColor="#89dcfb" />
              <stop offset="55%" stopColor="#35a4d1" />
              <stop offset="100%" stopColor="#186989" />
            </radialGradient>
          </defs>
          {/* Dome curved body */}
          <path
            d="M4 22 C4 11 9.5 5 16 5 C22.5 5 28 11 28 22 C28 25.5 22.5 27.5 16 27.5 C9.5 27.5 4 25.5 4 22 Z"
            fill="url(#dome-grad)"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Base ellipse highlight seam */}
          <path
            d="M4 22 C4 25.5 9.5 27.5 16 27.5 C22.5 27.5 28 25.5 28 22"
            fill="none"
            stroke="#1d7a9f"
            strokeWidth="1.2"
          />
        </svg>
      );
    case "capsule":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="capsule-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#78d5f8" />
              <stop offset="50%" stopColor="#38a7d5" />
              <stop offset="100%" stopColor="#1d7a9f" />
            </linearGradient>
          </defs>
          {/* 3D Capsule Pill Body */}
          <rect
            x="10.5"
            y="4.5"
            width="11"
            height="23"
            rx="5.5"
            ry="5.5"
            fill="url(#capsule-grad)"
            stroke="#1d7a9f"
            strokeWidth="1.2"
          />
          {/* Subtle 3D highlight strip along left side */}
          <path
            d="M13 10 L13 22"
            stroke="#ffffff"
            strokeWidth="1"
            strokeLinecap="round"
            opacity=".55"
          />
        </svg>
      );
    case "tube":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="tube-outer-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#78d5f8" />
              <stop offset="50%" stopColor="#38a7d5" />
              <stop offset="100%" stopColor="#2087b2" />
            </linearGradient>
          </defs>
          {/* Outer Cylindrical Body */}
          <path
            d="M5 8 L5 24 C5 28 27 28 27 24 L27 8 Z"
            fill="url(#tube-outer-grad)"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Dark Inner Bore Depth */}
          <ellipse cx="16" cy="8" rx="6.5" ry="2.6" fill="#186989" stroke="#1d7a9f" strokeWidth="1.1" />
          {/* Top Flat Annular Rim Face */}
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M16 4 C22 4 27 5.8 27 8 C27 10.2 22 12 16 12 C10 12 5 10.2 5 8 C5 5.8 10 4 16 4 Z M16 5.4 C20.5 5.4 22.5 6.5 22.5 8 C22.5 9.5 20.5 10.6 16 10.6 C11.5 10.6 9.5 9.5 9.5 8 C9.5 6.5 11.5 5.4 16 5.4 Z"
            fill="#a6e6fc"
            stroke="#1d7a9f"
            strokeWidth="1.1"
          />
          {/* Bottom Rim Curve */}
          <path
            d="M5 24 C5 28 27 28 27 24"
            fill="none"
            stroke="#1d7a9f"
            strokeWidth="1.2"
          />
        </svg>
      );
    case "paraboloid":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id="paraboloid-grad" cx="42%" cy="28%" r="70%">
              <stop offset="0%" stopColor="#89dcfb" />
              <stop offset="55%" stopColor="#35a4d1" />
              <stop offset="100%" stopColor="#186989" />
            </radialGradient>
          </defs>
          {/* Parabolic Dome Body */}
          <path
            d="M5 24 C5 13 11 4 16 4 C21 4 27 13 27 24 C27 27.5 22 28.5 16 28.5 C10 28.5 5 27.5 5 24 Z"
            fill="url(#paraboloid-grad)"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Base ellipse highlight rim */}
          <path
            d="M5 24 C5 27.5 10 28.5 16 28.5 C22 28.5 27 27.5 27 24"
            fill="none"
            stroke="#1d7a9f"
            strokeWidth="1.2"
          />
        </svg>
      );
    case "text":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Top Face of 3D T */}
          <path
            d="M6 9 L11 4 L27 4 L22 9 Z"
            fill="#78d5f8"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Right Extrusion Faces */}
          <path
            d="M22 9 L27 4 L27 9 L22 14 Z"
            fill="#2087b2"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M17 14 L22 9 L22 22 L17 27 Z"
            fill="#186989"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Front Face of 3D T */}
          <path
            d="M6 9 L22 9 L22 14 L17 14 L17 27 L11 27 L11 14 L6 14 Z"
            fill="#38a7d5"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "connector":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* 3D Connector Socket / Peg */}
          <path d="M10 7 L22 7 L26 14 L18 14 L18 25 L14 25 L14 14 L6 14 Z" fill="#38a7d5" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M10 7 L14 4 L26 4 L22 7 Z" fill="#78d5f8" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M22 7 L26 4 L30 11 L26 14 Z" fill="#2087b2" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "threadedRod":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Hex Head */}
          <path d="M16 3 L25 7.5 L16 12 L7 7.5 Z" fill="#78d5f8" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M7 7.5 L16 12 V16 L7 11.5 Z" fill="#38a7d5" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M25 7.5 L16 12 V16 L25 11.5 Z" fill="#2087b2" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          {/* Threaded Shaft with ridges */}
          <path d="M10 16 V27 C10 28.5 16 29 16 29 C16 29 22 28.5 22 27 V16 Z" fill="#38a7d5" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M10 18.5 L22 17M10 21.5 L22 20M10 24.5 L22 23M10 27.5 L22 26" stroke="#78d5f8" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "threadedNut":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Hex Nut Top */}
          <path d="M16 4 L27 9.5 L27 15 L16 20.5 L5 15 L5 9.5 Z" fill="#78d5f8" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          {/* Hex Nut Left/Right Faces */}
          <path d="M5 15 L16 20.5 V27 L5 21.5 Z" fill="#38a7d5" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M27 15 L16 20.5 V27 L27 21.5 Z" fill="#2087b2" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          {/* Center Hole with Threads */}
          <ellipse cx="16" cy="12.5" rx="5.5" ry="3" fill="#156485" stroke="#1d7a9f" strokeWidth="1" />
          <path d="M12 12.5 C12 14 20 14 20 12.5" fill="none" stroke="#78d5f8" strokeWidth="1" />
        </svg>
      );
    case "star":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* 3D Extruded Star Icon */}
          <path
            d="M16 2.5 L19.5 9.5 L27 10.5 L21.5 15.5 L23 23 L16 19 L9 23 L10.5 15.5 L5 10.5 L12.5 9.5 Z"
            fill="#78d5f8"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M23 23 L16 19 L9 23 L9 26.5 L16 22.5 L23 26.5 Z"
            fill="#2087b2"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M9 23 L10.5 15.5 L5 10.5 L5 14 L10.5 19 L9 26.5 Z"
            fill="#38a7d5"
            stroke="#1d7a9f"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "tray":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Isometric Tray / Organizer Bin */}
          <path d="M4 11 L16 5 L28 11 L16 17 Z" fill="#78d5f8" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M7 11.5 L16 7 L25 11.5 L16 16 Z" fill="#156485" stroke="#1d7a9f" strokeWidth="1" strokeLinejoin="round" />
          <path d="M4 11 L16 17 V25 L4 19 Z" fill="#38a7d5" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M28 11 L16 17 V25 L28 19 Z" fill="#2087b2" stroke="#1d7a9f" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "ellipsoid":
      return (
        <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          {/* Isometric 3D Ellipsoid */}
          <defs>
            <radialGradient id="ellipsoid-grad" cx="40%" cy="35%" r="60%">
              <stop offset="0%" stopColor="#78d5f8" />
              <stop offset="60%" stopColor="#38a7d5" />
              <stop offset="100%" stopColor="#1d7a9f" />
            </radialGradient>
          </defs>
          <ellipse cx="16" cy="16" rx="13" ry="8" fill="url(#ellipsoid-grad)" stroke="#1d7a9f" strokeWidth="1.2" />
          <path d="M3 16 C3 19 29 19 29 16" fill="none" stroke="#78d5f8" strokeWidth="1" opacity="0.6" />
        </svg>
      );
  }
}
