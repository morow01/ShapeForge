import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kernel, KernelTimeoutError, WATCHDOG_MS } from "./kernel/client";
import { Viewport } from "./viewport/Viewport";
import { Inspector } from "./ui/Inspector";
import { Tree } from "./ui/Tree";
import {
  beginHistoryBatch,
  copySelected,
  endHistoryBatch,
  pasteClipboard,
  useDoc,
  useTemporal,
} from "./document/store";
import { PRIMITIVES, isGroup } from "./document/types";
import { findNode } from "./document/tree";
import { putBlob } from "./document/blobStore";
import type { PrimitiveKind, SceneNode, Vec3 } from "./document/types";
import type { EditSpec, KernelMesh, NodeSpec, ScenePart } from "./kernel/types";
import type { CameraMode, ToolMode } from "./viewport/scene";
import { APP_NAME, APP_VERSION } from "./version";
import { positionWithReferenceGap } from "./snapping/spacing";
import type { SnapAnchor, SnapAxis } from "./snapping/snap";

/** Only the fields the kernel cares about — so renaming or collapsing a node
 *  never triggers a rebuild. */
const toSpec = (n: SceneNode): NodeSpec => {
  if (isGroup(n)) {
    return {
      type: "group",
      id: n.id,
      op: n.op,
      children: n.children.map(toSpec),
      position: n.position,
      rotation: n.rotation,
      scale: n.scale,
      isHole: n.isHole,
    };
  }
  if (n.type === "import") {
    return {
      type: "import",
      id: n.id,
      blobId: n.blobId,
      position: n.position,
      rotation: n.rotation,
      scale: n.scale,
      isHole: n.isHole,
    };
  }
  if (n.type === "edit") {
    return {
      type: "edit",
      id: n.id,
      base: toSpec(n.base),
      ops: n.ops,
      position: n.position,
      rotation: n.rotation,
      scale: n.scale,
      isHole: n.isHole,
    };
  }
  return {
    type: "object",
    id: n.id,
    kind: n.kind,
    params: n.params,
    position: n.position,
    rotation: n.rotation,
    scale: n.scale,
    isHole: n.isHole,
  };
};

/** Removes a skipped node from anywhere in the tree, not just the top level —
 *  a timed-out import nested inside a group must actually come out of that
 *  group's children, or the group (still top-level, so not itself excluded)
 *  keeps resending the exact same slow node on every rebuild. A group left
 *  with no children is dropped too, rather than sent to the kernel empty. */
