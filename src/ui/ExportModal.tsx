import type { ExportQuality } from "../kernel/types";
import { ExportIcon } from "./icons";

export const EXPORT_QUALITY_HINT: Record<ExportQuality, string> = {
  draft: "Draft — fastest, visibly faceted curves. Good for test prints.",
  standard: "Standard — faint facets on curved surfaces, exports in a moment.",
  fine: "Fine — smooth curves, but a curved part can take several seconds.",
};

const QUALITY_OPTIONS: { value: ExportQuality; label: string; sides: number }[] = [
  { value: "draft", label: "Draft", sides: 6 },
  { value: "standard", label: "Standard", sides: 12 },
  { value: "fine", label: "Fine", sides: 24 },
];

/** A regular polygon whose side count stands in for facet smoothness — the
 *  same idea Inspector.tsx already uses for its own smoothness fields, so
 *  Draft/Standard/Fine reads as "rougher to smoother" at a glance. */
function QualityFacetIcon({ sides }: { sides: number }) {
  const points = Array.from({ length: sides }, (_, i) => {
    const angle = (i * 2 * Math.PI) / sides - Math.PI / 2;
    return `${16 + 11 * Math.cos(angle)},${16 + 11 * Math.sin(angle)}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <polygon points={points} />
    </svg>
  );
}

/** STL (outline only) vs 3MF (filled) — echoing the app's own Solid/Wireframe
 *  cube language: 3MF carries colour and per-object data, STL is bare geometry. */
function FormatCubeIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 4 27 10V22L16 28 5 22V10Z" fill={filled ? "currentColor" : "none"} opacity={filled ? .9 : 1} />
      <path d="M16 4 27 10V22L16 28 5 22V10Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16 16 5 10M16 16l11-6M16 16v12" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".55" />
    </svg>
  );
}

interface Props {
  open: boolean;
  quality: ExportQuality;
  format: "stl" | "3mf";
  exporting: boolean;
  readyExportUrl: string | null;
  selectedCount: number;
  onQuality: (quality: ExportQuality) => void;
  onFormat: (format: "stl" | "3mf") => void;
  onExport: () => void;
  onClose: () => void;
}

/**
 * Export used to be four permanently-visible top-bar controls (Quality
 * select, Format select, a big teal pill). It's now a File-menu row that
 * opens this — the same dialog chrome the app already uses for Settings
 * and the Projects Library, rather than a nested submenu that exists
 * nowhere else in the app.
 */
export function ExportModal({
  open,
  quality,
  format,
  exporting,
  readyExportUrl,
  selectedCount,
  onQuality,
  onFormat,
  onExport,
  onClose,
}: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <section className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-modal-title">
        <header className="modal-header">
          <div className="modal-title-group">
            <h2 id="export-modal-title">Export</h2>
            <p className="modal-subtitle">
              {selectedCount
                ? `${selectedCount} selected object${selectedCount > 1 ? "s" : ""}`
                : "Entire scene"}
            </p>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close export">×</button>
        </header>
        <div className="export-modal-body">
          <div className="field">
            <span className="field-label">Quality</span>
            <div className="binary-choice three icon-choice labeled" role="group" aria-label="Export quality">
              {QUALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={quality === opt.value ? "on" : ""}
                  aria-pressed={quality === opt.value}
                  title={EXPORT_QUALITY_HINT[opt.value]}
                  disabled={exporting}
                  onClick={() => onQuality(opt.value)}
                >
                  <QualityFacetIcon sides={opt.sides} />
                  <span className="icon-choice-label">{opt.label}</span>
                </button>
              ))}
            </div>
            <p className="field-hint">{EXPORT_QUALITY_HINT[quality]}</p>
          </div>
          <div className="field">
            <span className="field-label">Format</span>
            <div className="binary-choice icon-choice labeled" role="group" aria-label="Export format">
              <button
                type="button"
                className={format === "stl" ? "on" : ""}
                aria-pressed={format === "stl"}
                title="STL — no units, so a slicer has to guess the scale"
                disabled={exporting}
                onClick={() => onFormat("stl")}
              >
                <FormatCubeIcon filled={false} />
                <span className="icon-choice-label">STL</span>
              </button>
              <button
                type="button"
                className={format === "3mf" ? "on" : ""}
                aria-pressed={format === "3mf"}
                title="3MF — states millimetres, keeps each object separate and carries its colour"
                disabled={exporting}
                onClick={() => onFormat("3mf")}
              >
                <FormatCubeIcon filled />
                <span className="icon-choice-label">3MF</span>
              </button>
            </div>
            <p className="field-hint">
              {format === "stl"
                ? "No units, so a slicer has to guess the scale."
                : "States millimetres, keeps each object separate and carries its colour."}
            </p>
          </div>
        </div>
        <footer className="export-modal-footer">
          <button className="export-modal-cancel" onClick={onClose}>Cancel</button>
          <button
            className="export-btn export-modal-confirm"
            onClick={() => { onExport(); onClose(); }}
            disabled={exporting}
          >
            <ExportIcon className="tool-icon" />
            <span>{exporting ? "Exporting…" : readyExportUrl ? "Download" : `Export ${format.toUpperCase()}`}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
