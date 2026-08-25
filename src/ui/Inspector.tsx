import { Fragment } from "react";
import { BOOLEAN_OPS, PRIMITIVES, isGroup, visibleFields } from "../document/types";
import { beginHistoryBatch, endHistoryBatch } from "../document/store";
import { TRI_BY_ANGLES, TRI_BY_SIDE_ANGLE, solveTriangle } from "../geometry/triangle";
import type { TriangleSolution } from "../geometry/triangle";
import type { BooleanOp, ParamField, SceneNode, Vec3 } from "../document/types";

interface Props {
  node: SceneNode;
  error: string | null;
  onParam: (key: string, value: number) => void;
  onTransform: (patch: { position?: Vec3; rotation?: Vec3 }) => void;
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
      ) : (
        <ObjectParams node={node} onParam={onParam} />
      )}

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

function ObjectParams({
  node,
  onParam,
}: {
  node: Extract<SceneNode, { type: "object" }>;
  onParam: (key: string, value: number) => void;
}) {
  const def = PRIMITIVES[node.kind];
  const fields = visibleFields(def, node.params);

  return (
    <>
      <h2>Dimensions</h2>
      {fields.map((f) => (
        <Field
          key={f.key}
          field={f}
          value={node.params[f.key] ?? 0}
          onChange={(v) => onParam(f.key, v)}
        />
      ))}
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
