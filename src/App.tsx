import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kernel } from "./kernel/client";
import { Viewport } from "./viewport/Viewport";
import { Inspector } from "./ui/Inspector";
import { Tree } from "./ui/Tree";
import { beginHistoryBatch, endHistoryBatch, useDoc, useTemporal } from "./document/store";
import { PRIMITIVES, isGroup } from "./document/types";
import { findNode } from "./document/tree";
import type { PrimitiveKind, SceneNode } from "./document/types";
import type { KernelMesh, NodeSpec, ScenePart } from "./kernel/types";
import type { CameraMode, GizmoMode } from "./viewport/scene";
import { APP_NAME, APP_VERSION } from "./version";
import { positionWithReferenceGap } from "./snapping/spacing";
import type { SnapAnchor, SnapAxis } from "./snapping/snap";

/** Only the fields the kernel cares about — so renaming or collapsing a node
 *  never triggers a rebuild. */
const toSpec = (n: SceneNode): NodeSpec =>
  isGroup(n)
    ? {
        type: "group",
        id: n.id,
        op: n.op,
        children: n.children.map(toSpec),
        position: n.position,
        rotation: n.rotation,
        isHole: n.isHole,
      }
    : {
        type: "object",
        id: n.id,
        kind: n.kind,
        params: n.params,
        position: n.position,
        rotation: n.rotation,
        isHole: n.isHole,
      };

/** Geometry-defining shape of a node, ignoring its own placement. A group's
 *  shape does depend on where its children sit, so those stay included. */
const shapeOf = (n: SceneNode): unknown =>
  isGroup(n)
    ? [
        n.id,
        "g",
        n.op,
        // A child's hole flag affects this group's boolean, while this group's
        // own hole flag only affects its parent (or root display material).
        n.children.map((c) => [shapeOf(c), c.position, c.rotation, c.isHole]),
      ]
    : [n.id, n.kind, n.params];

