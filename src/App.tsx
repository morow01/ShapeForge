import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kernel, KernelTimeoutError, WATCHDOG_MS } from "./kernel/client";
import { Viewport } from "./viewport/Viewport";
import { Inspector } from "./ui/Inspector";
import { Tree } from "./ui/Tree";
import { DropIcon, ShapeBuilderIcon, TransparencyIcon, WireframeIcon } from "./ui/icons";
import { ProjectsModal } from "./ui/ProjectsModal";
import {
  beginHistoryBatch,
  copySelected,
  endHistoryBatch,
  pasteClipboard,
  useDoc,
  useTemporal,
} from "./document/store";
import { MAX_BUILD_SOURCES, PRIMITIVES, isGroup } from "./document/types";
import { findNode, parentOf, resolveNodeTransparent } from "./document/tree";
import { putBlob } from "./document/blobStore";
import { loadCameraState } from "./document/persist";
import type { PrimitiveKind, SceneNode, Vec3 } from "./document/types";
import type { EditSpec, ExportQuality, NodeSpec, PreviewBuild, ScenePart } from "./kernel/types";
import type { CameraMode, Scene, ToolMode } from "./viewport/scene";
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
  if (n.type === "build") {
    return {
      type: "build",
      id: n.id,
      sources: n.sources.map(toSpec),
      keep: n.keep,
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

const DEAD_PUSH_PULL_ERROR = "A pushed/pulled face could not be found after rebuilding";

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
  if (n.type === "build") return [n.id, "build", n.sources.map(shapeOf), n.keep];
  return [n.id, n.kind, n.params];
};

const EXPORT_QUALITY_KEY = "cad.exportQuality";

/** What each preset costs, so the choice is not guesswork — measured on a
 *  40x30x15 box with a 10mm spherical bowl (see EXPORT_PRESETS in worker.ts). */
const EXPORT_QUALITY_HINT: Record<ExportQuality, string> = {
  draft: "Draft — fastest, visibly faceted curves. Good for test prints.",
  standard: "Standard — faint facets on curved surfaces, exports in a moment.",
  fine: "Fine — smooth curves, but a curved part can take several seconds.",
};

export function App() {
  const nodes = useDoc((s) => s.nodes);
  const selectedIds = useDoc((s) => s.selectedIds);
  const savedAt = useDoc((s) => s.savedAt);
  const storageBlocked = useDoc((s) => s.storageBlocked);
  const projectName = useDoc((s) => s.projectName);

  const [projectsModalOpen, setProjectsModalOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(projectName);
  useEffect(() => setTitleDraft(projectName), [projectName]);

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
    setOps,
    setHole,
    shapeBuild,
    setColor,
    setTransparent,
    setGroupOp,
    toggleCollapsed,
    rename,
    group,
    ungroup,
    clearAll,
    renameProject,
    newProject,
    exportCurrentProject,
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
  const [exporting, setExporting] = useState(false);
  const [readyExportUrl, setReadyExportUrl] = useState<string | null>(null);
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
  const [cameraMode, setCameraMode] = useState<CameraMode>(() => loadCameraState()?.mode ?? "perspective");
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [resizeConstrained, setResizeConstrained] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  /** Shape Builder session: the ids that were decomposed, in the order the
   *  cell masks index them. Null whenever the tool is not running. */
  const [buildSources, setBuildSources] = useState<string[] | null>(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildCells, setBuildCells] = useState<{ mask: number; kept: boolean }[]>([]);
  // Remembered across sessions: which quality you want is a property of how
  // you print, not of one export.
  const [exportQuality, setExportQuality] = useState<ExportQuality>(
    () => (localStorage.getItem(EXPORT_QUALITY_KEY) as ExportQuality | null) ?? "fine",
  );
  const [gapAxis, setGapAxis] = useState<SnapAxis>("x");
  const [gapMm, setGapMm] = useState(10);
  const [fixedAnchor, setFixedAnchor] = useState<SnapAnchor>("max");
  const [movingAnchor, setMovingAnchor] = useState<SnapAnchor>("min");
  const [gapDirection, setGapDirection] = useState<-1 | 1>(1);
  const [spacingSwapped, setSpacingSwapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  const busy = sceneBusy;
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

  const sceneRef = useRef<Scene | null>(null);
  const toolModeRef = useRef<ToolMode>("select");
  toolModeRef.current = toolMode;
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

          // A failed push/pull op has already been skipped by the kernel, so
          // leaving it in the document cannot affect the visible shape — it
          // only makes the same warning reappear on every future rebuild.
          // Verify the edit history has not changed while the repair runs,
          // then permanently retain only the operations the kernel can still
          // resolve. This is the automatic equivalent of the Inspector's
          // existing "Remove broken edit" action.
          for (const issue of res.errors) {
            if (!issue.message.startsWith(DEAD_PUSH_PULL_ERROR)) continue;
            const failed = findNode(useDoc.getState().nodes, issue.id);
            if (!failed || failed.type !== "edit") continue;
            const failedSpec = toSpec(failed) as EditSpec;
            const expectedOps = JSON.stringify(failed.ops);
            void kernel.pruneDeadOps(failedSpec).then((kept) => {
              const current = findNode(useDoc.getState().nodes, issue.id);
              if (
                kept && current?.type === "edit" &&
                JSON.stringify(current.ops) === expectedOps &&
                kept.length < current.ops.length
              ) {
                setOps(current.id, kept);
              }
            }).catch(() => {
              // Keep the warning and manual repair button if validation itself
              // cannot complete; never remove an operation speculatively.
            });
          }
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


  useEffect(() => {
    try {
      localStorage.setItem(EXPORT_QUALITY_KEY, exportQuality);
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [exportQuality]);

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
    async (id: string, op: { point: Vec3; normal: Vec3; distance: number }): Promise<PreviewBuild | null> => {
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
  // "Remove broken edit": permanently drops whichever op(s) in the SELECTED
  // node's own history can no longer find their target face, instead of
  // leaving them to keep re-failing (and re-showing the same error) on
  // every future rebuild — see kernel/shape.ts's survivingOps(). Reads the
  // current selection fresh at call time rather than closing over `selected`
  // from render, same reasoning as onPreviewPushPull above.
  const onPruneDeadOps = useCallback(async () => {
    const s = useDoc.getState();
    const id = s.selectedIds[s.selectedIds.length - 1];
    const node = id ? findNode(s.nodes, id) : null;
    if (!node || node.type !== "edit") return;
    try {
      const kept = await kernel.pruneDeadOps(toSpec(node) as EditSpec);
      if (kept) setOps(node.id, kept);
    } catch (e) {
      setError(msg(e));
    }
  }, [setOps]);
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
    if (exporting) return;
    // Browsers without showSaveFilePicker need the actual download click to
    // happen synchronously inside a user gesture. The first click prepares
    // the Blob; this second, clearly labelled click performs the download.
    if (readyExportUrl) {
      const a = document.createElement("a");
      a.href = readyExportUrl;
      a.download = "part.stl";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setReadyExportUrl(null);
      window.setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(readyExportUrl);
      }, 60_000);
      return;
    }
    setExporting(true);
    setError(null);
    // Ask where to save while this click still has browser user activation.
    // Waiting for the CAD worker first can make Chromium silently reject a
    // later synthetic <a download> click, which looked like Export did
    // nothing even though the STL Blob had been generated successfully.
    type SaveHandle = {
      createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
    };
    const picker = (window as typeof window & {
      showSaveFilePicker?: (options: {
        suggestedName: string;
        types: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<SaveHandle>;
    }).showSaveFilePicker;
    let saveHandle: SaveHandle | null = null;
    if (picker) {
      const askedAt = performance.now();
      try {
        saveHandle = await picker({
          suggestedName: "part.stl",
          types: [{ description: "STL model", accept: { "model/stl": [".stl"] } }],
        });
      } catch (e) {
        // AbortError fires both when the user genuinely clicks Cancel on the
        // dialog, AND when the browser silently refuses to show it at all —
        // lost window focus, an enterprise policy, a privacy extension, or an
        // automated/kiosk environment all produce the exact same error name
        // and message, with no dialog ever appearing. Those two cases are
        // indistinguishable from the rejection alone, and treating every
        // AbortError as "user cancelled" made Export STL a silent no-op
        // whenever the picker couldn't be shown — clicking it did nothing,
        // with no error, no download, nothing. A human cannot see a dialog
        // render and click Cancel in under ~250ms, so a near-instant reject
        // means the picker never actually appeared; fall through to the
        // ordinary <a download> path below instead of giving up. A genuine,
        // slower cancel is still respected and does nothing further.
        const instant = performance.now() - askedAt < 250;
        if (e instanceof DOMException && e.name === "AbortError" && !instant) {
          setExporting(false);
          return;
        }
        // Unsupported/restricted picker, or a picker that never actually
        // showed: use the ordinary download fallback.
      }
    }
    try {
      const currentNodes = pruneSkipped(useDoc.getState().nodes, skippedIds);
      // Always export from the kernel, even for a single object. Re-using the
      // mesh already on screen is faster, but the viewport mesh is built at
      // EDIT_QUALITY and inherits whatever tessellation cracks that pass left
      // — measured on a reported model, exporting the displayed mesh produced
      // an STL with 29 open edges. The saved file is the one artifact of this
      // app that has to be right, so it gets the export-quality, healed path
      // (see blobSTLOf in worker.ts); the worker's own result cache is what
      // keeps that fast.
      const blob = await kernel.exportSTL(currentNodes.map(toSpec), exportQuality);
      if (!blob) {
        setError("Nothing to export — add at least one solid.");
        return;
      }
      if (saveHandle) {
        const writable = await saveHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      }
      setReadyExportUrl(URL.createObjectURL(blob));
    } catch (e) {
      if (e instanceof KernelTimeoutError && e.nodeId) {
        setInvalid((prev) => ({ ...prev, [e.nodeId!]: e.message }));
        setSkippedIds((prev) => addSkip(prev, e.nodeId!));
      }
      setError(msg(e));
    } finally {
      setExporting(false);
    }
  };

  /** Transparency, TinkerCAD-style: every selected solid becomes see-through
   *  (or opaque again) together. Holes are skipped — they already render in
   *  their own material — and a child's group mirrors the change, so a shape
   *  inside a group looks the same as the identical one outside it. */
  const applyTransparent = useCallback(
    (value: boolean) => {
      const s = useDoc.getState();
      if (!s.selectedIds.length) return;
      beginHistoryBatch();
      for (const id of s.selectedIds) {
        const node = findNode(s.nodes, id);
        if (!node || node.isHole) continue;
        setTransparent(id, value);
        const parent = parentOf(s.nodes, id);
        if (parent && isGroup(parent)) setTransparent(parent.id, value);
      }
      endHistoryBatch();
    },
    [setTransparent],
  );

  /** T flips whatever the last-selected object is actually showing right now,
   *  so the whole selection lands on one state rather than each inverting. */
  const toggleTransparency = useCallback(() => {
    const s = useDoc.getState();
    if (!s.selectedIds.length) return;
    const primary = findNode(s.nodes, s.selectedIds[s.selectedIds.length - 1]);
    applyTransparent(!resolveNodeTransparent(primary));
  }, [applyTransparent]);

  const selectionTransparent = useMemo(
    () =>
      selectedIds.length
        ? resolveNodeTransparent(findNode(nodes, selectedIds[selectedIds.length - 1]))
        : false,
    [nodes, selectedIds],
  );

  // Entering Shape Builder decomposes the selection once; leaving it, by any
  // route, tears the session down. The ids are captured here because the
  // commit has to consume exactly what was decomposed, whatever the selection
  // has become by then.
  useEffect(() => {
    if (toolMode !== "build") {
      setBuildSources(null);
      sceneRef.current?.setCells(null);
      return;
    }
    const ids = useDoc.getState().selectedIds;
    const sources = ids
      .map((id) => findNode(useDoc.getState().nodes, id))
      .filter((n): n is SceneNode => !!n && !n.isHole);
    if (sources.length < 2) {
      setError("Shape Builder needs at least two overlapping shapes selected.");
      setToolMode("select");
      return;
    }
    if (sources.length > MAX_BUILD_SOURCES) {
      setError(`Shape Builder handles up to ${MAX_BUILD_SOURCES} shapes at once.`);
      setToolMode("select");
      return;
    }

    let stale = false;
    setBuildBusy(true);
    setError(null);
    kernel
      .buildCells(sources.map(toSpec))
      .then((cells) => {
        if (stale) return;
        if (!cells.length) {
          setError("Those shapes do not overlap, so there are no regions to build from.");
          setToolMode("select");
          return;
        }
        setBuildSources(sources.map((n) => n.id));
        sceneRef.current?.setCells(cells);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setError(msg(e));
        setToolMode("select");
      })
      .finally(() => !stale && setBuildBusy(false));

    return () => {
      stale = true;
    };
  }, [toolMode]);

  /** "Box 1", "Sphere 1", "Box 1 + Sphere 1" — a region named by which of the
   *  source shapes contain it, which is exactly what its mask records. */
  const cellLabel = useCallback(
    (mask: number) => {
      const names = (buildSources ?? [])
        .map((id, i) => ((mask >> i) & 1 ? findNode(nodes, id)?.name ?? `Shape ${i + 1}` : null))
        .filter((n): n is string => !!n);
      return names.join(" + ");
    },
    [buildSources, nodes],
  );

  const keptCount = buildCells.filter((c) => c.kept).length;

  /** Commits the session: the kept regions become one built shape. */
  const commitBuild = useCallback(() => {
    const kept = sceneRef.current?.keptCells() ?? [];
    if (!kept.length) {
      setError("Click at least one region to put it in the shape, then press Enter.");
      return;
    }
    if (buildSources) shapeBuild(buildSources, kept);
    setToolMode("select");
  }, [buildSources, shapeBuild]);

  /** Drop (D): let the selection fall onto whatever is underneath it. The
   *  geometry that answers "what is underneath" only exists in the viewport,
   *  so the scene works out the distances and the document records them. */
  const dropSelected = useCallback(() => {
    const updates = sceneRef.current?.dropSelected() ?? [];
    if (updates.length) setPositions(updates);
  }, [setPositions]);

  // Shortcuts, ignored while typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;

      if ((e.key === "Delete" || e.key === "Backspace") && useDoc.getState().selectedIds.length) {
        e.preventDefault();
        removeSelected();
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setProjectsModalOpen(true);
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        exportCurrentProject();
      } else if (mod && e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const name = prompt("Enter project name:", "Untitled Project");
        if (name !== null) newProject(name);
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
      } else if (!mod && e.key.toLowerCase() === "f") {
        setToolMode("face");
      } else if (!mod && e.key.toLowerCase() === "m") {
        setToolMode("move");
      } else if (!mod && e.key.toLowerCase() === "r") {
        setToolMode("rotate");
      } else if (!mod && e.key.toLowerCase() === "a") {
        setToolMode("align");
      } else if (!mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        toggleTransparency();
      } else if (!mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setToolMode("build");
      } else if (e.key === "Enter" && useDoc.getState().selectedIds.length >= 0 && toolModeRef.current === "build") {
        e.preventDefault();
        commitBuild();
      } else if (!mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        dropSelected();
      } else if (!mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        setWireframe((v) => !v);
      } else if (e.key === "Escape") {
        setToolMode("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeSelected, undo, redo, group, ungroup, toggleTransparency, dropSelected, commitBuild, exportCurrentProject, newProject]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">{APP_NAME}</span>
          <span className="brand-version">v{APP_VERSION}</span>
        </div>

        <div className="project-title-container">
          {isEditingTitle ? (
            <input
              type="text"
              className="project-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                setIsEditingTitle(false);
                if (titleDraft.trim()) renameProject(titleDraft.trim());
                else setTitleDraft(projectName);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setIsEditingTitle(false);
                  if (titleDraft.trim()) renameProject(titleDraft.trim());
                } else if (e.key === "Escape") {
                  setIsEditingTitle(false);
                  setTitleDraft(projectName);
                }
              }}
              autoFocus
            />
          ) : (
            <button
              className="project-title-btn"
              onClick={() => setIsEditingTitle(true)}
              title="Click to rename design"
            >
              <span className="project-title-text">{projectName}</span>
              <span className="project-title-edit-icon">✏️</span>
            </button>
          )}
        </div>

        <div className="toolbar-group project-actions-group">
          <button
            onClick={() => setProjectsModalOpen(true)}
            className="projects-nav-btn"
            title="Open Projects Library (Ctrl+O)"
          >
            📁 Projects
          </button>
          <button
            onClick={() => {
              const name = prompt("Enter project name:", "Untitled Project");
              if (name !== null) newProject(name);
            }}
            title="New design (Ctrl+Alt+N)"
          >
            ＋ New
          </button>
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
        <span className={["status-pill", error ? "error" : busy || exporting || buildBusy ? "busy" : ""].filter(Boolean).join(" ")}>
          {error
            ? "Needs attention"
            : exporting
              ? "Exporting…"
              : buildBusy
                ? "Finding regions…"
                : readyExportUrl
                  ? "STL ready"
                  : busy
                    ? "Building…"
                    : "Ready"}
        </span>
        <button
          className="export-project-btn"
          onClick={exportCurrentProject}
          title="Save project file (.shapeforge) to computer (Ctrl+S)"
        >
          💾 Save File
        </button>
        <label className="export-quality" title={EXPORT_QUALITY_HINT[exportQuality]}>
          <span>Quality</span>
          <select
            value={exportQuality}
            onChange={(e) => setExportQuality(e.target.value as ExportQuality)}
            disabled={exporting}
            aria-label="STL export quality"
          >
            <option value="draft">Draft</option>
            <option value="standard">Standard</option>
            <option value="fine">Fine</option>
          </select>
        </label>
        <button className="export-btn" onClick={exportSTL} disabled={exporting}>
          {exporting ? "Exporting…" : readyExportUrl ? "Download STL" : "Export STL"}
        </button>
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
            className={toolMode === "face" ? "active" : ""}
            onClick={() => setToolMode("face")}
            title="Select a face to push/pull (F)"
            aria-label="Face tool"
          >
            {/* A cube with its top face picked out — the one face lit against
                two plain ones is what distinguishes "edit a face" from the
                shape library's solid Box icon. */}
            <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 3 20 7.4 12 11.8 4 7.4Z" fill="currentColor" />
              <path d="M4 8.9 11.4 13v7.9L4 16.8Z" fill="currentColor" opacity=".3" />
              <path d="M20 8.9 12.6 13v7.9L20 16.8Z" fill="currentColor" opacity=".45" />
            </svg>
          </button>
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
          <button
            className={toolMode === "build" ? "active" : ""}
            onClick={() => setToolMode("build")}
            title="Shape Builder: combine overlapping shapes region by region (B)"
            aria-label="Shape Builder tool"
            disabled={selectedIds.length < 2}
          >
            <ShapeBuilderIcon />
          </button>
          {/* Not a mode — a toggle on the selection, so it sits below a rule
              rather than in the run of tools that light each other out. */}
          <span className="tool-rail-sep" />
          <button
            className={selectionTransparent ? "active" : ""}
            onClick={toggleTransparency}
            title="Make the selection see-through (T)"
            aria-label="Toggle transparency"
            aria-pressed={selectionTransparent}
            disabled={!selectedIds.length}
          >
            <TransparencyIcon />
          </button>
          <button
            className={wireframe ? "active" : ""}
            onClick={() => setWireframe((v) => !v)}
            title="Show edges only (W)"
            aria-label="Toggle wireframe view"
            aria-pressed={wireframe}
          >
            <WireframeIcon />
          </button>
          {/* An action, not a mode and not a view toggle — its own group. */}
          <span className="tool-rail-sep" />
          <button
            onClick={dropSelected}
            title="Drop onto what is below (D)"
            aria-label="Drop"
            disabled={!selectedIds.length}
          >
            <DropIcon />
          </button>
        </div>
        <Viewport
          parts={parts}
          nodes={nodes}
          selectedIds={selectedIds}
          cameraMode={cameraMode}
          toolMode={toolMode}
          resizeConstrained={resizeConstrained}
          wireframe={wireframe}
          onSceneReady={(scene) => { sceneRef.current = scene; }}
          onCellsChanged={setBuildCells}
          onSelect={onSelect}
          onSelectMany={onSelectMany}
          onTransform={onTransform}
          onAlign={setPositions}
          onDuplicate={onDuplicate}
          onPushPull={pushPullFace}
          onPreviewPushPull={onPreviewPushPull}
          onDragChange={onDragChange}
        />
        {toolMode === "build" && !buildBusy && buildCells.length > 0 && (
          // Finishing has to be visible. Enter alone was not: Esc is the key
          // people reach for to get out of a mode, and Esc throws the session
          // away — so the work looked like it had simply not applied.
          <div className="build-bar">
            <div className="build-regions">
              <span className="build-count">
                <strong>{keptCount}</strong> of {buildCells.length} regions kept
              </span>
              {/* One toggle per region. A region enclosed inside another — the
                  half of a sphere buried in the box around it — has no visible
                  surface to click in the viewport, so this list is the only way
                  to reach it. Hovering highlights it in 3D. */}
              <div className="build-chips">
                {buildCells.map((cell) => (
                  <button
                    key={cell.mask}
                    className={`build-chip ${cell.kept ? "on" : ""}`}
                    onClick={() => sceneRef.current?.setCellKept(cell.mask, !cell.kept)}
                    onMouseEnter={() => sceneRef.current?.previewCell(cell.mask)}
                    onMouseLeave={() => sceneRef.current?.previewCell(null)}
                    title={cell.kept ? "In the shape — click to remove" : "Removed — click to put back"}
                  >
                    {cellLabel(cell.mask)}
                  </button>
                ))}
              </div>
            </div>
            <div className="build-actions">
              <button className="build-cancel" onClick={() => setToolMode("select")}>
                Cancel (Esc)
              </button>
              <button className="build-apply" onClick={commitBuild} disabled={!keptCount}>
                Build shape (Enter)
              </button>
            </div>
          </div>
        )}
        <div className="canvas-help">
          {toolMode === "build"
            ? buildBusy
              ? "Working out the regions…"
              : "Alt-click a region to remove it · Alt-click the same spot again for the region behind it · Right-drag orbit"
            : toolMode === "align"
            ? "Click a dot to align minimum, centre, or maximum · A Align · Esc Select"
            : toolMode === "face"
            ? "Click a flat face, then drag its arrow or type a distance to push/pull · Esc Select · Right-drag orbit"
            : "V Select · F Face · M Move · R Rotate · A Align · T Transparent · W Wireframe · D Drop · Drag an object to move it · Alt-drag duplicate · Shift-drag straight · Right-drag orbit"}
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
          <div className="panel-heading compact">
            <div>
              <h1>Properties</h1>
              <p>{selectedIds.length > 1 ? `Shapes (${selectedIds.length})` : selected ? selected.name : "Nothing selected"}</p>
            </div>
          </div>
          {selected ? (
            <Inspector
              node={selected}
              selectedCount={selectedIds.length}
              error={invalid[selected.id] ?? null}
              onParam={(k, v) => setParam(selected.id, k, v)}
              onTransform={(patch) => setTransform(selected.id, patch)}
              resizeConstrained={resizeConstrained}
              onResizeConstrained={setResizeConstrained}
              onHole={(h) => {
                beginHistoryBatch();
                const ids = selectedIds.length ? selectedIds : (selected ? [selected.id] : []);
                for (const id of ids) setHole(id, h);
                endHistoryBatch();
              }}
              onColor={(c) => {
                beginHistoryBatch();
                const ids = selectedIds.length ? selectedIds : (selected ? [selected.id] : []);
                for (const id of ids) {
                  setColor(id, c);
                  const parent = parentOf(nodes, id);
                  if (parent && isGroup(parent)) {
                    setColor(parent.id, c);
                  }
                }
                endHistoryBatch();
              }}
              onTransparent={applyTransparent}
              onOp={(op) => setGroupOp(selected.id, op)}
              onRename={(n) => rename(selected.id, n)}
              onDelete={removeSelected}
              onPruneDeadOps={onPruneDeadOps}
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

      </aside>

      <ProjectsModal
        isOpen={projectsModalOpen}
        onClose={() => setProjectsModalOpen(false)}
      />
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
