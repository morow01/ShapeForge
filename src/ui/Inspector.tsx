import { Fragment } from "react";
import { BOOLEAN_OPS, PRIMITIVES, isGroup, visibleFields } from "../document/types";
import { beginHistoryBatch, endHistoryBatch } from "../document/store";
import { TRI_BY_ANGLES, TRI_BY_SIDE_ANGLE, TRI_BY_SIDES, solveTriangle } from "../geometry/triangle";
import type { TriangleSolution } from "../geometry/triangle";
import type { BooleanOp, ParamField, PrimitiveKind, SceneNode, Vec3 } from "../document/types";

interface Props {
  node: SceneNode;
  error: string | null;
  onParam: (key: string, value: number) => void;
  onTransform: (patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
  resizeConstrained: boolean;
  onResizeConstrained: (value: boolean) => void;
  onHole: (isHole: boolean) => void;
  onOp: (op: BooleanOp) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

const AXES = ["X", "Y", "Z"] as const;

export function Inspector({
  node,
  error,
  onParam,
  onTransform,
  resizeConstrained,
  onResizeConstrained,
  onHole,
  onOp,
  onRename,
  onDelete,
}: Props) {
  const group = isGroup(node);

  const setAxis = (which: "position" | "rotation", i: number, value: number) => {
    const next = [...node[which]] as Vec3;
    next[i] = value;
    onTransform({ [which]: next });
  };

  return (
    <div className="inspector">
      <input
        className="name"
        value={node.name}
        onFocus={beginHistoryBatch}
        onBlur={endHistoryBatch}
        onChange={(e) => onRename(e.target.value)}
        aria-label="Object name"
      />

      <label className="check">
        <input type="checkbox" checked={node.isHole} onChange={(e) => onHole(e.target.checked)} />
        <span>Hole (subtracts from siblings)</span>
      </label>

      {error && <p className="invalid">{error}</p>}

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
      ) : (
        <ObjectParams node={node} onParam={onParam} onTransform={onTransform} />
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
                  ? [value, value, value] as Vec3
                  : node.scale.map((v, at) => at === i ? value : v) as Vec3;
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

      <button className="danger" onClick={onDelete}>
        Delete
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
  onParam,
  onTransform,
}: {
  node: Extract<SceneNode, { type: "object" }>;
  onParam: (key: string, value: number) => void;
  onTransform: (patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
}) {
  const def = PRIMITIVES[node.kind];
  const fields = visibleFields(def, node.params).filter((f) => f.key !== "mode");
  const axesByKey = DIM_AXES[node.kind] ?? {};

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
        const base = node.params[f.key] ?? 0;
        const axes = axesByKey[f.key];
        // Only trust a shared-axis field (a radius spanning X and Y, say)
        // while those axes still agree — once resized apart there is no
        // single number left that describes it, so it drops back to raw.
        const uniform = !!axes && axes.every((a) => Math.abs(node.scale[a] - node.scale[axes[0]]) < 1e-9);
        if (!axes || !uniform || base <= 0) {
          return <Field key={f.key} field={f} value={base} onChange={(v) => onParam(f.key, v)} />;
        }
        const factor = node.scale[axes[0]];
        return (
          <Field
            key={f.key}
            field={{ ...f, min: f.min * factor, max: f.max * factor, step: Math.max(0.01, f.step * factor) }}
            value={round(base * factor)}
            onChange={(v) => {
              if (!Number.isFinite(v) || v <= 0) return;
              const scale = [...node.scale] as Vec3;
              for (const a of axes) scale[a] = Math.max(0.0001, v / base);
              onTransform({ scale });
            }}
          />
        );
      })}
      {node.kind === "triangle" && <TriangleReadout params={node.params} />}
    </>
  );
}

/**
 * Shows whichever representation the current mode does not let you type
 * directly. For a gusset you usually need to read off the value you did not enter.
 */
function TriangleReadout({ params }: { params: Record<string, number> }) {
  let solved: TriangleSolution;
  try {
    solved = solveTriangle(params);
  } catch {
    return null; // the invalid-shape banner already explains why
  }

  const deg = (n: number) => `${fmt(n)}°`;
  const mm = (n: number) => `${fmt(n)} mm`;

  let rows: [string, string][];
  if (params.mode === TRI_BY_ANGLES) {
    rows = [
      ["Left side", mm(solved.sides.left)],
      ["Right side", mm(solved.sides.right)],
    ];
  } else if (params.mode === TRI_BY_SIDE_ANGLE) {
    rows = [
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
}: {
  field: ParamField;
  value: number;
  onChange: (v: number) => void;
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
    <label className="field">
      <span className="field-label">
        {field.label}
        {field.suffix ? ` (${field.suffix})` : ""}
      </span>
      <div className="field-row">
        {/* A slider sweep and a typing session are each one undo step, not one
            per pixel or per keystroke. */}
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
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
          onFocus={beginHistoryBatch}
          onBlur={endHistoryBatch}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </label>
  );
}

/** Gizmo drags produce long floats; keep the number inputs readable. */
const round = (n: number) => Math.round(n * 100) / 100;