export function App() {
  const nodes = useDoc((s) => s.nodes);
  const selectedIds = useDoc((s) => s.selectedIds);
  const showResult = useDoc((s) => s.showResult);
  const savedAt = useDoc((s) => s.savedAt);
  const storageBlocked = useDoc((s) => s.storageBlocked);
  const {
    addPrimitive,
    removeSelected,
    select,
    setParam,
    setTransform,
    setHole,
    setGroupOp,
    toggleCollapsed,
    rename,
    group,
    ungroup,
    setShowResult,
    clearAll,
  } = useDoc.getState();

  // Ticks the "Saved 2m ago" label without re-rendering on every frame.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const undo = useTemporal((s) => s.undo);
  const redo = useTemporal((s) => s.redo);
  const canUndo = useTemporal((s) => s.pastStates.length > 0);
  const canRedo = useTemporal((s) => s.futureStates.length > 0);

  const [parts, setParts] = useState<ScenePart[]>([]);
  const [result, setResult] = useState<KernelMesh | null>(null);
  const [stats, setStats] = useState<{ volume: number; faces: number; ms: number } | null>(null);
  /** Per-node failures, keyed by node id. */
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [cameraMode, setCameraMode] = useState<CameraMode>("perspective");
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("translate");
  const [gapAxis, setGapAxis] = useState<SnapAxis>("x");
  const [gapMm, setGapMm] = useState(10);
  const [fixedAnchor, setFixedAnchor] = useState<SnapAnchor>("max");
  const [movingAnchor, setMovingAnchor] = useState<SnapAnchor>("min");
  const [gapDirection, setGapDirection] = useState<-1 | 1>(1);
  const [spacingSwapped, setSpacingSwapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveLabel = storageBlocked
    ? "⚠ Autosave unavailable — this browser is blocking local storage."
    : savedAt
      ? `Saved ${timeAgo(savedAt, now)}`
      : nodes.length
        ? "Saving…"
        : "Autosaves to this browser";

  const selected = selectedIds.length ? findNode(nodes, selectedIds[selectedIds.length - 1]) : null;
  const canGroup = selectedIds.length >= 2;
  const canUngroup = selectedIds.some((id) => {
    const n = findNode(nodes, id);
    return !!n && isGroup(n);
  });
  const spacingSelection = useMemo(() => {
    if (selectedIds.length !== 2) return null;
    const fixedId = selectedIds[spacingSwapped ? 1 : 0];
    const movingId = selectedIds[spacingSwapped ? 0 : 1];
    const fixedNode = findNode(nodes, fixedId);
    const movingNode = findNode(nodes, movingId);
    const fixedPart = parts.find((p) => p.id === fixedId);
    const movingPart = parts.find((p) => p.id === movingId);
    return fixedNode && movingNode && fixedPart && movingPart
      ? { fixedNode, movingNode, fixedPart, movingPart }
      : null;
  }, [nodes, parts, selectedIds, spacingSwapped]);

  useEffect(() => setSpacingSwapped(false), [selectedIds[0], selectedIds[1]]);

  const applyGap = useCallback(() => {
    if (!spacingSelection || !Number.isFinite(gapMm)) return;
    const position = positionWithReferenceGap(
      spacingSelection.fixedNode,
      spacingSelection.fixedPart.mesh,
      spacingSelection.movingNode,
      spacingSelection.movingPart.mesh,
      gapAxis,
      fixedAnchor,
      movingAnchor,
      Math.max(0, gapMm),
      gapDirection,
    );
    setTransform(spacingSelection.movingNode.id, { position });
  }, [fixedAnchor, gapAxis, gapDirection, gapMm, movingAnchor, setTransform, spacingSelection]);

  // Rebuild only when geometry-defining data changes. Dragging a top-level node
  // changes its position, which the viewport applies itself without the kernel.
  const shapeKey = useMemo(() => JSON.stringify(nodes.map(shapeOf)), [nodes]);
  const worldKey = useMemo(() => JSON.stringify(nodes.map(toSpec)), [nodes]);

  const buildId = useRef(0);

  useEffect(() => {
    const specs = useDoc.getState().nodes.map(toSpec);
    if (!specs.length) {
      setParts([]);
      setInvalid({});
      return;
    }
    const id = ++buildId.current;
    setBusy(true);
    kernel
      .buildScene(specs)
      .then((res) => {
        if (id !== buildId.current) return;
        setParts(res.parts);
        setInvalid(Object.fromEntries(res.errors.map((e) => [e.id, e.message])));
        setError(null);
      })
      .catch((e: unknown) => {
        if (id === buildId.current) setError(msg(e));
      })
      .finally(() => {
        if (id === buildId.current) setBusy(false);
      });
  }, [shapeKey]);

  // The fully booleaned result is expensive, so only compute it when shown.
  useEffect(() => {
    if (!showResult) {
      setResult(null);
      return;
    }
    const specs = useDoc.getState().nodes.map(toSpec);
    let stale = false;
    setBusy(true);
    kernel
      .buildResult(specs)
      .then((res) => {
        if (stale) return;
        setResult(res.mesh);
        setStats({ volume: res.volume, faces: res.faceCount, ms: res.buildMs });
        setError(null);
      })
      .catch((e: unknown) => !stale && setError(msg(e)))
      .finally(() => !stale && setBusy(false));
    return () => {
      stale = true;
    };
  }, [showResult, worldKey]);

  const onSelect = useCallback(
    (id: string | null, additive: boolean) => select(id, additive),
    [select],
  );
  const onTransform = useCallback(
    (id: string, patch: Parameters<typeof setTransform>[1]) => setTransform(id, patch),
    [setTransform],
  );
  // A gizmo drag emits a change every frame; collapse the whole drag into one
  // undo step so undo jumps back to where the drag started.
  const onDragChange = useCallback(
    (dragging: boolean) => (dragging ? beginHistoryBatch() : endHistoryBatch()),
    [],
  );

  const exportSTL = async () => {
    const blob = await kernel.exportSTL(useDoc.getState().nodes.map(toSpec));
    if (!blob) {
      setError("Nothing to export — add at least one solid.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "part.stl";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Shortcuts, ignored while typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;

      if ((e.key === "Delete" || e.key === "Backspace") && useDoc.getState().selectedIds.length) {
        e.preventDefault();
        removeSelected();
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroup();
        else group();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeSelected, undo, redo, group, ungroup]);

  return (
    <div className="app">
      <aside className="panel left">
        <div className="brand">
          <span className="brand-name">{APP_NAME}</span>
          <span className="brand-version">v{APP_VERSION}</span>
        </div>

        <h1>Add</h1>
        <div className="grid2">
          {(Object.keys(PRIMITIVES) as PrimitiveKind[]).map((kind) => (
            <button key={kind} onClick={() => addPrimitive(kind)}>
              {PRIMITIVES[kind].label}
            </button>
          ))}
        </div>

        <h1>Objects</h1>
        {nodes.length === 0 && <p className="hint">Add a primitive to start.</p>}
        <Tree
          nodes={nodes}
          selectedIds={selectedIds}
          invalid={invalid}
          onSelect={onSelect}
          onToggleCollapsed={toggleCollapsed}
        />

        <div className="row">
          <button onClick={group} disabled={!canGroup} title="Ctrl+G">
            Group
          </button>
          <button onClick={ungroup} disabled={!canUngroup} title="Ctrl+Shift+G">
            Ungroup
          </button>
        </div>
        <p className="hint">Ctrl-click to select more than one.</p>

        <div className="row">
          <button onClick={() => undo()} disabled={!canUndo}>
            Undo
          </button>
          <button onClick={() => redo()} disabled={!canRedo}>
            Redo
          </button>
        </div>

        <div className="row">
          <button
            onClick={() => {
              if (!nodes.length || confirm("Discard this design and start a new one?")) clearAll();
            }}
            disabled={!nodes.length}
          >
            New
          </button>
        </div>
        <p className="hint saved">{saveLabel}</p>
      </aside>

      <Viewport
        parts={parts}
        result={result}
        nodes={nodes}
        selectedIds={selectedIds}
        cameraMode={cameraMode}
        gizmoMode={gizmoMode}
        showResult={showResult}
        onSelect={onSelect}
        onTransform={onTransform}
        onDragChange={onDragChange}
      />

      <aside className="panel right">
        <h1>View</h1>
        <div className="row">
          <button
            className={cameraMode === "perspective" ? "on" : ""}
            onClick={() => setCameraMode("perspective")}
          >
            Perspective
          </button>
          <button
            className={cameraMode === "orthographic" ? "on" : ""}
            onClick={() => setCameraMode("orthographic")}
          >
            Ortho
          </button>
        </div>
        <div className="row">
          <button
            className={gizmoMode === "translate" ? "on" : ""}
            onClick={() => setGizmoMode("translate")}
          >
            Move
          </button>
          <button
            className={gizmoMode === "rotate" ? "on" : ""}
            onClick={() => setGizmoMode("rotate")}
          >
            Rotate
          </button>
        </div>
        <p className="hint">Move snaps to nearby edges and centres. Hold Alt to bypass.</p>

        <h1>Spacing</h1>
        <div className="spacing-objects">
          <div>
            <span className="field-label">Stays fixed</span>
            <strong>{spacingSelection?.fixedNode.name ?? "First selected object"}</strong>
          </div>
          <button
            disabled={!spacingSelection}
            onClick={() => setSpacingSwapped((v) => !v)}
            title="Exchange the fixed and moving objects"
          >
            Swap
          </button>
          <div>
            <span className="field-label">Moves</span>
            <strong>{spacingSelection?.movingNode.name ?? "Second selected object"}</strong>
          </div>
        </div>
        <div className="row">
          {(["x", "y", "z"] as SnapAxis[]).map((axis) => (
            <button
              key={axis}
              className={gapAxis === axis ? "on" : ""}
              onClick={() => setGapAxis(axis)}
            >
              {axis.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Measure from fixed object</span>
          <select
            className="num"
            value={fixedAnchor}
            onChange={(e) => setFixedAnchor(e.target.value as SnapAnchor)}
          >
            <option value="min">Minimum edge</option>
            <option value="center">Centre</option>
            <option value="max">Maximum edge</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Measure to moving object</span>
          <select
            className="num"
            value={movingAnchor}
            onChange={(e) => setMovingAnchor(e.target.value as SnapAnchor)}
          >
            <option value="min">Minimum edge</option>
            <option value="center">Centre</option>
            <option value="max">Maximum edge</option>
          </select>
        </label>
        <span className="field-label">Direction from fixed reference</span>
        <div className="row">
          <button className={gapDirection === -1 ? "on" : ""} onClick={() => setGapDirection(-1)}>
            Negative
          </button>
          <button className={gapDirection === 1 ? "on" : ""} onClick={() => setGapDirection(1)}>
            Positive
          </button>
        </div>
        <label className="field">
          <span className="field-label">Gap (mm)</span>
          <input
            className="num"
            type="number"
            min={0}
            step={0.5}
            value={gapMm}
            onChange={(e) => setGapMm(Number(e.target.value))}
          />
        </label>
        <button className="primary" disabled={!spacingSelection} onClick={applyGap}>
          Set exact gap
        </button>
        <p className="hint spacing-hint">
          {spacingSelection
            ? `${spacingSelection.fixedNode.name} stays fixed; ${spacingSelection.movingNode.name} moves along ${gapAxis.toUpperCase()}.`
            : "Select exactly two top-level objects. The first stays fixed."}
        </p>

        <label className="check">
          <input
            type="checkbox"
            checked={showResult}
            onChange={(e) => setShowResult(e.target.checked)}
          />
          <span>Show merged result</span>
        </label>

        <button className="primary" onClick={exportSTL}>
          Export STL
        </button>

        {selected ? (
          <Inspector
            node={selected}
            error={invalid[selected.id] ?? null}
            onParam={(k, v) => setParam(selected.id, k, v)}
            onTransform={(patch) => setTransform(selected.id, patch)}
            onHole={(h) => setHole(selected.id, h)}
            onOp={(op) => setGroupOp(selected.id, op)}
            onRename={(n) => rename(selected.id, n)}
            onDelete={removeSelected}
          />
        ) : (
          <p className="hint">Select an object to edit it.</p>
        )}

        <dl className="stats">
          <dt>Status</dt>
          <dd>{error ? <span className="err">{error}</span> : busy ? "building…" : "ready"}</dd>
          <dt>Selected</dt>
          <dd>{selectedIds.length}</dd>
          {showResult && stats && (
            <>
              <dt>Volume</dt>
              <dd>{stats.volume.toFixed(1)} mm³</dd>
              <dt>Faces</dt>
              <dd>{stats.faces}</dd>
              <dt>Boolean</dt>
              <dd>{Math.round(stats.ms)} ms</dd>
            </>
          )}
        </dl>
      </aside>
    </div>
  );
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function timeAgo(then: number, now: number): string {
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}