function pruneSkipped(list: SceneNode[], skippedIds: Set<string>): SceneNode[] {
  const out: SceneNode[] = [];
  for (const n of list) {
    if (skippedIds.has(n.id)) continue;
    if (isGroup(n)) {
      const children = pruneSkipped(n.children, skippedIds);
      if (!children.length) continue;
      out.push(children === n.children ? n : { ...n, children });
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Adds an id to a skip set without a spurious new reference when it is
 *  already there — this feeds a useEffect dependency array, so returning a
 *  fresh Set every time (even a content-identical one) would re-trigger the
 *  rebuild effect forever once a node is already skipped. */
function addSkip(prev: Set<string>, id: string): Set<string> {
  if (prev.has(id)) return prev;
  return new Set(prev).add(id);
}

/** Geometry-defining shape of a node, ignoring its own placement. A group's
 *  shape does depend on where its children sit, so those stay included. */
const shapeOf = (n: SceneNode): unknown => {
  if (isGroup(n)) {
    return [
      n.id,
      "g",
      n.op,
      // A child's hole flag affects this group's boolean, while this group's
      // own hole flag only affects its parent (or root display material).
      n.children.map((c) => [shapeOf(c), c.position, c.rotation, c.scale, c.isHole]),
    ];
  }
  // blobId never changes for an import node, so this is stable — importSTL()
  // never re-runs just because the node moved.
  if (n.type === "import") return [n.id, "import", n.blobId];
  if (n.type === "edit") return [n.id, "edit", shapeOf(n.base), n.ops];
  return [n.id, n.kind, n.params];
};

export function App() {
  const nodes = useDoc((s) => s.nodes);
  const selectedIds = useDoc((s) => s.selectedIds);
  const showResult = useDoc((s) => s.showResult);
  const savedAt = useDoc((s) => s.savedAt);
  const storageBlocked = useDoc((s) => s.storageBlocked);
  const {
    addPrimitive,
    addImport,
    removeSelected,
    select,
    selectMany,
    setParam,
    setTransform,
    setPositions,
    duplicateNodes,
    pushPullFace,
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
  /** Top-level node ids excluded from kernel calls after a watchdog timeout —
   *  see KernelTimeoutError. Without this, the same node would just hang the
   *  next rebuild too, forever: the retry sends the exact same input to a
   *  freshly-booted worker and gets the exact same (non-)result. Keeping the
   *  node out of what gets sent is what lets everything ELSE in the scene
   *  render again; the node itself stays visible in the tree with a warning
   *  so the user can delete or replace it. */
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [cameraMode, setCameraMode] = useState<CameraMode>("perspective");
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [resizeConstrained, setResizeConstrained] = useState(true);
  const [gapAxis, setGapAxis] = useState<SnapAxis>("x");
  const [gapMm, setGapMm] = useState(10);
  const [fixedAnchor, setFixedAnchor] = useState<SnapAnchor>("max");
  const [movingAnchor, setMovingAnchor] = useState<SnapAnchor>("min");
  const [gapDirection, setGapDirection] = useState<-1 | 1>(1);
  const [spacingSwapped, setSpacingSwapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracked separately, not as one shared flag: buildScene and buildResult
  // are independent kernel calls, and — because they share one single-
  // threaded worker — an abandoned buildResult (say, from toggling "Show
  // merged result" off before a slow one finished) can go on occupying the
  // worker for a while after the user stopped caring about it, which would
  // otherwise make a totally ordinary, fast buildScene edit right after LOOK
  // stuck too, since a shared flag would already read "busy" from a stretch
  // that has nothing to do with what the user just did.
  const [sceneBusy, setSceneBusy] = useState(false);
  const [resultBusy, setResultBusy] = useState(false);
  const busy = sceneBusy || resultBusy;
  // Timestamp sceneBusy last turned true, so the "still working" hint (below)
  // only shows up once it's genuinely been a while — an ordinary rebuild
  // finishes in well under a second, and flashing a "this can take minutes"
  // note for every routine edit would just be noise. Scoped to sceneBusy
  // specifically (see above) rather than the combined busy flag, so it can't
  // be left showing a stale multi-minute stretch attributable to a
  // buildResult call the user no longer cares about.
  const [busySince, setBusySince] = useState<number | null>(null);
  const [busyNow, setBusyNow] = useState(Date.now());
  useEffect(() => {
    if (!sceneBusy) {
      setBusySince(null);
      return;
    }
    setBusySince((prev) => prev ?? Date.now());
    const t = setInterval(() => setBusyNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sceneBusy]);

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

  // Deleting a skipped node should let its id go, not leak it for the rest
  // of the session — otherwise re-importing the same file under a new node
  // would still work (blobId is what actually gets skipped nowhere; only the
  // node id is), but the stale entry would just sit here doing nothing.
  useEffect(() => {
    setSkippedIds((prev) => {
      const live = new Set(nodes.map((n) => n.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [nodes]);

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

  // Nodes actually sent to the kernel — skippedIds excludes anything a
  // watchdog timeout already blamed, so it is not retried into another hang.
  const buildableNodes = useMemo(
    () => pruneSkipped(nodes, skippedIds),
    [nodes, skippedIds],
  );

  // Rebuild only when geometry-defining data changes. Dragging a top-level node
  // changes its position, which the viewport applies itself without the kernel.
  const shapeKey = useMemo(() => JSON.stringify(buildableNodes.map(shapeOf)), [buildableNodes]);
  const worldKey = useMemo(() => JSON.stringify(buildableNodes.map(toSpec)), [buildableNodes]);

  const buildId = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);

  // A slider fires far more onChange events than there are meaningful
  // rebuilds worth doing — a short debounce coalesces a drag's burst into one
  // request shortly after it settles. 32ms is under a frame at 30fps, so it
  // still reads as live. The kernel-side per-node cache (see worker.ts) is
  // the fix for cost scaling with total object count; this cuts how often we
  // even ask, on top of that.
  useEffect(() => {
    const specs = pruneSkipped(useDoc.getState().nodes, skippedIds).map(toSpec);
    if (!specs.length) {
      setParts([]);
      setInvalid((prev) => (skippedIds.size ? prev : {}));
      return;
    }
    const id = ++buildId.current;
    const t = setTimeout(() => {
      setSceneBusy(true);
      kernel
        .buildScene(specs)
        .then((res) => {
          if (id !== buildId.current) return;
          setParts(res.parts);
          setInvalid((prev) => ({
            // Keep any skipped-node warnings already showing — this build
            // never even sent them, so it has no opinion on them.
            ...Object.fromEntries([...skippedIds].map((sid) => [sid, prev[sid]])),
            ...Object.fromEntries(res.errors.map((e) => [e.id, e.message])),
          }));
          setError(null);
        })
        .catch((e: unknown) => {
          if (id !== buildId.current) return;
          if (e instanceof KernelTimeoutError) {
            if (e.nodeId) {
              setInvalid((prev) => ({ ...prev, [e.nodeId!]: e.message }));
              setSkippedIds((prev) => addSkip(prev, e.nodeId!));
            } else {
              setError(e.message);
            }
          } else {
            setError(msg(e));
          }
        })
        .finally(() => {
          if (id === buildId.current) setSceneBusy(false);
        });
    }, 32);
    return () => clearTimeout(t);
  }, [shapeKey, skippedIds]);

  // The fully booleaned result is expensive, so only compute it when shown —
  // and, same reasoning as above, debounced so it does not rebuild on every
  // slider tick while it is visible.
  useEffect(() => {
    if (!showResult) {
      setResult(null);
      return;
    }
    const specs = pruneSkipped(useDoc.getState().nodes, skippedIds).map(toSpec);
    let stale = false;
    const t = setTimeout(() => {
      setResultBusy(true);
      kernel
        .buildResult(specs)
        .then((res) => {
          if (stale) return;
          setResult(res.mesh);
          setStats({ volume: res.volume, faces: res.faceCount, ms: res.buildMs });
          setError(null);
        })
        .catch((e: unknown) => {
          if (stale) return;
          if (e instanceof KernelTimeoutError) {
            if (e.nodeId) {
              setInvalid((prev) => ({ ...prev, [e.nodeId!]: e.message }));
              setSkippedIds((prev) => addSkip(prev, e.nodeId!));
            } else {
              setError(e.message);
            }
          } else {
            setError(msg(e));
          }
        })
        .finally(() => !stale && setResultBusy(false));
    }, 32);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [showResult, worldKey, skippedIds]);

  const onSelect = useCallback(
    (id: string | null, additive: boolean) => select(id, additive),
    [select],
  );
  const onSelectMany = useCallback(
    (ids: string[], additive: boolean) => selectMany(ids, additive),
    [selectMany],
  );
  const onTransform = useCallback(
    (id: string, patch: Parameters<typeof setTransform>[1]) => setTransform(id, patch),
    [setTransform],
  );
  // Alt-drag: the viewport clones the Three.js view itself (for an instant
  // drag start, with no rebuild to wait for) and only needs the new node's
  // id back, to know which id to keep dragging and reporting moves for.
  const onDuplicate = useCallback(
    (id: string) => {
      const node = findNode(useDoc.getState().nodes, id);
      if (!node) return null;
      return duplicateNodes([node], [0, 0, 0])[0] ?? null;
    },
    [duplicateNodes],
  );
  // Live push/pull preview — a real kernel rebuild of just this one node
  // with the dragged distance tentatively appended, never written to the
  // document (see Scene.onPreviewPushPull's own doc comment for why this
  // exists: a live-updating shape during the drag, not just the arrow).
  // Reads useDoc.getState() directly rather than depending on `nodes`, same
  // reasoning as the debounced kernel-call effects above — a fresh read on
  // every call, not a stale one from whenever this callback was last built.
  const onPreviewPushPull = useCallback(
    async (id: string, op: { point: Vec3; normal: Vec3; distance: number }): Promise<KernelMesh | null> => {
      const node = findNode(useDoc.getState().nodes, id);
      if (!node) return null;
      const spec: EditSpec =
        node.type === "edit"
          ? { ...(toSpec(node) as EditSpec), ops: [...node.ops, op] }
          : {
              type: "edit",
              id: node.id,
              base: toSpec(node),
              ops: [op],
              position: node.position,
              rotation: node.rotation,
              scale: node.scale,
              isHole: node.isHole,
            };
      try {
        return await kernel.previewLocal(spec);
      } catch {
        // A watchdog timeout or other transient failure — this frame's
        // preview just doesn't update; the drag itself is unaffected, and
        // the eventual commit (see onPushPull) runs through the normal,
        // fully error-handled rebuild path regardless.
        return null;
      }
    },
    [],
  );
  // A gizmo drag emits a change every frame; collapse the whole drag into one
  // undo step so undo jumps back to where the drag started.
  const onDragChange = useCallback(
    (dragging: boolean) => (dragging ? beginHistoryBatch() : endHistoryBatch()),
    [],
  );

  /** Soft cap so a huge/wrong file gives a clear message instead of hanging
   *  the tab on an import a browser tab realistically cannot chew through. */
  const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

  /**
   * A real-world scanned STL (a downloaded skull, say) can carry far more
   * triangles than a browser-side WASM mesh-repair pass can chew through in
   * any reasonable time — and unlike file size, triangle count is what
   * actually drives that cost. Binary STL (the common case for anything
   * exported by a scanner or downloaded from a model site) puts the count
   * right in the header, so this catches the worst offenders BEFORE they
   * ever reach the kernel, rather than relying solely on the watchdog in
   * kernel/client.ts to notice after the fact. ASCII STL has no such shortcut
   * (its triangle count is not known without scanning the whole file) and is
   * rare for large scans in practice, so it is left to the watchdog.
   */
  const MAX_IMPORT_TRIANGLES = 1_500_000;

  /** Binary STL: 80-byte header, then a uint32 triangle count, then 50 bytes
   *  per triangle. A file whose size doesn't match that formula for the
   *  count it claims is not a binary STL (most likely ASCII) — ignored, not
   *  rejected, since ASCII files can't be triangle-counted this cheaply. */
  function peekBinaryTriangleCount(bytes: ArrayBuffer): number | null {
    if (bytes.byteLength < 84) return null;
    const view = new DataView(bytes);
    const count = view.getUint32(80, true);
    return bytes.byteLength === 84 + count * 50 ? count : null;
  }

  const importSTLFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      setError(`${file.name} is ${(file.size / (1024 * 1024)).toFixed(0)} MB — too large to import.`);
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      const triangles = peekBinaryTriangleCount(bytes);
      if (triangles !== null && triangles > MAX_IMPORT_TRIANGLES) {
        setError(
          `${file.name} has ${triangles.toLocaleString()} triangles — too complex to import here. ` +
            `Try simplifying/decimating it in a mesh tool first (aim under ${MAX_IMPORT_TRIANGLES.toLocaleString()}).`,
        );
        return;
      }
      const blobId = crypto.randomUUID();
      await putBlob(blobId, bytes);
      addImport(blobId, file.name, file.size);
      setError(null);
    } catch (e) {
      setError(`Could not read ${file.name}: ${msg(e)}`);
    }
  };

  const exportSTL = async () => {
    try {
      const specs = pruneSkipped(useDoc.getState().nodes, skippedIds).map(toSpec);
      const blob = await kernel.exportSTL(specs);
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
    } catch (e) {
      if (e instanceof KernelTimeoutError && e.nodeId) {
        setInvalid((prev) => ({ ...prev, [e.nodeId!]: e.message }));
        setSkippedIds((prev) => addSkip(prev, e.nodeId!));
      }
      setError(msg(e));
    }
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
      } else if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelected();
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
      } else if (!mod && e.key.toLowerCase() === "v") {
        setToolMode("select");
      } else if (!mod && e.key.toLowerCase() === "m") {
        setToolMode("move");
      } else if (!mod && e.key.toLowerCase() === "r") {
        setToolMode("rotate");
      } else if (!mod && e.key.toLowerCase() === "a") {
        setToolMode("align");
      } else if (e.key === "Escape") {
        setToolMode("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeSelected, undo, redo, group, ungroup]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">{APP_NAME}</span>
          <span className="brand-version">v{APP_VERSION}</span>
        </div>
        <div className="toolbar-group">
          <button onClick={() => undo()} disabled={!canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button onClick={() => redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
        </div>
        <div className="toolbar-group">
          <button onClick={group} disabled={!canGroup} title="Ctrl+G">Group</button>
          <button onClick={ungroup} disabled={!canUngroup} title="Ctrl+Shift+G">Ungroup</button>
        </div>
        <div className="toolbar-group view-tools">
          <button className={cameraMode === "perspective" ? "on" : ""} onClick={() => setCameraMode("perspective")}>Perspective</button>
          <button className={cameraMode === "orthographic" ? "on" : ""} onClick={() => setCameraMode("orthographic")}>Ortho</button>
        </div>
        <div className="toolbar-spacer" />
        <span className={["status-pill", error ? "error" : busy ? "busy" : ""].filter(Boolean).join(" ")}>
          {error ? "Needs attention" : busy ? "Building…" : "Ready"}
        </span>
        <button className="export-btn" onClick={exportSTL}>Export STL</button>
      </header>

      <aside className="panel object-panel">
        <div className="panel-heading">
          <div>
            <h1>Objects</h1>
            <p>{nodes.length} in design</p>
          </div>
          <button
            className="icon-button"
            onClick={() => {
              if (!nodes.length || confirm("Discard this design and start a new one?")) clearAll();
            }}
            disabled={!nodes.length}
            title="New design"
          >
            ＋
          </button>
        </div>
        {nodes.length === 0 && <div className="empty-state">Add a shape from the library to begin.</div>}
        <Tree
          nodes={nodes}
          selectedIds={selectedIds}
          invalid={invalid}
          onSelect={onSelect}
          onToggleCollapsed={toggleCollapsed}
        />
        <div className="panel-footer">
          <span>{saveLabel}</span>
          <span>{selectedIds.length} selected</span>
        </div>
      </aside>

      <main className="workspace">
        <div className="tool-rail" role="toolbar" aria-label="Design tools">
          <button
            className={toolMode === "select" ? "active" : ""}
            onClick={() => setToolMode("select")}
            title="Select and resize (V)"
            aria-label="Select tool"
          ><span className="tool-symbol cursor-symbol">➤</span></button>
          <button
            className={toolMode === "move" ? "active" : ""}
            onClick={() => setToolMode("move")}
            title="Move with axis controls (M)"
            aria-label="Move tool"
          ><span className="tool-symbol">✥</span></button>
          <button
            className={toolMode === "rotate" ? "active" : ""}
            onClick={() => setToolMode("rotate")}
            title="Rotate (R)"
            aria-label="Rotate tool"
          ><span className="tool-symbol">↻</span></button>
          <button
            className={toolMode === "align" ? "active" : ""}
            onClick={() => setToolMode("align")}
            title="Align selected objects (A)"
            aria-label="Align tool"
            disabled={selectedIds.length < 2}
          ><span className="tool-symbol">⋮</span></button>
        </div>
        <Viewport
          parts={parts}
          result={result}
          nodes={nodes}
          selectedIds={selectedIds}
          cameraMode={cameraMode}
          toolMode={toolMode}
          resizeConstrained={resizeConstrained}
          showResult={showResult}
          onSelect={onSelect}
          onSelectMany={onSelectMany}
          onTransform={onTransform}
          onAlign={setPositions}
          onDuplicate={onDuplicate}
          onPushPull={pushPullFace}
          onPreviewPushPull={onPreviewPushPull}
          onDragChange={onDragChange}
        />
        <div className="canvas-help">
          {toolMode === "align"
            ? "Click a dot to align minimum, centre, or maximum · A Align · Esc Select"
            : "V Select · M Move · R Rotate · A Align · Drag a face arrow to push/pull · Alt-drag duplicate · Shift-drag straight · Right-drag orbit"}
        </div>
        {error && <div className="canvas-error">{error}</div>}
        {!error && busy && busySince && busyNow - busySince > 8000 && (
          <div className="canvas-notice">
            Large or complex files can take a few minutes. ShapeForge will stop after {Math.round(WATCHDOG_MS / 60_000)} min.
          </div>
        )}
      </main>

      <aside className="panel tools-panel">
        <section className="tool-section shape-library">
          <div className="panel-heading compact">
            <div><h1>Shape library</h1><p>Drag or click to add</p></div>
          </div>
          <div className="shape-grid">
            {(Object.keys(PRIMITIVES) as PrimitiveKind[]).map((kind) => (
              <button key={kind} className="shape-card" onClick={() => addPrimitive(kind)}>
                <span className={`shape-icon shape-${kind}`} />
                <span>{PRIMITIVES[kind].label}</span>
              </button>
            ))}
          </div>
          <button className="import-btn" onClick={() => importInputRef.current?.click()}>↑ Import STL</button>
        </section>
        <input
          ref={importInputRef}
          type="file"
          accept=".stl,model/stl,model/x.stl-binary,model/x.stl-ascii"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // so picking the same file twice still fires onChange
            if (file) void importSTLFile(file);
          }}
        />
        <section className="tool-section inspector-section">
          <div className="panel-heading compact"><div><h1>Properties</h1><p>{selected ? selected.name : "Nothing selected"}</p></div></div>
          {selected ? (
            <Inspector
              node={selected}
              error={invalid[selected.id] ?? null}
              onParam={(k, v) => setParam(selected.id, k, v)}
              onTransform={(patch) => setTransform(selected.id, patch)}
              resizeConstrained={resizeConstrained}
              onResizeConstrained={setResizeConstrained}
              onHole={(h) => setHole(selected.id, h)}
              onOp={(op) => setGroupOp(selected.id, op)}
              onRename={(n) => rename(selected.id, n)}
              onDelete={removeSelected}
            />
          ) : <div className="empty-state small">Select an object to edit its dimensions and position.</div>}
        </section>

        {selectedIds.length === 2 && (
        <section className="tool-section spacing-section">
          <div className="panel-heading compact"><div><h1>Exact spacing</h1><p>Set the gap between two objects</p></div></div>
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
          <div className="row axis-row">
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
          <button className="primary" disabled={!spacingSelection} onClick={applyGap}>Set exact gap</button>
          <p className="hint spacing-hint">
          {spacingSelection
            ? `${spacingSelection.fixedNode.name} stays fixed; ${spacingSelection.movingNode.name} moves along ${gapAxis.toUpperCase()}.`
            : "Select exactly two top-level objects. The first stays fixed."}
          </p>
        </section>
        )}

        <section className="tool-section result-section">
          <label className="check">
          <input
            type="checkbox"
            checked={showResult}
            onChange={(e) => setShowResult(e.target.checked)}
          />
          <span>Show merged result</span>
          </label>
          {showResult && stats && (
            <div className="result-stats"><span>{stats.volume.toFixed(1)} mm³</span><span>{stats.faces} faces</span><span>{Math.round(stats.ms)} ms</span></div>
          )}
        </section>
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
