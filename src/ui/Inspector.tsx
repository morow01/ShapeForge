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
import type { LocalFontData } from "../text/systemFonts";

/**
 * The largest corner radius a box can actually take: half its smallest side.
 *
 * Beyond that the rounds on opposite faces would have to overlap, OCCT
 * refuses the fillet, and the corners come back sharp with no explanation.
 * Rounded down to the field's own step so the end of the slider is a value
 * that works rather than one that fails.
 */
function filletLimit(
  node: { kind?: string; params: Record<string, number>; scale?: Vec3 },
  step: number,
): number {
  const { width, depth, height, filletMode } = node.params;
  // The fillet's own limit has to track what Width/Depth/Height actually
  // DISPLAY, not the raw params underneath — a uniformly-scaled box (see
  // DIM_AXES: width/depth/height each ride their own scale axis) shows the
  // SCALED size in those fields, so a box resized well past its original
  // 20mm still measured its fillet limit off the original, unscaled 20,
  // capping the slider at a fraction of the room the kernel actually has.
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const effWidth = (width ?? 0) * sx;
  const effDepth = (depth ?? 0) * sy;
  const effHeight = (height ?? 0) * sz;
  // Mirrors makePrimitive's own maxR in kernel/shape.ts exactly — height
  // only bounds the radius in "Every edge" mode, which rounds the top and
  // bottom rims too. "Side edges" only rounds the four vertical edges (a
  // rounded rectangle extruded straight up), so a short box does not cap
  // it at all — a box with a small height and a wide footprint still had
  // its slider capped by that height, well under what the kernel would
  // actually build.
  const smallest = (filletMode ?? 0) === 1
    ? Math.min(effWidth, effDepth, effHeight)
    : Math.min(effWidth, effDepth);
  if (!(smallest > 0)) return 0;
  return Math.max(0, Math.floor(smallest / 2 / step) * step);
}

