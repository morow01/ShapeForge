import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
 * Selection-driven tool suggestions (Shapr3D-style): the tools that make sense
 * for what is selected are listed in a small floating panel, with the most
 * likely one highlighted and the rest in named groups below it (all shown,
 * nothing folded away), and the same list
 * on a right-click. The full toolbar stays one click away ("All tools"), so
 * suggestions are a shortcut, never the only way to reach a tool.
 */

export interface ToolItem {
  id: string;
  label: string;
  /** Must match the toolbar button's aria-label so hover previews work. */
  aria: string;
  icon: ReactNode;
  keys?: string;
  /** False greys the row out; `reason` says what is missing. */
  enabled: boolean;
  reason?: string;
  active?: boolean;
  run: () => void;
  /** Inline sub-choices shown on the row itself, e.g. Mirror's X / Y / Z. */
  choices?: { label: string; title: string; run: () => void }[];
}

/** A one-click choice shown as a small picture, e.g. a shape to add. */
export interface ToolTile {
  id: string;
  label: string;
  icon: ReactNode;
  title?: string;
  run: () => void;
}

export interface ToolSection {
  title?: string;
  items: ToolItem[];
  /** Shown as a grid of pictures above the section's rows. */
  tiles?: ToolTile[];
}

export interface ToolSuggestions {
  /** What the suggestions are for, e.g. "1 object", "1 face". */
  heading: string;
  hint?: string;
  /** The first section is the main tools; later ones carry a title. */
  sections: ToolSection[];
}

function ToolRow({ item, primary, onDone }: { item: ToolItem; primary?: boolean; onDone?: () => void }) {
  return (
    <div className={`adaptive-row${primary ? " primary" : ""}${item.active ? " active" : ""}`}>
      <button
        type="button"
        className="adaptive-tool"
        aria-label={item.aria}
        title={!item.enabled ? item.reason : item.keys && item.keys.length > 3 ? `${item.label} (${item.keys})` : undefined}
        disabled={!item.enabled}
        onClick={() => { item.run(); onDone?.(); }}
      >
        <span className="adaptive-icon" aria-hidden="true">{item.icon}</span>
        <span className="adaptive-label">{item.label}</span>
        {/* Single-key shortcuts fit on the row; longer chords go in the tooltip. */}
        {item.keys && item.keys.length <= 3 && !item.choices && <kbd>{item.keys}</kbd>}
      </button>
      {item.choices && item.enabled && (
        <span className="adaptive-choices">
          {item.choices.map((choice) => (
            <button key={choice.label} type="button" title={choice.title} onClick={() => { choice.run(); onDone?.(); }}>
              {choice.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** The floating suggestions panel over the top-left of the 3D view. */
export function AdaptiveToolPanel({ suggestions }: { suggestions: ToolSuggestions }) {
  // The suggested tool is highlighted only while no tool is actually in use.
  const anyActive = suggestions.sections.some((section) => section.items.some((item) => item.active));
  const firstEnabled = anyActive ? undefined : suggestions.sections[0]?.items.find((item) => item.enabled);
  // The hint says what to do next with the tool in use, so it sits under that
  // tool's own group; with none in use, under the main tools.
  const hintAt = Math.max(0, suggestions.sections.findIndex((section) => section.items.some((item) => item.active)));
  return (
    <div className="adaptive-tools" role="toolbar" aria-label={`Suggested tools for ${suggestions.heading}`}>
      <p className="adaptive-for">Suggested for</p>
      <p className="adaptive-heading">{suggestions.heading}</p>
      {suggestions.sections.map((section, index) => (
        <div key={section.title ?? index} className="adaptive-section">
          {section.title && <p className="adaptive-section-title">{section.title}</p>}
          {section.tiles && (
            <div className="adaptive-tiles">
              {section.tiles.map((tile) => (
                <button key={tile.id} type="button" className="adaptive-tile" title={tile.title ?? tile.label} onClick={tile.run}>
                  <span className="adaptive-tile-icon" aria-hidden="true">{tile.icon}</span>
                  <span className="adaptive-tile-label">{tile.label}</span>
                </button>
              ))}
            </div>
          )}
          {section.items.map((item) => (
            <ToolRow key={item.id} item={item} primary={item === firstEnabled && !item.active} />
          ))}
          {index === hintAt && suggestions.hint && <p className="adaptive-hint">{suggestions.hint}</p>}
        </div>
      ))}
    </div>
  );
}

/** Right-click menu: the same suggestions, at the pointer. */
export function ToolContextMenu({ at, suggestions, onClose }: {
  at: { x: number; y: number };
  suggestions: ToolSuggestions;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  // Keep the whole menu on screen near the pointer.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)),
    });
  }, [at]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);
  const items = suggestions.sections.flatMap((section) => section.items);
  return createPortal(
    <div ref={ref} className="adaptive-context-menu" role="menu" aria-label={`Tools for ${suggestions.heading}`}
      style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <p className="adaptive-for">{suggestions.heading}</p>
      {items.map((item) => <ToolRow key={item.id} item={item} onDone={onClose} />)}
    </div>,
    document.body,
  );
}
