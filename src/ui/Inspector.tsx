import { Fragment, useEffect, useRef, useState } from "react";
import { TransparencyIcon } from "./icons";
import {
  BOOLEAN_OPS,
  PRIMITIVES,
  TINKERCAD_COLORS,
  isGroup,
  visibleFields,
} from "../document/types";
import { beginHistoryBatch, endHistoryBatch } from "../document/store";
import { resolveNodeColor, resolveNodeTransparent } from "../document/tree";
import {
  TRI_BY_ANGLES,
  TRI_BY_SIDE_ANGLE,
  TRI_BY_SIDES,
  solveScaledTriangle,
} from "../geometry/triangle";
import type { TriangleSolution } from "../geometry/triangle";
import type { BooleanOp, ParamField, PrimitiveKind, SceneNode, Vec3 } from "../document/types";

interface Props {
  node: SceneNode;
  selectedCount?: number;
  error: string | null;
  onParam: (key: string, value: number) => void;
  onTransform: (patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
  resizeConstrained: boolean;
  onResizeConstrained: (value: boolean) => void;
  onHole: (isHole: boolean) => void;
  onColor: (color: string) => void;
  onTransparent: (transparent: boolean) => void;
  onOp: (op: BooleanOp) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Edit nodes only: permanently drops whichever push/pull op(s) can no
   *  longer find their target face, instead of leaving them to keep
   *  re-failing (and re-showing `error`) on every future rebuild. */
  onPruneDeadOps: () => void;
}

const AXES = ["X", "Y", "Z"] as const;

function isLightColor(hex: string): boolean {
  const c = hex.replace("#", "");
  if (c.length !== 6) return false;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150;
}

export function Inspector({
  node,
  selectedCount = 1,
  error,
  onParam,
  onTransform,
  resizeConstrained,
  onResizeConstrained,
  onHole,
  onColor,
  onTransparent,
  onOp,
  onRename,
  onDelete,
  onPruneDeadOps,
}: Props) {
  const isMulti = selectedCount > 1;
  const group = isGroup(node);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const activeColor = resolveNodeColor(node);
  const isTransparent = resolveNodeTransparent(node);
  const [localHex, setLocalHex] = useState(activeColor.toUpperCase());

  useEffect(() => {
    setLocalHex(activeColor.toUpperCase());
  }, [activeColor]);

  useEffect(() => {
    if (!colorPickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDocClick);
    return () => window.removeEventListener("pointerdown", onDocClick);
  }, [colorPickerOpen]);

  useEffect(() => {
    if (node.isHole) setColorPickerOpen(false);
  }, [node.isHole]);

  const setAxis = (which: "position" | "rotation", i: number, value: number) => {
    const next = [...node[which]] as Vec3;
    next[i] = value;
    onTransform({ [which]: next });
  };

  return (
    <div className="inspector">
      {isMulti ? (
        <div className="multi-selection-badge">
          <span>Shapes ({selectedCount})</span>
        </div>
      ) : (
        <input
          className="name"
          value={node.name}
          onFocus={beginHistoryBatch}
          onBlur={endHistoryBatch}
          onChange={(e) => onRename(e.target.value)}
          aria-label="Object name"
        />
      )}

      <div className="shape-type-container">
        <div className="shape-type-toggle">
          <button
            type="button"
            className={`shape-type-btn ${!node.isHole ? "active" : ""}`}
            onClick={() => {
              if (node.isHole) {
                onHole(false);
                setColorPickerOpen(true);
              } else {
                setColorPickerOpen((v) => !v);
              }
            }}
            title="Solid object — click to choose color"
          >
            <span
              className="color-swatch-circle"
              style={{
                backgroundColor: activeColor,
                opacity: isTransparent ? 0.6 : 1,
              }}
            />
            <span className="shape-type-label">Solid</span>
            <span className="dropdown-caret">▾</span>
          </button>

          <button
            type="button"
            className={`shape-type-btn ${node.isHole ? "active" : ""}`}
            onClick={() => {
              onHole(true);
              setColorPickerOpen(false);
            }}
            title="Hole (subtracts from siblings)"
          >
            <span className="hole-swatch-circle" />
            <span className="shape-type-label">Hole</span>
          </button>
        </div>

        {colorPickerOpen && !node.isHole && (
          <div className="tinkercad-color-popover" ref={popoverRef}>
            <div className="color-popover-header">
              <span className="popover-title">Preset colors</span>
              <label
                className={`transparent-toggle ${isTransparent ? "on" : ""}`}
                title="Toggle translucency (Shortcut: T)"
              >
                <input
                  type="checkbox"
                  checked={isTransparent}
                  onChange={(e) => onTransparent(e.target.checked)}
                />
                <TransparencyIcon className="toggle-icon" />
                <span>Transparent (T)</span>
              </label>
            </div>

            <div className="color-palette-grid">
              {TINKERCAD_COLORS.map((c) => {
                const isSelected = activeColor.toLowerCase() === c.hex.toLowerCase();
                return (
                  <button
                    key={c.hex}
                    type="button"
                    className={`color-swatch-btn ${isSelected ? "selected" : ""}`}
                    style={{ backgroundColor: c.hex }}
                    onClick={() => {
                      onColor(c.hex);
                    }}
                    title={c.name}
                  >
                    {isSelected && (
                      <span
                        className="swatch-check"
                        style={{
                          color: isLightColor(c.hex) ? "#222" : "#fff",
                        }}
                      >
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="custom-color-bar">
              <label className="custom-color-btn" title="Pick any custom hex color">
                <input
                  type="color"
                  className="native-color-picker"
                  value={activeColor}
                  onChange={(e) => onColor(e.target.value)}
                />
                <span className="custom-color-swatch" style={{ backgroundColor: activeColor }} />
                <span>Custom…</span>
              </label>
              <input
                type="text"
                className="hex-input"
                value={localHex}
                maxLength={7}
                onFocus={beginHistoryBatch}
                onBlur={() => {
                  endHistoryBatch();
                  setLocalHex(activeColor.toUpperCase());
                }}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalHex(val);
                  const formatted = val.startsWith("#") ? val : `#${val}`;
                  if (/^#[0-9a-fA-F]{6}$/.test(formatted)) {
                    onColor(formatted);
                  }
                }}
                title="Hex color code"
              />
            </div>
          </div>
        )}
      </div>

      {error && <p className="invalid">{error}</p>}

      {!isMulti && (
        <>
          {group ? (
            <>
              <h2>Combine children by</h2>
              <select className="num" value={node.op} onChange={(e) => onOp(e.target.value as BooleanOp)}>
                {BOOLEAN_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="hint op-hint">
                {BOOLEAN_OPS.find((o) => o.value === node.op)?.hint}
              </p>
              <p className="hint">
                {node.children.length} {node.children.length === 1 ? "child" : "children"}
              </p>
            </>
          ) : node.type === "import" ? (
            <ImportInfo node={node} />
          ) : node.type === "edit" ? (
            <EditInfo node={node} error={error} onPruneDeadOps={onPruneDeadOps} />
          ) : (
            <ObjectParams
              node={node}
              resizeConstrained={resizeConstrained}
              onParam={onParam}
              onTransform={onTransform}
            />
          )}
        </>
      )}

      <h2>Size</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={resizeConstrained}
          onChange={(e) => onResizeConstrained(e.target.checked)}
        />
        <span>Lock proportions</span>
      </label>
      {!isMulti && (
        <>
          <div className="triple">
            {AXES.map((axis, i) => (
              <label key={axis}>
                <span className="field-label">{axis} %</span>
                <input
                  className="num"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={round(node.scale[i] * 100)}
                  onFocus={beginHistoryBatch}
                  onBlur={endHistoryBatch}
                  onChange={(e) => {
                    const value = Math.max(0.01, Number(e.target.value) / 100);
                    const scale = resizeConstrained
                      ? ([value, value, value] as Vec3)
                      : (node.scale.map((v, at) => (at === i ? value : v)) as Vec3);
                    onTransform({ scale });
                  }}
                />
              </label>
            ))}
          </div>
          <p className="hint">
            {resizeConstrained
              ? "Corner and size edits preserve proportions."
              : "White corners resize width/depth freely; teal middle handles change one axis."}
          </p>

          <h2>Position (mm)</h2>
          <div className="triple">
            {AXES.map((axis, i) => (
              <label key={axis}>
                <span className="field-label">{axis}</span>
                <input
                  className="num"
                  type="number"
                  step={1}
                  value={round(node.position[i])}
                  onFocus={beginHistoryBatch}
                  onBlur={endHistoryBatch}
                  onChange={(e) => setAxis("position", i, Number(e.target.value))}
                />
              </label>
            ))}
          </div>

          <h2>Rotation (deg)</h2>
          <div className="triple">
            {AXES.map((axis, i) => (
              <label key={axis}>
                <span className="field-label">{axis}</span>
                <input
                  className="num"
                  type="number"
                  step={15}
                  value={round(node.rotation[i])}
                  onFocus={beginHistoryBatch}
                  onBlur={endHistoryBatch}
                  onChange={(e) => setAxis("rotation", i, Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        </>
      )}

      <button className="danger" onClick={onDelete}>
        {isMulti ? `Delete ${selectedCount} shapes` : "Delete"}
      </button>
    </div>
  );
}

function ImportInfo({ node }: { node: Extract<SceneNode, { type: "import" }> }) {
  return (
    <>
      <h2>Imported file</h2>
      <dl className="readout">
        <dt>File</dt>
        <dd>{node.fileName}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(node.byteSize)}</dd>
      </dl>
      <p className="hint">Original geometry is preserved; use Scale to resize it proportionally.</p>
    </>
  );
}

function EditInfo({
  node,
  error,
  onPruneDeadOps,
}: {
  node: Extract<SceneNode, { type: "edit" }>;
  error: string | null;
  onPruneDeadOps: () => void;
}) {
  const baseLabel = isGroup(node.base) ? "Combined shape" : PRIMITIVES[node.base.kind].label;
  return (
    <>
      <h2>Edited shape</h2>
      <dl className="readout">
        <dt>Built from</dt>
        <dd>{baseLabel}</dd>
        <dt>Push/pull edits</dt>
        <dd>{node.ops.length}</dd>
      </dl>
      <p className="hint">
        No longer defined by width/height/radius — like an imported file, use Scale to resize it as
        a whole.
      </p>
      {error && (
        <>
          <button className="danger" onClick={onPruneDeadOps}>
            Remove broken edit
          </button>
          <p className="hint">
            One of this shape's push/pull edits can no longer find the face it targeted — usually
            from an earlier edit that reshaped it away. This drops just that one edit for good; the
            rest stay exactly as they are.
          </p>
        </>
      )}
    </>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Which scale axis (or axes) each dimension field draws its size along, in
 * world space — see makePrimitive() in kernel/shape.ts for the geometry this
 * mirrors. A field absent here (fillet, angles, triangle side lengths that
 * aren't axis-aligned) always reads/writes its raw base parameter, unchanged.
 *
 * Fields naming more than one axis (a radius shared by X and Y, or a
 * sphere's radius shared by all three) can only be shown/edited as a single
 * resolved size while those axes still match — once a shape has been
 * distorted non-uniformly along them, there is no one number that describes
 * it, so the field falls back to its raw base value.
 */
const DIM_AXES: Partial<Record<PrimitiveKind, Record<string, number[]>>> = {
  box: { width: [0], depth: [1], height: [2] },
  cylinder: { radius: [0, 1], height: [2] },
  sphere: { radius: [0, 1, 2] },
  cone: { bottomRadius: [0, 1], topRadius: [0, 1], height: [2] },
  triangle: { thickness: [2] },
};

function ObjectParams({
  node,
  resizeConstrained = false,
  onParam,
  onTransform,
}: {
  node: Extract<SceneNode, { type: "object" }>;
  resizeConstrained?: boolean;
  onParam: (key: string, value: number) => void;
  onTransform: (patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
}) {
  const def = PRIMITIVES[node.kind];
  const fields = visibleFields(def, node.params).filter((f) => f.key !== "mode");
  const axesByKey = DIM_AXES[node.kind] ?? {};

  let solvedTriangle: TriangleSolution | null = null;
  if (node.kind === "triangle") {
    try {
      solvedTriangle = solveScaledTriangle(node.params, node.scale);
    } catch {
      solvedTriangle = null;
    }
  }

  return (
    <>
      {node.kind === "triangle" && (
        <>
          <h2>Triangle definition</h2>
          <div className="triangle-mode" role="group" aria-label="Triangle definition method">
            {[
              [TRI_BY_SIDES, "3 sides"],
              [TRI_BY_SIDE_ANGLE, "2 sides + angle"],
              [TRI_BY_ANGLES, "Corner angles"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={node.params.mode === value ? "on" : ""}
                onClick={() => onParam("mode", value as number)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="hint triangle-hint">
            {node.params.mode === TRI_BY_SIDES
              ? "Set all three side lengths."
              : node.params.mode === TRI_BY_SIDE_ANGLE
                ? "Set the base, left side, and the angle between them."
                : "Set the base and corner angles; the total stays at 180°."}
          </p>
        </>
      )}
      <h2>Dimensions</h2>
      {fields.map((f) => {
        let base = node.params[f.key] ?? 0;
        if (solvedTriangle) {
          if (f.key === "base") base = solvedTriangle.sides.base;
          else if (f.key === "sideLeft") base = solvedTriangle.sides.left;
          else if (f.key === "sideRight") base = solvedTriangle.sides.right;
          else if (f.key === "angleLeft") base = solvedTriangle.angles.left;
          else if (f.key === "angleRight") base = solvedTriangle.angles.right;
          else if (f.key === "angleApex") base = solvedTriangle.angles.apex;
        }

        const isAngleField =
          node.kind === "triangle" &&
          (f.key === "angleLeft" || f.key === "angleRight" || f.key === "angleApex");
        let lockKey: string | null = null;
        let dotColorClass: string | undefined;
        if (isAngleField) {
          if (f.key === "angleLeft") {
            lockKey = "lockAngleLeft";
            dotColorClass = "dot-0";
          } else if (f.key === "angleRight") {
            lockKey = "lockAngleRight";
            dotColorClass = "dot-1";
          } else if (f.key === "angleApex") {
            lockKey = "lockAngleApex";
            dotColorClass = "dot-2";
          }
        }

        const isLocked = lockKey ? !!node.params[lockKey] : false;
        const lockedCount =
          node.kind === "triangle"
            ? (node.params.lockAngleLeft ? 1 : 0) +
              (node.params.lockAngleRight ? 1 : 0) +
              (node.params.lockAngleApex ? 1 : 0)
            : 0;
        const lockDisabled = isAngleField && !isLocked && lockedCount >= 2;
        const isConstrained3rdAngle = isAngleField && !isLocked && lockedCount === 2;

        const onToggleLock = lockKey
          ? () => onParam(lockKey!, isLocked ? 0 : 1)
          : undefined;

        const axes = axesByKey[f.key];
        const uniform = !!axes && axes.every((a) => Math.abs(node.scale[a] - node.scale[axes[0]]) < 1e-9);
        if (!axes || !uniform || base <= 0) {
          return (
            <Field
              key={f.key}
              field={f}
              value={base}
              lockable={isAngleField}
              locked={isLocked}
              onToggleLock={onToggleLock}
              lockDisabled={lockDisabled}
              disabled={isConstrained3rdAngle}
              dotColorClass={dotColorClass}
              onChange={(v) => onParam(f.key, v)}
            />
          );
        }
        const factor = node.scale[axes[0]];
        const currentVal = round(base * factor);
        const maxVal = Math.max(f.max, Math.ceil(currentVal / 50) * 50);
        return (
          <Field
            key={f.key}
            field={{
              ...f,
              min: f.min,
              max: maxVal,
              step: f.step,
            }}
            value={currentVal}
            lockable={isAngleField}
            locked={isLocked}
            onToggleLock={onToggleLock}
            lockDisabled={lockDisabled}
            disabled={isConstrained3rdAngle}
            dotColorClass={dotColorClass}
            onChange={(v) => {
              if (!Number.isFinite(v) || v <= 0) return;
              const nextFactor = Math.max(0.0001, v / base);
              const isLockedTriangle =
                node.kind === "triangle" &&
                !!(node.params.lockAngleLeft || node.params.lockAngleRight || node.params.lockAngleApex);
              const scale = (resizeConstrained || (isLockedTriangle && f.key === "base"))
                ? (isLockedTriangle && !resizeConstrained
                    ? ([nextFactor, nextFactor, node.scale[2]] as Vec3)
                    : ([nextFactor, nextFactor, nextFactor] as Vec3))
                : (node.scale.map((val, at) => (axes.includes(at) ? nextFactor : val)) as Vec3);
              onTransform({ scale });
            }}
          />
        );
      })}
      {node.kind === "triangle" && (
        <TriangleReadout params={node.params} scale={node.scale} />
      )}
    </>
  );
}

/**
 * Shows whichever representation the current mode does not let you type
 * directly. For a gusset you usually need to read off the value you did not enter.
 */
function TriangleReadout({
  params,
  scale = [1, 1, 1],
}: {
  params: Record<string, number>;
  scale?: Vec3;
}) {
  let solved: TriangleSolution;
  try {
    solved = solveScaledTriangle(params, scale);
  } catch {
    return null; // the invalid-shape banner already explains why
  }

  const deg = (n: number) => `${fmt(n)}°`;
  const mm = (n: number) => `${fmt(n)} mm`;

  const isScaled =
    Math.abs((scale[0] ?? 1) - 1) > 1e-4 || Math.abs((scale[1] ?? 1) - 1) > 1e-4;

  let rows: [string, string][];
  if (params.mode === TRI_BY_ANGLES) {
    rows = isScaled
      ? [
          ["Left corner", deg(solved.angles.left)],
          ["Right corner", deg(solved.angles.right)],
          ["Apex corner", deg(solved.angles.apex)],
          ["Left side", mm(solved.sides.left)],
          ["Right side", mm(solved.sides.right)],
        ]
      : [
          ["Left side", mm(solved.sides.left)],
          ["Right side", mm(solved.sides.right)],
          ["Apex corner", deg(solved.angles.apex)],
        ];
  } else if (params.mode === TRI_BY_SIDE_ANGLE) {
    rows = isScaled
      ? [
          ["Left corner", deg(solved.angles.left)],
          ["Right corner", deg(solved.angles.right)],
          ["Apex corner", deg(solved.angles.apex)],
          ["Left side", mm(solved.sides.left)],
          ["Right side", mm(solved.sides.right)],
        ]
      : [
          ["Right side", mm(solved.sides.right)],
          ["Right corner", deg(solved.angles.right)],
          ["Apex corner", deg(solved.angles.apex)],
        ];
  } else {
    rows = [
      ["Left corner", deg(solved.angles.left)],
      ["Right corner", deg(solved.angles.right)],
      ["Apex corner", deg(solved.angles.apex)],
    ];
  }

  return (
    <>
      <h2>Derived</h2>
      <dl className="readout">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
        <dt>Area</dt>
        <dd>{fmt(solved.area)} mm²</dd>
      </dl>
    </>
  );
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

function Field({
  field,
  value,
  onChange,
  lockable,
  locked,
  onToggleLock,
  lockDisabled,
  disabled,
  dotColorClass,
}: {
  field: ParamField;
  value: number;
  onChange: (v: number) => void;
  lockable?: boolean;
  locked?: boolean;
  onToggleLock?: () => void;
  lockDisabled?: boolean;
  disabled?: boolean;
  dotColorClass?: string;
}) {
  if (field.options) {
    return (
      <label className="field">
        <span className="field-label">{field.label}</span>
        <select className="num" value={value} onChange={(e) => onChange(Number(e.target.value))}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="field">
      <div className="field-header">
        <span className="field-label">
          {dotColorClass && <span className={`corner-dot ${dotColorClass}`}></span>}
          {field.label}
          {field.suffix ? ` (${field.suffix})` : ""}
        </span>
        {lockable && (
          <button
            type="button"
            className={`lock-icon-btn ${locked ? "locked" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              onToggleLock?.();
            }}
            disabled={!locked && lockDisabled}
            title={
              locked
                ? "Angle is locked. Click to unlock."
                : lockDisabled
                  ? "At most 2 corners can be locked at the same time."
                  : "Lock this angle"
            }
          >
            {locked ? "🔒" : "🔓"}
          </button>
        )}
      </div>
      <div className="field-row">
        {/* A slider sweep and a typing session are each one undo step, not one
            per pixel or per keystroke. */}
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          disabled={disabled}
          title={disabled ? "Constrained by the other 2 locked angles (sum is 180°)" : undefined}
          onPointerDown={beginHistoryBatch}
          onPointerUp={endHistoryBatch}
          onKeyDown={beginHistoryBatch}
          onKeyUp={endHistoryBatch}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <input
          className="num"
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          disabled={disabled}
          title={disabled ? "Constrained by the other 2 locked angles (sum is 180°)" : undefined}
          onFocus={beginHistoryBatch}
          onBlur={endHistoryBatch}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

/** Gizmo drags produce long floats; keep the number inputs readable. */
const round = (n: number) => Math.round(n * 100) / 100;