interface Props {
  node: SceneNode;
  /** The selected node's own measured extent (width/depth/height before its
   *  scale is applied), read from its evaluated mesh — a group, an edit, an
   *  import or a build has no size parameter of its own, only this. Null
   *  before the mesh has built, or if it built to nothing; the Size section
   *  falls back to a plain percentage in either case. Unused for a
   *  primitive, which already has a real Dimensions section of its own. */
  localSize: Vec3 | null;
  selectedCount?: number;
  /** Combined WORLD bounding box of a multi-object selection — null below 2
   *  selected, or before any of them have a built mesh. The Size/Position
   *  sections below read Width/Depth/Height and centre position straight
   *  off this rather than off `node`, which for a multi-selection is just
   *  whichever object was selected last and does not speak for the rest. */
  selectionBounds?: { min: Vec3; max: Vec3 } | null;
  /** Multi-select only: scales every selected object about the selection's
   *  own shared box centre so its extent on one axis becomes the typed
   *  value. */
  onResizeSelectionAxis?: (axis: 0 | 1 | 2, mm: number) => void;
  /** Multi-select only: moves the whole selection as one rigid body so its
   *  shared box centre lands on the typed value along one axis. */
  onMoveSelectionAxis?: (axis: 0 | 1 | 2, mm: number) => void;
  error: string | null;
  onParam: (key: string, value: number) => void;
  onTransform: (patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
  resizeConstrained: boolean;
  onResizeConstrained: (value: boolean) => void;
  onHole: (isHole: boolean) => void;
  onColor: (color: string) => void;
  onTransparent: (transparent: boolean) => void;
  /** Imported artwork only: how far the outlines are extruded, in mm. */
  onSvgThickness: (mm: number) => void;
  onOp: (op: BooleanOp) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Edit nodes only: permanently drops whichever push/pull op(s) can no
   *  longer find their target face, instead of leaving them to keep
   *  re-failing (and re-showing `error`) on every future rebuild. */
  onPruneDeadOps: () => void;
  /** Object nodes only: makes an exact in-place copy of the selected node
   *  (same position/rotation/scale) with `params` merged over its own —
   *  the Connector's "Copy as Socket/Plug" button, so the copy always sits
   *  exactly where the original does without the user positioning anything
   *  by hand. */
  onDuplicateWithParams?: (params: Record<string, number>) => void;
  onText?: (text: string) => void;
  onFontName?: (fontName: string) => void;
  fonts?: LocalFontData[] | null;
  onPickFontFile?: () => void;
  onRequestSystemFonts?: () => void;
}

const AXES = ["X", "Y", "Z"] as const;
/** Labels for the millimetre Size fields on a compound shape — the same
 *  words a Box primitive's own Dimensions fields already use for the same
 *  three axes. */
const WDH_LABELS = ["Width", "Depth", "Height"] as const;

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
  localSize,
  selectedCount = 1,
  selectionBounds = null,
  onResizeSelectionAxis,
  onMoveSelectionAxis,
  error,
  onParam,
  onTransform,
  resizeConstrained,
  onResizeConstrained,
  onHole,
  onColor,
  onTransparent,
  onSvgThickness,
  onOp,
  onRename,
  onDelete,
  onPruneDeadOps,
  onDuplicateWithParams,
  onText,
  onFontName,
  fonts,
  onPickFontFile,
  onRequestSystemFonts,
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
      {isMulti ? null : (
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
            <ImportInfo node={node} onSvgThickness={onSvgThickness} />
          ) : node.type === "edit" ? (
            <EditInfo node={node} error={error} onPruneDeadOps={onPruneDeadOps} />
          ) : node.type === "build" ? (
            <BuildInfo node={node} />
          ) : (
            <ObjectParams
              node={node}
              resizeConstrained={resizeConstrained}
              onResizeConstrained={onResizeConstrained}
              onParam={onParam}
              onTransform={onTransform}
              onDuplicateWithParams={onDuplicateWithParams}
              onText={onText}
              onFontName={onFontName}
              fonts={fonts}
              onPickFontFile={onPickFontFile}
              onRequestSystemFonts={onRequestSystemFonts}
            />
          )}
        </>
      )}

      {/* A primitive already has a real Width/Depth/Height in its own
          Dimensions section above — showing it again here as millimetres
          would just be the same number twice. Everything else (a group, an
          edited/combined shape, an import, a Shape Builder result) has no
          parameter to read a size from AT ALL, only this section — which,
          without localSize, could only ever offer a bare percentage of
          nothing in particular. localSize is the compound shape's own
          measured extent (see localMeshBounds in export/stl.ts), in exactly
          the frame a primitive's raw parameter already describes, so it can
          be shown and edited the SAME way: a millimetre field, scale solved
          backwards from what was typed. Falls back to the percentage view
          when there is no mesh yet to measure (still building, or a result
          that evaluated to nothing) — never leaves the section empty. */}
      {(() => {
        const showMm = node.type !== "object" && !!localSize;
        // A primitive already got its own lock toggle next to Dimensions,
        // above — this is the only sizing section anything else (a group,
        // an edit, an import, a Shape Builder result, or a multi-object
        // selection) has, so it needs its own copy there instead.
        const showLockHere = isMulti || node.type !== "object";
        return (
          <>
            <div className="h2-row">
              <h2>{isMulti ? "Size (mm)" : showMm ? "Size (mm)" : "Size"}</h2>
              {showLockHere && (
                <button
                  type="button"
                  className={`lock-icon-btn size-lock ${resizeConstrained ? "locked" : ""}`}
                  onClick={() => onResizeConstrained(!resizeConstrained)}
                  title={resizeConstrained ? "Proportions locked — click to resize each dimension independently" : "Click to lock proportions"}
                >
                  {resizeConstrained ? "🔒" : "🔓"}
                </button>
              )}
            </div>
            {isMulti && selectionBounds && (
              // Same compact 3-column row Position (below) already uses —
              // no slider to give room to here anymore, so there is no
              // reason this needs 3x Position's height. The selection's own
              // combined world box stands in for `localSize`: there is no
              // single node's scale to solve backwards from here, so
              // onResizeSelectionAxis takes the plain millimetre value and
              // does the whole selection's worth of scale/position math
              // itself.
              <div className="triple">
                {WDH_LABELS.map((label, i) => {
                  const currentVal = round(selectionBounds.max[i] - selectionBounds.min[i]);
                  return (
                    <label key={label}>
                      <span className="field-label">{label}</span>
                      <input
                        className="num"
                        type="number"
                        min={0.1}
                        step={0.5}
                        value={currentVal}
                        onFocus={beginHistoryBatch}
                        onBlur={endHistoryBatch}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v) || v <= 0) return;
                          onResizeSelectionAxis?.(i as 0 | 1 | 2, v);
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            )}
            {!isMulti && showMm && localSize && (
              // Same compact 3-column row Position (below) uses — no slider
              // to give room to anymore (see ParamField.noSlider's own doc
              // comment), so this has no more reason to be 3x Position's
              // height than the primitive Dimensions section or the
              // multi-select Size section do.
              <div className="triple">
                {WDH_LABELS.map((label, i) => {
                  const currentVal = round(localSize[i] * node.scale[i]);
                  return (
                    <label key={label}>
                      <span className="field-label">{label}</span>
                      <input
                        className="num"
                        type="number"
                        min={0.1}
                        step={0.5}
                        value={currentVal}
                        onFocus={beginHistoryBatch}
                        onBlur={endHistoryBatch}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v) || v <= 0) return;
                          const nextFactor = Math.max(0.0001, v / localSize[i]);
                          const scale = resizeConstrained
                            ? ([nextFactor, nextFactor, nextFactor] as Vec3)
                            : (node.scale.map((val, at) => (at === i ? nextFactor : val)) as Vec3);
                          onTransform({ scale });
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            )}
            {!isMulti && !showMm && (
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
            )}
          </>
        );
      })()}
      {!isMulti && (
        <>
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
      {isMulti && selectionBounds && (
        // No Rotation section here — a multi-selection has no single
        // rotation to show; each object keeps its own. Position is the
        // selection's shared box centre, editable the same way a single
        // object's is: typing a value moves the WHOLE selection as one
        // rigid body (see Scene.moveSelectionAxis) rather than setting any
        // one object's own position field.
        <>
          <h2>Position (mm)</h2>
          <div className="triple">
            {AXES.map((axis, i) => (
              <label key={axis}>
                <span className="field-label">{axis}</span>
                <input
                  className="num"
                  type="number"
                  step={1}
                  value={round((selectionBounds.min[i] + selectionBounds.max[i]) / 2)}
                  onFocus={beginHistoryBatch}
                  onBlur={endHistoryBatch}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) onMoveSelectionAxis?.(i as 0 | 1 | 2, v);
                  }}
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

function ImportInfo({
  node,
  onSvgThickness,
}: {
  node: Extract<SceneNode, { type: "import" }>;
  onSvgThickness: (mm: number) => void;
}) {
  if (node.svg) {
    const mm = (v: number) => `${v.toFixed(2)} mm`;
    return (
      <>
        <h2>Imported artwork</h2>
        <dl className="readout">
          <dt>File</dt>
          <dd>{node.fileName}</dd>
          <dt>Artboard size</dt>
          <dd>
            {mm(node.svg.width)} × {mm(node.svg.height)}
          </dd>
        </dl>
        <div className="field-row">
          <span className="field-label">Thickness</span>
          <input
            className="num"
            type="number"
            min={0.1}
            step={0.5}
            value={node.svg.thickness}
            onFocus={beginHistoryBatch}
            onBlur={endHistoryBatch}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onSvgThickness(v);
            }}
            aria-label="Extrusion thickness in millimetres"
          />
        </div>
        <p className="hint">
          Imported at the size its artboard reports, so it matches Illustrator
          1:1. Resize with the handles or Scale; thickness is how far it is
          extruded.
        </p>
      </>
    );
  }
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

function BuildInfo({ node }: { node: Extract<SceneNode, { type: "build" }> }) {
  const total = (1 << node.sources.length) - 1;
  return (
    <>
      <h2>Built shape</h2>
      <dl className="readout">
        <dt>Built from</dt>
        <dd>{node.sources.map((s) => s.name).join(", ")}</dd>
        <dt>Regions kept</dt>
        <dd>
          {node.keep.length} of {total}
        </dd>
      </dl>
      <p className="hint">
        The shapes it was built from are frozen inside it, so its dimensions are
        no longer editable — move, rotate and scale still apply.
      </p>
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
  const baseLabel = isGroup(node.base)
    ? "Combined shape"
    : node.base.type === "build"
    ? "Built shape"
    : PRIMITIVES[node.base.kind].label;
  return (
    <>
      <h2>Edited shape</h2>
      <dl className="readout">
        <dt>Built from</dt>
        <dd>{baseLabel}</dd>
        <dt>Geometry edits</dt>
        <dd>{node.ops.length}</dd>
      </dl>
      <p className="hint">
        No longer defined by width/height/radius — like an imported file, use Scale to resize it as
        a whole.
      </p>
      {error && !error.includes("could not be rebuilt reliably") && (
        <>
          <button className="danger" onClick={onPruneDeadOps}>
            Remove broken edit
          </button>
          <p className="hint">
            One or more edits can no longer find their face or edge, or would create invalid
            geometry. This removes only those broken edits; valid fillets, chamfers and push/pulls
            remain in place.
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
  torus: { radius: [0, 1], tubeRadius: [0, 1, 2] },
  pyramid: { radius: [0, 1], height: [2] },
  wedge: { width: [0], length: [1], height: [2] },
  polygonPrism: { radius: [0, 1], height: [2] },
  hemisphere: { radius: [0, 1, 2] },
  capsule: { radius: [0, 1], height: [2] },
  tube: { radius: [0, 1], height: [2] },
  paraboloid: { radius: [0, 1], height: [2] },
  text: { size: [0, 1] },
  connector: { width: [0], length: [1], height: [2], radius: [0, 1] },
  star: { outerRadius: [0, 1], height: [2] },
  tray: { width: [0], depth: [1], height: [2] },
  ellipsoid: { radiusX: [0], radiusY: [1], radiusZ: [2] },
};

function ObjectParams({
  node,
  resizeConstrained = false,
  onResizeConstrained,
  onParam,
  onTransform,
  onDuplicateWithParams,
  onText,
  onFontName,
  fonts,
  onPickFontFile,
  onRequestSystemFonts,
}: {
  node: Extract<SceneNode, { type: "object" }>;
  resizeConstrained?: boolean;
  onResizeConstrained: (value: boolean) => void;
  onParam: (key: string, value: number) => void;
  onTransform: (patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
  onDuplicateWithParams?: (params: Record<string, number>) => void;
  onText?: (text: string) => void;
  onFontName?: (fontName: string) => void;
  fonts?: LocalFontData[] | null;
  onPickFontFile?: () => void;
  onRequestSystemFonts?: () => void;
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
      {node.kind === "text" && (
        <div className="text-inspector-block" style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "8px" }}>
          <h2>Text & Font</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span className="field-label">Text</span>
            <input
              className="name"
              style={{ width: "100%", boxSizing: "border-box" }}
              type="text"
              value={node.text ?? "TEXT"}
              onFocus={beginHistoryBatch}
              onBlur={endHistoryBatch}
              onChange={(e) => onText?.(e.target.value)}
              placeholder="Enter text…"
              aria-label="3D text string"
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span className="field-label">Font</span>
            <select
              className="num"
              style={{ width: "100%", boxSizing: "border-box", textAlign: "left", padding: "6px 8px" }}
              value={node.fontName ?? "Default"}
              onFocus={() => onRequestSystemFonts?.()}
              onClick={() => onRequestSystemFonts?.()}
              onChange={(e) => {
                if (e.target.value === "__pick_file__") {
                  onPickFontFile?.();
                } else {
                  onFontName?.(e.target.value);
                }
              }}
            >
              <option value="Default">Default (Roboto Bold)</option>
              {fonts && fonts.map((f, i) => (
                <option key={`${f.postscriptName}-${i}`} value={f.fullName || f.family}>
                  {f.fullName || f.family}
                </option>
              ))}
              <option value="__pick_file__">+ Load font file (.ttf, .otf)…</option>
            </select>
          </div>
        </div>
      )}
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
      {node.kind === "connector" && onDuplicateWithParams && (
        <div className="connector-pair">
          <button
            type="button"
            className="connector-pair-btn"
            disabled
            title="Paused for now — coming back to this soon"
            onClick={() =>
              onDuplicateWithParams({ fit: node.params.fit === 1 ? 0 : 1 })
            }
          >
            ⧉ Copy as matching {node.params.fit === 1 ? "Plug" : "Socket"}
          </button>
          <p className="hint">
            Paused for now — coming back to this soon. Makes an exact copy at
            this same position and rotation — union the Plug into one part,
            subtract the Socket from the other. Don't reposition either
            copy, or they will no longer line up.
          </p>
        </div>
      )}
      <div className="h2-row">
        <h2>Dimensions</h2>
        <button
          type="button"
          className={`lock-icon-btn size-lock ${resizeConstrained ? "locked" : ""}`}
          onClick={() => onResizeConstrained(!resizeConstrained)}
          title={resizeConstrained ? "Proportions locked — click to resize each dimension independently" : "Click to lock proportions"}
        >
          {resizeConstrained ? "🔒" : "🔓"}
        </button>
      </div>
      {groupDimensionFields(fields.map((f) => {
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
        // A corner radius has to turn through the shape, so it can never
        // exceed half the smallest side; past that OCCT refuses and the
        // corners simply stay sharp. The slider ran to a flat 500 whatever
        // the box was, so nearly all of its travel did nothing — reported as
        // "after about 50 the corners cannot be rounded anymore", which is
        // exactly half of a 100mm side.
        const shown = f.key === "fillet" ? { ...f, max: filletLimit(node, f.step) } : f;
        if (!axes || !uniform || base <= 0) {
          return {
            field: shown,
            el: (
              <Field
                key={f.key}
                field={shown}
                value={base}
                lockable={isAngleField}
                locked={isLocked}
                onToggleLock={onToggleLock}
                lockDisabled={lockDisabled}
                disabled={isConstrained3rdAngle}
                dotColorClass={dotColorClass}
                onChange={(v) => onParam(f.key, Math.min(v, shown.max))}
              />
            ),
          };
        }
        const factor = node.scale[axes[0]];
        const currentVal = round(base * factor);
        const maxVal = Math.max(f.max, Math.ceil(currentVal / 50) * 50);
        return {
          field: f,
          el: (
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
              onChange={(v) => {
                if (!Number.isFinite(v) || v <= 0) return;
                if (node.kind === "triangle" && (node.params.lockAngleLeft || node.params.lockAngleRight || node.params.lockAngleApex)) {
                  const nextFactor = Math.max(0.0001, v / base);
                  const scale = (resizeConstrained || f.key === "base")
                    ? ([nextFactor, nextFactor, resizeConstrained ? nextFactor : node.scale[2]] as Vec3)
                    : (node.scale.map((val, at) => (axes.includes(at) ? nextFactor : val)) as Vec3);
                  onTransform({ scale });
                  return;
                }
                if (resizeConstrained && axesByKey) {
                  const ratio = v / Math.max(0.001, currentVal);
                  for (const k of Object.keys(axesByKey)) {
                    if (k !== f.key && node.params[k] !== undefined) {
                      onParam(k, round(node.params[k] * ratio));
                    }
                  }
                }
                onParam(f.key, v);
                if (node.scale.some((s) => Math.abs(s - 1) > 1e-4)) {
                  onTransform({ scale: [1, 1, 1] });
                }
              }}
            />
          ),
        };
      }))}
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

/**
 * Packs consecutive precise-dimension fields (noSlider — see ParamField's
 * own doc comment) into the same compact 3-column row Position/Rotation
 * already use, instead of each sitting in its own full-width, two-line
 * Field block. A run of one is left alone — a single lone box floating in
 * an otherwise-empty 3-column row reads worse than the plain full-width
 * field it already was (this is why Sphere, with just Radius, is
 * untouched). A slider field (corner radius) or a dropdown breaks the run
 * and renders on its own row exactly as before, since neither one fits
 * the compact layout — corner radius genuinely needs a slider's width, and
 * a dropdown is a different kind of control entirely.
 */
function groupDimensionFields(entries: { field: ParamField; el: React.ReactNode }[]): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  let run: React.ReactNode[] = [];
  const flushRun = () => {
    if (run.length >= 2) rows.push(<div className="triple" key={`dim-row-${rows.length}`}>{run}</div>);
    else if (run.length === 1) rows.push(run[0]);
    run = [];
  };
  for (const { field, el } of entries) {
    if (!field.options && field.noSlider) run.push(el);
    else {
      flushRun();
      rows.push(el);
    }
  }
  flushRun();
  return rows;
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
      <div className={`field-row${field.noSlider ? " no-slider" : ""}`}>
        {/* A slider sweep and a typing session are each one undo step, not one
            per pixel or per keystroke. Skipped entirely for a precise
            structural dimension (width, radius, thickness, …) — see
            ParamField.noSlider's own doc comment for why a drag-to-
            approximate control actively fights typing the exact value a
            print needs, unlike a proportional/aesthetic field like corner
            radius, which keeps it. */}
        {!field.noSlider && (
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
        )}
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
