import { useEffect, useState } from "react";
import type { SnapAnchor } from "../snapping/snap";

export type SpacingAxis = {
  enabled: boolean;
  fixedAnchor: SnapAnchor;
  movingAnchor: SnapAnchor;
  gap: number;
};

export type SpacingSettings = {
  axes: SpacingAxis[];
};

const labels = ["Left / right", "Front / back", "Up / down"];
const edges = [
  ["Left", "Centre", "Right"],
  ["Front", "Centre", "Back"],
  ["Bottom", "Centre", "Top"],
];
const anchors: SnapAnchor[] = ["min", "center", "max"];

const presets = [
  [
    { label: "← Outside Left", fixed: "min" as SnapAnchor, moving: "max" as SnapAnchor },
    { label: "|← Flush Left", fixed: "min" as SnapAnchor, moving: "min" as SnapAnchor },
    { label: "↔ Center", fixed: "center" as SnapAnchor, moving: "center" as SnapAnchor },
    { label: "Flush Right →|", fixed: "max" as SnapAnchor, moving: "max" as SnapAnchor },
    { label: "Outside Right →", fixed: "max" as SnapAnchor, moving: "min" as SnapAnchor },
  ],
  [
    { label: "↙ Outside Front", fixed: "min" as SnapAnchor, moving: "max" as SnapAnchor },
    { label: "|↙ Flush Front", fixed: "min" as SnapAnchor, moving: "min" as SnapAnchor },
    { label: "↔ Center", fixed: "center" as SnapAnchor, moving: "center" as SnapAnchor },
    { label: "Flush Back ↗|", fixed: "max" as SnapAnchor, moving: "max" as SnapAnchor },
    { label: "Outside Back ↗", fixed: "max" as SnapAnchor, moving: "min" as SnapAnchor },
  ],
  [
    { label: "⮶ Outside Below", fixed: "min" as SnapAnchor, moving: "max" as SnapAnchor },
    { label: "|⮶ Flush Bottom", fixed: "min" as SnapAnchor, moving: "min" as SnapAnchor },
    { label: "↕ Center", fixed: "center" as SnapAnchor, moving: "center" as SnapAnchor },
    { label: "Flush Top ⮵|", fixed: "max" as SnapAnchor, moving: "max" as SnapAnchor },
    { label: "Outside Above ⮵", fixed: "max" as SnapAnchor, moving: "min" as SnapAnchor },
  ],
];

