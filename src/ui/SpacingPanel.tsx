import { Fragment, useEffect, useState } from "react";
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

type Pair = [fixed: SnapAnchor, moving: SnapAnchor];

const anchors: SnapAnchor[] = ["min", "center", "max"];
const anchorPos: Record<SnapAnchor, number> = { min: 0, center: 0.5, max: 1 };

// captions/summaries line up with PRESETS: outside-low, flush-low, centre, flush-high, outside-high.
const AXES = [
  {
    key: "X",
    name: "Left / right",
    low: "Left",
    high: "Right",
    captions: ["Left of", "Align left", "Centre", "Align right", "Right of"],
    summaries: ["to the left", "flush left", "centred", "flush right", "to the right"],
  },
  {
    key: "Y",
    name: "Front / back",
    low: "Front",
    high: "Back",
    captions: ["In front of", "Align front", "Centre", "Align back", "Behind"],
    summaries: ["in front", "flush front", "centred", "flush back", "behind"],
  },
  {
    key: "Z",
    name: "Up / down",
    low: "Bottom",
    high: "Top",
    captions: ["Below", "Align bottom", "Centre", "Align top", "On top of"],
    summaries: ["below", "flush bottom", "centred", "flush top", "on top"],
  },
];

const PRESETS: Pair[] = [
  ["min", "max"],
  ["min", "min"],
  ["center", "center"],
  ["max", "max"],
  ["max", "min"],
];

const CENTRED: Pair = ["center", "center"];
const RECIPES: { name: string; icon: [axis: number, ...Pair]; axes: [Pair, Pair, Pair] }[] = [
  { name: "Sit on top", icon: [2, "max", "min"], axes: [CENTRED, CENTRED, ["max", "min"]] },
  { name: "Hang below", icon: [2, "min", "max"], axes: [CENTRED, CENTRED, ["min", "max"]] },
  { name: "Beside right", icon: [0, "max", "min"], axes: [["max", "min"], CENTRED, ["min", "min"]] },
  { name: "Beside left", icon: [0, "min", "max"], axes: [["min", "max"], CENTRED, ["min", "min"]] },
  { name: "In front", icon: [1, "min", "max"], axes: [CENTRED, ["min", "max"], ["min", "min"]] },
  { name: "Behind", icon: [1, "max", "min"], axes: [CENTRED, ["max", "min"], ["min", "min"]] },
  { name: "Centre on", icon: [0, "center", "center"], axes: [CENTRED, CENTRED, CENTRED] },
  { name: "Corner-align", icon: [0, "min", "min"], axes: [["min", "min"], ["min", "min"], ["min", "min"]] },
];

const isOutsidePair = (fixed: SnapAnchor, moving: SnapAnchor) =>
  (fixed === "min" && moving === "max") || (fixed === "max" && moving === "min");
const isOutside = (a: SpacingAxis) => isOutsidePair(a.fixedAnchor, a.movingAnchor);
const presetIndex = (a: SpacingAxis) =>
  PRESETS.findIndex(([f, m]) => f === a.fixedAnchor && m === a.movingAnchor);
const faceName = (axis: number, anchor: SnapAnchor) =>
  anchor === "min" ? AXES[axis].low : anchor === "max" ? AXES[axis].high : "Centre";
const describe = (axis: number, a: SpacingAxis) => {
  const p = presetIndex(a);
  return p >= 0
    ? AXES[axis].summaries[p]
    : `${faceName(axis, a.movingAnchor)} on ${faceName(axis, a.fixedAnchor)}`;
};
const fmt = (n: number) => String(+n.toFixed(2));

/** Two boxes on one axis: grey = fixed object, teal = moving object, dashed = the fixed face. */
function AxisIcon({ axis, fixed, moving }: { axis: number; fixed: SnapAnchor; moving: SnapAnchor }) {
  const F0 = 12, F1 = 32, W = 12;
  const pf = F0 + (F1 - F0) * anchorPos[fixed];
  const m0 = pf - W * anchorPos[moving];
  if (axis === 0) {
    return (
      <svg className="sp-ic" viewBox="0 0 44 28" aria-hidden="true">
        <line className="gd" x1={pf} x2={pf} y1={1} y2={27} />
        <rect className="fx" x={F0} y={3} width={F1 - F0} height={8} rx={1.6} />
        <rect className="mv" x={m0} y={17} width={W} height={8} rx={1.6} />
      </svg>
    );
  }
  const k = 0.6;
  const y = (p: number) => 27 - k * p;
  return (
    <svg className="sp-ic" viewBox="0 0 44 28" aria-hidden="true">
      <line className="gd" x1={2} x2={42} y1={y(pf)} y2={y(pf)} />
      <rect className="fx" x={6} y={y(F1)} width={14} height={(F1 - F0) * k} rx={1.6} />
      <rect className="mv" x={24} y={y(m0 + W)} width={14} height={W * k} rx={1.6} />
    </svg>
  );
}

