import { useEffect, useMemo, useState } from "react";
import type { SceneNode, SketchData, Vec3 } from "../document/types";
import { isGroup } from "../document/types";
import {
  generateCircularTransforms,
  generateGridTransforms,
  generatePathTransforms,
  type TransformPatch,
} from "../geometry/pattern";
import {
  CircularPatternIcon,
  GridPatternIcon,
  PathPatternIcon,
} from "./icons";

interface PatternModalProps {
  open: boolean;
  onClose: () => void;
  selectedNodes: SceneNode[];
  allNodes: SceneNode[];
  onApply: (
    transforms: TransformPatch[],
    options: { asGroup: boolean; asHole?: boolean; groupName: string }
  ) => void;
}

type PatternTab = "circular" | "grid" | "path";

export function PatternModal({
  open,
  onClose,
  selectedNodes,
  allNodes,
  onApply,
}: PatternModalProps) {
  const [tab, setTab] = useState<PatternTab>("circular");

  // Circular State
  const [circCount, setCircCount] = useState(16);
  const [circAngle, setCircAngle] = useState(360);
  const [circAxis, setCircAxis] = useState<0 | 1 | 2>(2);
  const [circRotateCopies, setCircRotateCopies] = useState(true);
  const [circCenterX, setCircCenterX] = useState(0);
  const [circCenterY, setCircCenterY] = useState(0);
  const [circCenterZ, setCircCenterZ] = useState(0);

  // Grid / Honeycomb State
  const [gridRows, setGridRows] = useState(5);
  const [gridCols, setGridCols] = useState(8);
  const [gridSpacingX, setGridSpacingX] = useState(12);
  const [gridSpacingY, setGridSpacingY] = useState(12);
  const [gridStagger, setGridStagger] = useState<"none" | "hex">("none");
  const [gridPlane, setGridPlane] = useState<"XY" | "XZ" | "YZ">("XY");
  const [gridCenter, setGridCenter] = useState(true);

  // Path State
  const [pathSketchId, setPathSketchId] = useState<string>("");
  const [pathCount, setPathCount] = useState(12);
  const [pathFollowTangent, setPathFollowTangent] = useState(true);
  const [pathOffset, setPathOffset] = useState(0);

  // Common Options
  const [asGroup, setAsGroup] = useState(true);
  const [asHole, setAsHole] = useState(false);

  // Find all available sketch objects in the scene
  const availableSketches = useMemo(() => {
    const list: { id: string; name: string; sketch: SketchData; position: Vec3; rotation: Vec3 }[] = [];
    function scan(nodes: SceneNode[]) {
      for (const n of nodes) {
        if (n.type === "object" && n.kind === "sketch" && n.sketch && n.sketch.paths?.length) {
          list.push({ id: n.id, name: n.name || "Sketch", sketch: n.sketch, position: n.position, rotation: n.rotation });
        }
        if (isGroup(n)) scan(n.children);
      }
    }
    scan(allNodes);
    return list;
  }, [allNodes]);

  useEffect(() => {
    if (availableSketches.length && (!pathSketchId || !availableSketches.some(s => s.id === pathSketchId))) {
      setPathSketchId(availableSketches[0].id);
    }
  }, [availableSketches, pathSketchId]);

  // Check if initial selection has holes
  useEffect(() => {
    if (selectedNodes.length) {
      const hasHole = selectedNodes.some((n) => n.type === "object" && n.isHole);
      setAsHole(hasHole);
    }
  }, [selectedNodes]);

  // Primary source node coordinates
  const primaryNode = selectedNodes[0];
  const sourcePos: Vec3 = primaryNode ? primaryNode.position : [0, 0, 0];
  const sourceRot: Vec3 = primaryNode ? primaryNode.rotation : [0, 0, 0];

  // Calculated transforms
  const computedTransforms = useMemo<TransformPatch[]>(() => {
    if (!primaryNode) return [];

    if (tab === "circular") {
      return generateCircularTransforms(sourcePos, sourceRot, {
        count: circCount,
        totalAngle: circAngle,
        axis: circAxis,
        center: [circCenterX, circCenterY, circCenterZ],
        rotateCopies: circRotateCopies,
      });
    }

    if (tab === "grid") {
      return generateGridTransforms(sourcePos, sourceRot, {
        rows: gridRows,
        cols: gridCols,
        spacingX: gridSpacingX,
        spacingY: gridSpacingY,
        stagger: gridStagger,
        centerGrid: gridCenter,
        plane: gridPlane,
      });
    }

    if (tab === "path") {
      const chosen = availableSketches.find((s) => s.id === pathSketchId);
      if (!chosen || !chosen.sketch.paths.length) return [{ position: sourcePos, rotation: sourceRot }];
      return generatePathTransforms(sourcePos, sourceRot, {
        path: chosen.sketch.paths[0],
        count: pathCount,
        followTangent: pathFollowTangent,
        startOffset: pathOffset / 100,
        plane: "XY",
        sketchOrigin: chosen.position,
      });
    }

    return [];
  }, [
    tab,
    primaryNode,
    sourcePos,
    sourceRot,
    circCount,
    circAngle,
    circAxis,
    circCenterX,
    circCenterY,
    circCenterZ,
    circRotateCopies,
    gridRows,
    gridCols,
    gridSpacingX,
    gridSpacingY,
    gridStagger,
    gridCenter,
    gridPlane,
    pathSketchId,
    pathCount,
    pathFollowTangent,
    pathOffset,
    availableSketches,
  ]);

  if (!open) return null;

  const handleCreate = () => {
    if (computedTransforms.length < 1) return;
    const groupName =
      tab === "circular"
        ? `Radial Pattern (${computedTransforms.length}x)`
        : tab === "grid"
        ? `Grid Grill (${gridRows}x${gridCols})`
        : `Path Array (${computedTransforms.length}x)`;

    onApply(computedTransforms, { asGroup, asHole, groupName });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="settings-modal pattern-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pattern-title"
      >
        <div className="settings-header">
          <h1 id="pattern-title" className="settings-title">Pattern & Array</h1>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-sidebar" aria-label="Pattern Modes">
            <button
              type="button"
              className={`settings-nav-item ${tab === "circular" ? "active" : ""}`}
              onClick={() => setTab("circular")}
            >
              <CircularPatternIcon className="pattern-tab-icon" />
              <span>Circular / Radial</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${tab === "grid" ? "active" : ""}`}
              onClick={() => setTab("grid")}
            >
              <GridPatternIcon className="pattern-tab-icon" />
              <span>Grid / Honeycomb</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${tab === "path" ? "active" : ""}`}
              onClick={() => setTab("path")}
            >
              <PathPatternIcon className="pattern-tab-icon" />
              <span>Along Path</span>
            </button>
          </nav>

          <main className="settings-content">
            {tab === "circular" && (
              <div className="settings-group">
                <h3>Radial Distribution (Tires, Gears, Dials)</h3>
                <p className="hint">
                  Distributes copies in a circular ring around a center axis.
                </p>

                <div className="pattern-field">
                  <div className="pattern-label-row">
                    <label>Count (Instances)</label>
                    <span className="pattern-val">{circCount}</span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={72}
                    step={1}
                    value={circCount}
                    onChange={(e) => setCircCount(Number(e.target.value))}
                  />
                  <div className="preset-chips">
                    {[6, 8, 12, 16, 24, 32, 48].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`chip-btn ${circCount === n ? "on" : ""}`}
                        onClick={() => setCircCount(n)}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pattern-field">
                  <div className="pattern-label-row">
                    <label>Total Sweep Angle</label>
                    <span className="pattern-val">{circAngle}°</span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={360}
                    step={15}
                    value={circAngle}
                    onChange={(e) => setCircAngle(Number(e.target.value))}
                  />
                  <div className="preset-chips">
                    {[90, 180, 270, 360].map((deg) => (
                      <button
                        key={deg}
                        type="button"
                        className={`chip-btn ${circAngle === deg ? "on" : ""}`}
                        onClick={() => setCircAngle(deg)}
                      >
                        {deg}°
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pattern-field">
                  <label>Rotation Axis</label>
                  <div className="preset-chips">
                    {[
                      { label: "Z Axis (Upright)", axis: 2 },
                      { label: "X Axis", axis: 0 },
                      { label: "Y Axis", axis: 1 },
                    ].map((opt) => (
                      <button
                        key={opt.axis}
                        type="button"
                        className={`chip-btn ${circAxis === opt.axis ? "on" : ""}`}
                        onClick={() => setCircAxis(opt.axis as 0 | 1 | 2)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pattern-field">
                  <div className="pattern-label-row">
                    <label>Center Origin (mm)</label>
                    <span className="pattern-val">[{circCenterX}, {circCenterY}, {circCenterZ}]</span>
                  </div>
                  <div className="pattern-triple-inputs">
                    <label><span>X:</span><input type="number" step={1} value={circCenterX} onChange={(e) => setCircCenterX(Number(e.target.value))} /></label>
                    <label><span>Y:</span><input type="number" step={1} value={circCenterY} onChange={(e) => setCircCenterY(Number(e.target.value))} /></label>
                    <label><span>Z:</span><input type="number" step={1} value={circCenterZ} onChange={(e) => setCircCenterZ(Number(e.target.value))} /></label>
                  </div>
                </div>

                <div className="pattern-field">
                  <label className="lowpoly-toggle">
                    <input
                      type="checkbox"
                      checked={circRotateCopies}
                      onChange={(e) => setCircRotateCopies(e.target.checked)}
                    />
                    <span>Rotate copies to follow the curve (tangential)</span>
                  </label>
                </div>
              </div>
            )}

            {tab === "grid" && (
              <div className="settings-group">
                <h3>Matrix & Honeycomb (Grilles, Vents, Arrays)</h3>
                <p className="hint">
                  Repeats holes or shapes in a 2D rectangular or staggered honeycomb mesh.
                </p>

                <div className="pattern-field">
                  <div className="pattern-label-row">
                    <label>Columns (X) × Rows (Y)</label>
                    <span className="pattern-val">
                      {gridCols} × {gridRows} ({gridCols * gridRows} total)
                    </span>
                  </div>
                  <div className="pattern-dual-inputs">
                    <label>
                      <span>Cols:</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={gridCols}
                        onChange={(e) => setGridCols(Math.max(1, Number(e.target.value)))}
                      />
                    </label>
                    <label>
                      <span>Rows:</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={gridRows}
                        onChange={(e) => setGridRows(Math.max(1, Number(e.target.value)))}
                      />
                    </label>
                  </div>
                </div>

                <div className="pattern-field">
                  <div className="pattern-label-row">
                    <label>Spacing (mm)</label>
                    <span className="pattern-val">
                      {gridSpacingX} mm × {gridSpacingY} mm
                    </span>
                  </div>
                  <div className="pattern-dual-inputs">
                    <label>
                      <span>X:</span>
                      <input
                        type="number"
                        min={0.5}
                        step={0.5}
                        value={gridSpacingX}
                        onChange={(e) => setGridSpacingX(Math.max(0.1, Number(e.target.value)))}
                      />
                    </label>
                    <label>
                      <span>Y:</span>
                      <input
                        type="number"
                        min={0.5}
                        step={0.5}
                        value={gridSpacingY}
                        onChange={(e) => setGridSpacingY(Math.max(0.1, Number(e.target.value)))}
                      />
                    </label>
                  </div>
                </div>

                <div className="pattern-field">
                  <label>Pattern Style</label>
                  <div className="preset-chips">
                    <button
                      type="button"
                      className={`chip-btn ${gridStagger === "none" ? "on" : ""}`}
                      onClick={() => setGridStagger("none")}
                    >
                      Rectangular Grid
                    </button>
                    <button
                      type="button"
                      className={`chip-btn ${gridStagger === "hex" ? "on" : ""}`}
                      onClick={() => setGridStagger("hex")}
                    >
                      Honeycomb (Staggered Hex)
                    </button>
                  </div>
                </div>

                <div className="pattern-field">
                  <label>Grid Plane</label>
                  <div className="preset-chips">
                    {(["XY", "XZ", "YZ"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`chip-btn ${gridPlane === p ? "on" : ""}`}
                        onClick={() => setGridPlane(p)}
                      >
                        {p === "XY" ? "XY (Top / Plate)" : p === "XZ" ? "XZ (Front)" : "YZ (Side)"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pattern-field">
                  <label className="lowpoly-toggle">
                    <input
                      type="checkbox"
                      checked={gridCenter}
                      onChange={(e) => setGridCenter(e.target.checked)}
                    />
                    <span>Center grid around the selected object</span>
                  </label>
                </div>
              </div>
            )}

            {tab === "path" && (
              <div className="settings-group">
                <h3>Along Custom Path (Curves, Compound Borders)</h3>
                <p className="hint">
                  Evenly spaces instances along any drawn Sketch curve in the scene.
                </p>

                {availableSketches.length === 0 ? (
                  <div className="invalid">
                    No Sketch paths found in the scene. Draw a curve in the <strong>Sketch Editor</strong> first to use as a trajectory!
                  </div>
                ) : (
                  <>
                    <div className="pattern-field">
                      <label>Select Guide Sketch</label>
                      <select
                        value={pathSketchId}
                        onChange={(e) => setPathSketchId(e.target.value)}
                        className="pattern-select"
                      >
                        {availableSketches.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.sketch.paths.length} path{s.sketch.paths.length > 1 ? "s" : ""})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="pattern-field">
                      <div className="pattern-label-row">
                        <label>Count (Instances)</label>
                        <span className="pattern-val">{pathCount}</span>
                      </div>
                      <input
                        type="range"
                        min={2}
                        max={60}
                        step={1}
                        value={pathCount}
                        onChange={(e) => setPathCount(Number(e.target.value))}
                      />
                    </div>

                    <div className="pattern-field">
                      <div className="pattern-label-row">
                        <label>Start Offset</label>
                        <span className="pattern-val">{pathOffset}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={pathOffset}
                        onChange={(e) => setPathOffset(Number(e.target.value))}
                      />
                    </div>

                    <div className="pattern-field">
                      <label className="lowpoly-toggle">
                        <input
                          type="checkbox"
                          checked={pathFollowTangent}
                          onChange={(e) => setPathFollowTangent(e.target.checked)}
                        />
                        <span>Rotate copies to follow the path curve direction</span>
                      </label>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="pattern-options-bar">
              <label className="lowpoly-toggle">
                <input
                  type="checkbox"
                  checked={asGroup}
                  onChange={(e) => setAsGroup(e.target.checked)}
                />
                <span>Group pattern into an Assembly</span>
              </label>
              <label className="lowpoly-toggle">
                <input
                  type="checkbox"
                  checked={asHole}
                  onChange={(e) => setAsHole(e.target.checked)}
                />
                <span>Make copies into Holes (for cutting vents/grills)</span>
              </label>
            </div>
          </main>
        </div>

        <div className="settings-footer">
          <div className="pattern-summary">
            {computedTransforms.length > 1 ? (
              <span>
                Creates <strong>{computedTransforms.length - 1}</strong> copies (<strong>{computedTransforms.length}</strong> total)
              </span>
            ) : (
              <span>Select an object to pattern</span>
            )}
          </div>
          <div className="pattern-btn-row">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary settings-ok-btn"
              disabled={computedTransforms.length < 2}
              onClick={handleCreate}
            >
              Create Pattern
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