function Icon({ kind, rotate = 0 }: { kind: "gap" | "align" | "arrow" | "swap" | "check"; rotate?: number }) {
  return (
    <svg className="spacing-icon" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${rotate}deg)` }}>
      <path
        d={
          kind === "gap"
            ? "M3 4v16M21 4v16M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3"
            : kind === "align"
              ? "M3 20h18M5 16V8h5v8H5Zm9 0V3h5v13h-5Z"
              : kind === "arrow"
                ? "M4 5v14M8 12h12m-5-5 5 5-5 5"
                : kind === "swap"
                  ? "M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4"
                  : "m5 12 4 4L19 6"
        }
      />
    </svg>
  );
}

export function SpacingPanel({
  fixedName,
  movingName,
  onSwap,
  onApply,
  onPreview,
}: {
  fixedName: string;
  movingName: string;
  onSwap: () => void;
  onApply: (settings: SpacingSettings) => void;
  onPreview: (settings: SpacingSettings | null) => void;
}) {
  const [settings, setSettings] = useState<SpacingSettings>({
    axes: [
      { enabled: true, fixedAnchor: "max", movingAnchor: "min", gap: 0 },
      { enabled: true, fixedAnchor: "min", movingAnchor: "min", gap: 0 },
      { enabled: true, fixedAnchor: "max", movingAnchor: "max", gap: 0 },
    ],
  });
  const [preview, setPreview] = useState(true);

  const enabled = settings.axes.some((a) => a.enabled);
  const invalid = settings.axes.some((a) => a.enabled && (!Number.isFinite(a.gap) || a.gap < 0));

  useEffect(() => {
    onPreview(preview && enabled && !invalid ? settings : null);
    return () => onPreview(null);
  }, [preview, enabled, invalid, settings, onPreview]);

  const change = (index: number, update: Partial<SpacingAxis>) =>
    setSettings((s) => ({
      ...s,
      axes: s.axes.map((a, i) => (i === index ? { ...a, ...update } : a)),
    }));

  return (
    <div className="spacing-editor">
      <div className="spacing-objects">
        <div>
          <span className="field-label">Stays fixed</span>
          <strong>{fixedName}</strong>
        </div>
        <button onClick={onSwap} aria-label="Swap fixed and moving objects" title="Swap fixed and moving objects">
          <Icon kind="swap" />
        </button>
        <div>
          <span className="field-label">Moves</span>
          <strong>{movingName}</strong>
        </div>
      </div>

      <div className="spacing-section-label">
        <strong>Position & alignment per axis</strong>
        <span>Distances in mm</span>
      </div>

      {settings.axes.map((axis, i) => {
        const isOutside =
          (axis.fixedAnchor === "min" && axis.movingAnchor === "max") ||
          (axis.fixedAnchor === "max" && axis.movingAnchor === "min");

        return (
          <section key={i} className={`spacing-axis${axis.enabled ? " enabled" : ""}`}>
            <div className="spacing-axis-heading">
              <b className="spacing-axis-badge">{"XYZ"[i]}</b>
              <div>
                <strong>{labels[i]}</strong>
                <small>{axis.enabled ? "Adjust this axis" : "Keep current position"}</small>
              </div>
              <label className="spacing-switch">
                <span>{axis.enabled ? "On" : "Off"}</span>
                <input
                  type="checkbox"
                  aria-label={`Enable ${"XYZ"[i]} axis`}
                  checked={axis.enabled}
                  onChange={(e) => change(i, { enabled: e.target.checked })}
                />
                <span className="spacing-track" />
              </label>
            </div>

            <fieldset disabled={!axis.enabled} aria-label={`${"XYZ"[i]} axis settings`}>
              {/* Quick Preset Buttons */}
              <div className="spacing-quick-presets">
                {presets[i].map((preset) => {
                  const isActive =
                    axis.fixedAnchor === preset.fixed && axis.movingAnchor === preset.moving;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      className={`spacing-preset-btn ${isActive ? "active" : ""}`}
                      onClick={() => change(i, { fixedAnchor: preset.fixed, movingAnchor: preset.moving })}
                      title={`Match Fixed (${preset.fixed}) with Moving (${preset.moving})`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>

              {/* Explicit Face Choosers: Fixed vs Moving */}
              <div className="spacing-face-pickers">
                <div>
                  <span className="field-label">Fixed ({edges[i][anchors.indexOf(axis.fixedAnchor)]})</span>
                  <div className="spacing-choices">
                    {edges[i].map((label, j) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={axis.fixedAnchor === anchors[j]}
                        onClick={() => change(i, { fixedAnchor: anchors[j] })}
                      >
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="field-label">Moving ({edges[i][anchors.indexOf(axis.movingAnchor)]})</span>
                  <div className="spacing-choices">
                    {edges[i].map((label, j) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={axis.movingAnchor === anchors[j]}
                        onClick={() => change(i, { movingAnchor: anchors[j] })}
                      >
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Offset / Gap Input */}
              <div className="spacing-distance-row">
                <label className="field-label" htmlFor={`spacing-distance-${i}`}>
                  {isOutside ? "Gap Distance" : "Offset"}
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div className="spacing-number">
                    <input
                      id={`spacing-distance-${i}`}
                      aria-label={`${"XYZ"[i]} distance in millimetres`}
                      type="number"
                      min="0"
                      step="0.5"
                      value={Number.isFinite(axis.gap) ? axis.gap : 0}
                      onChange={(e) =>
                        change(i, { gap: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) })
                      }
                    />
                    <span>mm</span>
                  </div>
                  {axis.gap !== 0 && (
                    <button
                      type="button"
                      className="spacing-zero-btn"
                      onClick={() => change(i, { gap: 0 })}
                      title="Set to 0 mm (touching flush)"
                    >
                      0 mm
                    </button>
                  )}
                </div>
              </div>
            </fieldset>
          </section>
        );
      })}

      <p className="hint" aria-live="polite">
        {enabled
          ? settings.axes
              .map((a, i) => {
                if (!a.enabled) return null;
                const isOutside =
                  (a.fixedAnchor === "min" && a.movingAnchor === "max") ||
                  (a.fixedAnchor === "max" && a.movingAnchor === "min");
                const fName = edges[i][anchors.indexOf(a.fixedAnchor)];
                const mName = edges[i][anchors.indexOf(a.movingAnchor)];
                return `${"XYZ"[i]}: ${fName} ↔ ${mName} (${a.gap}mm ${isOutside ? "gap" : "offset"})`;
              })
              .filter(Boolean)
              .join(" · ")
          : "Turn on an axis to adjust its spacing."}
      </p>

      {invalid && <p role="alert" className="hint">Enter a distance of zero or more.</p>}

      <div className="spacing-actions">
        <label className="spacing-switch">
          <span>Preview</span>
          <input
            type="checkbox"
            aria-label="Preview spacing"
            checked={preview}
            onChange={(e) => setPreview(e.target.checked)}
          />
          <span className="spacing-track" />
        </label>
        <button
          type="button"
          disabled={!settings.axes.some((a) => a.enabled)}
          onClick={() => {
            setSettings((s) => ({
              ...s,
              axes: s.axes.map((a) => (a.enabled ? { ...a, gap: 0 } : a)),
            }));
            setPreview(true);
          }}
        >
          <Icon kind="gap" />
          Snap flush (0)
        </button>
      </div>

      <button className="primary" disabled={!enabled || invalid} onClick={() => onApply(settings)}>
        <Icon kind="check" />
        Apply spacing
      </button>
    </div>
  );
}