function Glyph({ kind }: { kind: "swap" | "gap" | "check" }) {
  const d =
    kind === "swap"
      ? "M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4"
      : kind === "gap"
        ? "M3 4v16M21 4v16M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3"
        : "m5 12 4 4L19 6";
  return (
    <svg className="sp-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Switch({
  checked,
  onChange,
  label,
  text,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  text?: string;
}) {
  return (
    <label className="sp-switch">
      {text && <span>{text}</span>}
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

const axisClass = (i: number) => `sp-ax-${i}`;

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
  const [showFaces, setShowFaces] = useState(false);
  // Axes where "Custom…" was picked, so the face pickers stay open without changing the faces.
  const [customFaces, setCustomFaces] = useState([false, false, false]);
  // Gap to reuse when a recipe puts an axis "outside" while no axis currently has one.
  const [carryGap, setCarryGap] = useState(0);

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
  const setCustom = (index: number, on: boolean) =>
    setCustomFaces((c) => c.map((v, i) => (i === index ? on : v)));
  const parseGap = (raw: string) => (raw === "" ? 0 : Math.max(0, Number(raw)));

  // One gap for the whole arrangement: it lives on every axis where the objects sit side by side.
  const outsideAxes = settings.axes.filter((a) => a.enabled && isOutside(a));
  const sharedGap = outsideAxes.length ? outsideAxes[0].gap : carryGap;
  const setSharedGap = (gap: number) => {
    setCarryGap(gap);
    setSettings((s) => ({ ...s, axes: s.axes.map((a) => (isOutside(a) ? { ...a, gap } : a)) }));
  };

  const applyRecipe = (recipe: (typeof RECIPES)[number]) => {
    setSettings((s) => ({
      ...s,
      axes: s.axes.map((_, i) => {
        const [fixedAnchor, movingAnchor] = recipe.axes[i];
        return { enabled: true, fixedAnchor, movingAnchor, gap: isOutsidePair(fixedAnchor, movingAnchor) ? sharedGap : 0 };
      }),
    }));
    setCustomFaces([false, false, false]);
  };
  const activeRecipe = RECIPES.findIndex((r) =>
    r.axes.every(([f, m], i) => settings.axes[i].enabled && settings.axes[i].fixedAnchor === f && settings.axes[i].movingAnchor === m),
  );

  const faces = (i: number, axis: SpacingAxis) => (
    <div className={`sp-tr-faces ${axisClass(i)}`}>
      <div className="sp-faces">
        {(["fixedAnchor", "movingAnchor"] as const).map((which) => (
          <div key={which}>
            <small>{which === "fixedAnchor" ? "Fixed face" : "Moving face"}</small>
            <div className="sp-seg">
              {anchors.map((anchor) => (
                <button
                  key={anchor}
                  type="button"
                  aria-pressed={axis[which] === anchor}
                  onClick={() => change(i, { [which]: anchor })}
                >
                  {faceName(i, anchor)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="sp">
      <div className="sp-objs">
        <div className="sp-objs-lines">
          <span className="sp-objs-key"><i className="sp-dot fixed" />Stays fixed</span>
          <strong title={fixedName}>{fixedName}</strong>
          <span className="sp-objs-key"><i className="sp-dot moving" />Moves</span>
          <strong title={movingName}>{movingName}</strong>
        </div>
        <button type="button" className="sp-swap" onClick={onSwap} aria-label="Swap fixed and moving objects" title="Swap fixed and moving objects">
          <Glyph kind="swap" />
        </button>
      </div>

      <div className="sp-sub">What do you want to do?</div>
      <div className="sp-recipes">
        {RECIPES.map((recipe, q) => (
          <button
            key={recipe.name}
            type="button"
            className={`sp-tile${activeRecipe === q ? " act" : ""}`}
            aria-pressed={activeRecipe === q}
            onClick={() => applyRecipe(recipe)}
          >
            <AxisIcon axis={recipe.icon[0]} fixed={recipe.icon[1]} moving={recipe.icon[2]} />
            <em>{recipe.name}</em>
          </button>
        ))}
      </div>

      <div className="sp-gaprow">
        <label htmlFor="spacing-shared-gap">
          {outsideAxes.length ? "Gap between objects" : "Gap"}
          <small>{outsideAxes.length ? "Applies where the objects sit side by side" : "Faces are aligned, so no gap is needed"}</small>
        </label>
        <span className={`sp-field${outsideAxes.length ? "" : " off"}`} style={{ width: 88, flex: "none" }}>
          <input
            id="spacing-shared-gap"
            aria-label="Gap between objects in millimetres"
            type="number"
            min="0"
            step="0.5"
            disabled={!outsideAxes.length}
            value={Number.isFinite(sharedGap) ? sharedGap : 0}
            onChange={(e) => setSharedGap(parseGap(e.target.value))}
          />
          <em>mm</em>
        </span>
      </div>

      <div className="sp-chips" aria-live="polite">
        {settings.axes.map((a, i) => (
          <span key={i} className={`sp-chip ${axisClass(i)}${a.enabled ? "" : " off"}`}>
            <b className="sp-badge">{AXES[i].key}</b>
            {a.enabled ? `${describe(i, a)}${a.gap ? ` · ${fmt(a.gap)} mm` : ""}` : "unchanged"}
          </span>
        ))}
      </div>
      {!enabled && <p className="hint">Turn on an axis to adjust its spacing.</p>}

      <hr className="sp-rule" />
      <div className="sp-sub">Fine-tune each axis</div>

      <div className="sp-table">
        <div className="sp-th">
          <span>Axis</span>
          <span />
          <span>Moving object</span>
          <span style={{ textAlign: "right", paddingRight: 4 }}>Gap</span>
        </div>
        {settings.axes.map((axis, i) => {
          const info = AXES[i];
          const idx = presetIndex(axis);
          const custom = customFaces[i] || idx < 0;
          return (
            <Fragment key={i}>
              <div className={`sp-tr ${axisClass(i)}${axis.enabled ? "" : " off"}`}>
                <label className="sp-ck">
                  <input
                    type="checkbox"
                    aria-label={`Enable ${info.key} axis`}
                    checked={axis.enabled}
                    onChange={(e) => change(i, { enabled: e.target.checked })}
                  />
                  <b className="sp-badge">{info.key}</b>
                </label>
                <span className="sp-tr-ic">
                  <AxisIcon axis={i} fixed={axis.fixedAnchor} moving={axis.movingAnchor} />
                </span>
                <select
                  aria-label={`${info.name} placement`}
                  disabled={!axis.enabled}
                  value={custom ? "custom" : String(idx)}
                  onChange={(e) => {
                    if (e.target.value === "custom") return setCustom(i, true);
                    const [fixedAnchor, movingAnchor] = PRESETS[Number(e.target.value)];
                    setCustom(i, false);
                    change(i, { fixedAnchor, movingAnchor });
                  }}
                >
                  {info.captions.map((caption, q) => (
                    <option key={caption} value={q}>{caption}</option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
                <span className="sp-field">
                  <input
                    id={`spacing-distance-${i}`}
                    aria-label={`${info.key} distance in millimetres`}
                    type="number"
                    min="0"
                    step="0.5"
                    disabled={!axis.enabled}
                    value={Number.isFinite(axis.gap) ? axis.gap : 0}
                    onChange={(e) => change(i, { gap: parseGap(e.target.value) })}
                  />
                  <em>mm</em>
                </span>
              </div>
              {axis.enabled && (showFaces || custom) && faces(i, axis)}
            </Fragment>
          );
        })}
      </div>
      <div className="sp-optrow">
        <span>Show face pickers</span>
        <Switch checked={showFaces} onChange={setShowFaces} label="Show face pickers for every axis" />
      </div>

      {invalid && <p role="alert" className="hint">Enter a distance of zero or more.</p>}

      <div className="sp-foot">
        <div className="sp-actions">
          <Switch checked={preview} onChange={setPreview} label="Preview spacing" text="Preview" />
          <button
            type="button"
            className="sp-ghost"
            disabled={!enabled}
            onClick={() => {
              setSettings((s) => ({
                ...s,
                axes: s.axes.map((a) => (a.enabled ? { ...a, gap: 0 } : a)),
              }));
              setCarryGap(0);
              setPreview(true);
            }}
          >
            <Glyph kind="gap" />
            Snap flush (0)
          </button>
        </div>
        <button className="primary sp-apply" disabled={!enabled || invalid} onClick={() => onApply(settings)}>
          <Glyph kind="check" />
          Apply spacing
        </button>
      </div>
    </div>
  );
}
