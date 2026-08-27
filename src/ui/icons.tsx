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

/**
 * A wireframe globe: outline plus the two crossing meridians that read as a
 * mesh laid over a surface. Deliberately not another cube — the transparency
 * icon already is one, and side by side in the rail the two need to be
 * tellable apart at a glance.
 */
export function WireframeIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="8.5" />
        <ellipse cx="12" cy="12" rx="3.7" ry="8.5" />
        <path d="M3.5 12h17" />
        <path d="M5 7.2c1.9 1.1 4.3 1.7 7 1.7s5.1-.6 7-1.7" opacity=".75" />
        <path d="M5 16.8c1.9-1.1 4.3-1.7 7-1.7s5.1.6 7 1.7" opacity=".75" />
      </g>
    </svg>
  );
}

/**
 * Drop: a body falling onto the surface that stops it. The bar underneath is
 * what makes it read as "lands on something" rather than a plain download or
 * move-down arrow.
 */
export function DropIcon({ className = "tool-icon" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="2.5" width="8" height="6" rx="1.2" fill="currentColor" opacity=".55" />
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 10v5.5" />
        <path d="M8.7 12.8 12 16.1l3.3-3.3" />
        <path d="M4.5 19.5h15" />
      </g>
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
        d="M12 5.6a6.4 6.4 0 0 1 0 12.8 6.4 6.4 0 0 1 0-12.8Z"
        fill="currentColor"
        opacity=".55"
      />
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="9" cy="12" r="6.4" />
        <circle cx="15" cy="12" r="6.4" />
      </g>
    </svg>
  );
}
