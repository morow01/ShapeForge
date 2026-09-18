import { useEffect, useState } from "react";
import type { AppearancePreference, DisplayUnit } from "../measurement";
import type { ViewportQuality } from "../viewport/quality";
import type { CollisionHighlightStyle } from "../viewport/scene";

export interface BuildPlateSize {
  width: number;
  depth: number;
}

export const BUILD_PLATE_PRESETS = [
  { id: "bambu-standard", label: "Bambu Lab X1 / P1 / A1 (256 × 256 mm)", width: 256, depth: 256 },
  { id: "bambu-h2d", label: "Bambu Lab H2D / Large (350 × 350 mm)", width: 350, depth: 350 },
  { id: "bambu-mini", label: "Bambu Lab A1 mini (180 × 180 mm)", width: 180, depth: 180 },
  { id: "prusa-mk", label: "Prusa MK3 / MK4 (250 × 210 mm)", width: 250, depth: 210 },
  { id: "prusa-xl", label: "Prusa XL (360 × 360 mm)", width: 360, depth: 360 },
  { id: "creality-k1", label: "Creality Ender 3 / K1 (220 × 220 mm)", width: 220, depth: 220 },
  { id: "creality-max", label: "Creality K1 Max / CR-10 (300 × 300 mm)", width: 300, depth: 300 },
  { id: "elegoo-max", label: "Elegoo Neptune 4 Max (420 × 420 mm)", width: 420, depth: 420 },
  { id: "large-400", label: "Large Format (400 × 400 mm)", width: 400, depth: 400 },
  { id: "custom", label: "Custom size…", width: 0, depth: 0 },
] as const;

interface Props {
  viewportQuality: ViewportQuality;
  onViewportQuality: (quality: ViewportQuality) => void;
  open: boolean;
  unit: DisplayUnit;
  decimals: number;
  appearance: AppearancePreference;
  plateVisible: boolean;
  viewCubeVisible: boolean;
  plateSize: BuildPlateSize;
  snapToGrid: boolean;
  snapToObjects: boolean;
  showSelectedCollisionContacts: boolean;
  collisionHighlightStyle: CollisionHighlightStyle;
  randomNewObjectColors: boolean;
  /** Global performance override: forces every object's edge lines off,
   *  regardless of each one's own "Hide lines on this object" setting. */
  hideAllLines: boolean;
  onUnit: (unit: DisplayUnit) => void;
  onDecimals: (decimals: number) => void;
  onAppearance: (appearance: AppearancePreference) => void;
  onPlateVisible: (visible: boolean) => void;
  onViewCubeVisible: (visible: boolean) => void;
  onPlateSize: (size: BuildPlateSize) => void;
  onSnapToGrid: (enabled: boolean) => void;
  onSnapToObjects: (enabled: boolean) => void;
  onShowSelectedCollisionContacts: (enabled: boolean) => void;
  onCollisionHighlightStyle: (style: CollisionHighlightStyle) => void;
  onRandomNewObjectColors: (enabled: boolean) => void;
  onHideAllLines: (enabled: boolean) => void;
  onClose: () => void;
  /** Live frames actually rendered in roughly the last second, so "does this
   *  setting do anything" can be answered by watching a number instead of
   *  going by feel — the viewport isn't always the bottleneck, so the fps
   *  cap alone doesn't always translate into a perceptible difference. */
  getFps?: () => number | null;
}

function SettingsToggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" />
    </button>
  );
}

export type SettingsCategory = "general" | "performance" | "plate" | "snapping";

const CATEGORIES: { id: SettingsCategory; label: string; desc: string }[] = [
  { id: "general", label: "General", desc: "Units, precision & colors" },
  { id: "performance", label: "Performance", desc: "Quality & line display" },
  { id: "plate", label: "Build Plate", desc: "3D printer bed size" },
  { id: "snapping", label: "Snapping", desc: "Grid & object guides" },
];

export function SettingsModal({
  viewportQuality,
  onViewportQuality,
  open,
  unit,
  decimals,
  appearance,
  plateVisible,
  viewCubeVisible,
  plateSize,
  snapToGrid,
  snapToObjects,
  showSelectedCollisionContacts,
  collisionHighlightStyle,
  randomNewObjectColors,
  hideAllLines,
  onUnit,
  onDecimals,
  onAppearance,
  onPlateVisible,
  onViewCubeVisible,
  onPlateSize,
  onSnapToGrid,
  onSnapToObjects,
  onShowSelectedCollisionContacts,
  onCollisionHighlightStyle,
  onRandomNewObjectColors,
  onHideAllLines,
  onClose,
  getFps,
}: Props) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !getFps) return;
    setFps(getFps());
    const id = setInterval(() => setFps(getFps()), 500);
    return () => clearInterval(id);
  }, [open, getFps]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const matchingPreset = BUILD_PLATE_PRESETS.find(
    (p) => p.id !== "custom" && p.width === plateSize.width && p.depth === plateSize.depth,
  );
  const currentPresetId = matchingPreset ? matchingPreset.id : "custom";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <section className="settings-modal two-pane" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <div className="modal-title-group">
            <h2 id="settings-title">Settings</h2>
            <p className="modal-subtitle">Preferences apply to every design on this device.</p>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close settings">×</button>
        </header>

        <div className="settings-two-pane-body">
          <nav className="settings-sidebar" aria-label="Settings categories">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`settings-tab-btn ${activeCategory === cat.id ? "active" : ""}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                <div className="settings-tab-text">
                  <strong>{cat.label}</strong>
                  <small>{cat.desc}</small>
                </div>
              </button>
            ))}
          </nav>

          <div className="settings-content-pane">
            {activeCategory === "general" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h3>General Preferences</h3>
                  <p>Measurement units, decimal precision and defaults</p>
                </div>
                <label className="settings-row">
                  <span><strong>Units</strong><small>Used for measurements and typed dimensions</small></span>
                  <select value={unit} onChange={(e) => onUnit(e.target.value as DisplayUnit)}>
                    <option value="mm">Millimetres (mm)</option>
                    <option value="cm">Centimetres (cm)</option>
                    <option value="in">Inches (in)</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span><strong>Decimal places</strong><small>Controls displayed measurement precision</small></span>
                  <select value={decimals} onChange={(e) => onDecimals(Number(e.target.value))}>
                    {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="settings-row">
                  <span><strong>Appearance</strong><small>Dark theme styling will be completed next</small></span>
                  <select value={appearance} onChange={(e) => onAppearance(e.target.value as AppearancePreference)}>
                    <option value="light">Light</option>
                    <option value="dark" disabled>Dark (coming soon)</option>
                    <option value="system" disabled>System (coming soon)</option>
                  </select>
                </label>
                <div className="settings-row">
                  <span><strong>Random colours for new objects</strong><small>Gives each newly created object a varied colour instead of default blue</small></span>
                  <SettingsToggle checked={randomNewObjectColors} onChange={onRandomNewObjectColors} label="Random colours for new objects" />
                </div>
              </div>
            )}

            {activeCategory === "performance" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h3>Performance & Quality</h3>
                  <p>Render resolution, framerate, and geometry outline settings</p>
                </div>
                <label className="settings-row">
                  <span>
                    <strong>Scene display quality</strong>
                    <small>
                      {viewportQuality === "draft" ? "Faster: reduced resolution, up to 30 fps" : viewportQuality === "normal" ? "Balanced: standard resolution, up to 60 fps" : "Sharper: high resolution, full refresh rate"}.
                      Model and export quality stay unchanged.
                      {fps !== null ? ` Currently rendering ~${fps} fps.` : ""}
                    </small>
                  </span>
                  <select value={viewportQuality} onChange={(e) => onViewportQuality(e.target.value as ViewportQuality)}>
                    <option value="draft">Draft (30 fps)</option>
                    <option value="normal">Normal (60 fps)</option>
                    <option value="high">High (Full)</option>
                  </select>
                </label>
                <div className="settings-row">
                  <span>
                    <strong>Hide all lines</strong>
                    <small>Turns off edge lines on every object at once for significantly faster scene performance</small>
                  </span>
                  <SettingsToggle checked={hideAllLines} onChange={onHideAllLines} label="Hide all lines" />
                </div>
                <div className="settings-row">
                  <span>
                    <strong>Show view cube</strong>
                    <small>The orientation cube and axis triad in the top-right of the viewport. The Home key still resets the view when it is hidden</small>
                  </span>
                  <SettingsToggle checked={viewCubeVisible} onChange={onViewCubeVisible} label="Show view cube" />
                </div>
              </div>
            )}

            {activeCategory === "plate" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h3>Build Plate</h3>
                  <p>3D printer bed size presets and grid visibility</p>
                </div>
                <div className="settings-row">
                  <span><strong>Show build plate</strong><small>Display the printer bed and ground alignment grid</small></span>
                  <SettingsToggle checked={plateVisible} onChange={onPlateVisible} label="Show build plate" />
                </div>
                <label className="settings-row">
                  <span><strong>Build plate size</strong><small>Preset 3D printer bed dimensions (Width × Depth)</small></span>
                  <select
                    value={currentPresetId}
                    onChange={(e) => {
                      const targetId = e.target.value;
                      if (targetId === "custom") return;
                      const found = BUILD_PLATE_PRESETS.find((p) => p.id === targetId);
                      if (found) {
                        onPlateSize({ width: found.width, depth: found.depth });
                      }
                    }}
                  >
                    {BUILD_PLATE_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </label>
                {currentPresetId === "custom" && (
                  <div className="settings-row plate-custom-row">
                    <span><strong>Custom bed dimensions</strong><small>Width (X) and Depth (Y) in millimetres</small></span>
                    <div className="plate-dimensions-inputs">
                      <div className="plate-dim-field">
                        <span className="plate-dim-label">X</span>
                        <input
                          type="number"
                          min="50"
                          max="2000"
                          step="10"
                          value={plateSize.width}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            if (Number.isFinite(val)) {
                              onPlateSize({ width: Math.max(10, Math.min(2000, val)), depth: plateSize.depth });
                            }
                          }}
                          className="plate-dim-input"
                          aria-label="Build plate width in mm"
                        />
                        <span className="plate-dim-unit">mm</span>
                      </div>
                      <span className="plate-dim-cross">×</span>
                      <div className="plate-dim-field">
                        <span className="plate-dim-label">Y</span>
                        <input
                          type="number"
                          min="50"
                          max="2000"
                          step="10"
                          value={plateSize.depth}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            if (Number.isFinite(val)) {
                              onPlateSize({ width: plateSize.width, depth: Math.max(10, Math.min(2000, val)) });
                            }
                          }}
                          className="plate-dim-input"
                          aria-label="Build plate depth in mm"
                        />
                        <span className="plate-dim-unit">mm</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeCategory === "snapping" && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h3>Snapping & Guides</h3>
                  <p>Movement snapping and collision detection indicators</p>
                </div>
                <div className="settings-row">
                  <span><strong>Snap to grid</strong><small>Moves objects in 1 mm steps while dragging</small></span>
                  <SettingsToggle checked={snapToGrid} onChange={onSnapToGrid} label="Snap to grid" />
                </div>
                <div className="settings-row">
                  <span><strong>Snap to objects</strong><small>Aligns nearby object edges and shows Smart Guides</small></span>
                  <SettingsToggle checked={snapToObjects} onChange={onSnapToObjects} label="Snap to objects" />
                </div>
                <div className="settings-row">
                  <span><strong>Show selected collisions</strong><small>Keeps touching areas highlighted after selecting an object</small></span>
                  <SettingsToggle checked={showSelectedCollisionContacts} onChange={onShowSelectedCollisionContacts} label="Show selected collisions" />
                </div>
                <label className="settings-row">
                  <span>
                    <strong>Collision highlight style</strong>
                    <small>
                      How a touching, coincident face is drawn. A curved or angled contact has no flat
                      area to fill, so it always shows as an outline regardless of this setting.
                    </small>
                  </span>
                  <select
                    value={collisionHighlightStyle}
                    onChange={(e) => onCollisionHighlightStyle(e.target.value as CollisionHighlightStyle)}
                  >
                    <option value="outline">Outline</option>
                    <option value="face">Filled face</option>
                    <option value="both">Both</option>
                  </select>
                </label>
              </div>
            )}
          </div>
        </div>

        <footer className="settings-footer">
          <button type="button" className="settings-ok-btn" onClick={onClose} autoFocus>
            OK
          </button>
        </footer>
      </section>
    </div>
  );
}
