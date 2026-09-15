import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { type AnchorMode, type SketchAnchor, type SketchData, type SketchPath } from "../document/types";
import {
  anchor as makeAnchor,
  breakPath,
  convertAnchor,
  hasHandle,
  linkHandles,
  mergeAnchors,
  insertAnchor,
  isStraight,
  nestingDepths,
  nearestOnCubic,
  pathArea,
  segmentCount,
  segmentCubic,
  sketchBounds,
  type Pt,
} from "../sketch/geometry";
import { fromMillimetres, toMillimetres, UNIT_LABEL, type DisplayUnit } from "../measurement";
import { evaluateMathExpression } from "../utils/mathExpr";

/**
 * Full-screen 2D sketch editor: Bézier paths drawn the way Illustrator draws
 * them, then extruded onto the plane the sketch was started from.
 *
 * Coordinates are millimetres with Y up, the sketch plane's own frame. The
 * canvas is drawn in screen pixels so anchors, handles and strokes keep one
 * size at every zoom.
 */

type Tool = "select" | "direct" | "pen" | "add" | "delete" | "convert" | "scissors";

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Selection", key: "V", hint: "Click a shape to select it, drag to move it. Drag on empty space to select several. Delete removes them." },
  { id: "direct", label: "Direct Selection", key: "A", hint: "Select and drag anchors, handles or curves. A smooth anchor keeps its handles in line; a symmetric one also keeps them equally long. Alt-drag a handle to make it a corner. Arrow keys nudge." },
  { id: "pen", label: "Pen", key: "P", hint: "Click for a corner, drag for a smooth curve. Alt while dragging bends the handle, Shift keeps 45°. Click the first anchor to close; Enter or Esc ends an open path." },
  { id: "add", label: "Add Anchor Point", key: "+", hint: "Click on a path to add an anchor without changing its shape." },
  { id: "delete", label: "Delete Anchor Point", key: "−", hint: "Click an anchor to remove it; the path reconnects around it." },
  { id: "convert", label: "Anchor Point", key: "Shift+C", hint: "Click a smooth anchor to make it a corner. Drag from a corner to pull out smooth handles. Drag a handle to move it on its own." },
  { id: "scissors", label: "Scissors", key: "C", hint: "Click an anchor, or anywhere on a path, to cut it there. The cut leaves two ends on top of each other: drag one away with Direct Selection (A). Close joins them again." },
];

/** Sketch snapping preferences, remembered between sketches and sessions. */
const SNAP_GRID_KEY = "cad.sketchSnapGrid";
const GRID_STEP_KEY = "cad.sketchGridStep";
function readSetting(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writeSetting(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: the setting lasts this session */ }
}

const ANCHOR_PX = 7;
const SNAP_PX = 8;
const ANCHOR_HIT_PX = 8;
const DRAG_START_PX = 3;

interface Selection { paths: Set<string>; anchors: Set<string> }
const keyOf = (pathId: string, index: number) => `${pathId}#${index}`;
const parseKey = (key: string) => {
  const at = key.lastIndexOf("#");
  return { pathId: key.slice(0, at), index: Number(key.slice(at + 1)) };
};
const emptySelection = (): Selection => ({ paths: new Set(), anchors: new Set() });
const newId = () => crypto.randomUUID();

const clonePaths = (paths: SketchPath[]) => paths.map((p) => ({ ...p, anchors: p.anchors.map((a) => ({ ...a })) }));

/** A path with its direction reversed: anchors in the other order, handles swapped. */
function reversed(path: SketchPath): SketchPath {
  return {
    ...path,
    anchors: path.anchors.slice().reverse().map((a) => ({ ...a, inX: a.outX, inY: a.outY, outX: a.inX, outY: a.inY })),
  };
}

/** Removes anchors and reconnects the path across the gap. */
function deleteAnchors(paths: SketchPath[], keys: Set<string>): SketchPath[] {
  const out: SketchPath[] = [];
  for (const path of paths) {
    const anchors = path.anchors.filter((_, i) => !keys.has(keyOf(path.id, i)));
    if (anchors.length === path.anchors.length) { out.push(path); continue; }
    if (anchors.length < 2) continue;
    out.push({ ...path, anchors, closed: path.closed && anchors.length > 2 });
  }
  return out;
}

/** Constrains `p` to the nearest 45° direction from `from`. */
function constrain45(from: Pt, p: Pt): Pt {
  const dx = p[0] - from[0], dy = p[1] - from[1];
  const len = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(angle) * len, from[1] + Math.sin(angle) * len];
}

type Hit =
  | { kind: "anchor"; pathId: string; index: number }
  | { kind: "handle"; pathId: string; index: number; which: "in" | "out" }
  | { kind: "segment"; pathId: string; index: number }
  | { kind: "fill"; pathId: string }
  | { kind: "none" };

type Drag =
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "marquee"; from: Pt; to: Pt; additive: boolean }
  | { kind: "move"; start: Pt; base: SketchPath[]; keys: string[]; grab: { pathId: string; index: number } | null; moved: boolean; sx: number; sy: number }
  | { kind: "handle"; pathId: string; index: number; which: "in" | "out"; base: SketchPath[]; breakOnly: boolean; moved: boolean }
  | { kind: "pull"; pathId: string; index: number; base: SketchPath[]; sx: number; sy: number; moved: boolean; closing: boolean }
  | { kind: "reshape"; pathId: string; index: number; t: number; start: Pt; base: SketchPath[]; moved: boolean };

interface Props {
  title: string;
  applyLabel: string;
  initial: SketchData;
  initialDepth: number;
  /** Model edges in the sketch plane (the face it was started on), shown and snapped to. */
  guides?: [Pt, Pt][];
  displayUnit: DisplayUnit;
  decimals: number;
  onCancel: () => void;
  onApply: (sketch: SketchData, depth: number) => void;
}

export function SketchEditor({ title, applyLabel, initial, initialDepth, guides = [], displayUnit, decimals, onCancel, onApply }: Props) {
  const [paths, setPaths] = useState<SketchPath[]>(() => clonePaths(initial.paths));
  const [depth, setDepth] = useState(initialDepth);
  const [tool, setTool] = useState<Tool>("pen");
  const [selection, setSelection] = useState<Selection>(emptySelection);
  /** The open path the Pen is adding to, if any. */
  const [activePathId, setActivePathId] = useState<string | null>(null);
  const [snapGrid, setSnapGrid] = useState(() => readSetting(SNAP_GRID_KEY, "on") !== "off");
  const [gridStep, setGridStep] = useState(() => {
    const saved = Number(readSetting(GRID_STEP_KEY, "1"));
    return Number.isFinite(saved) && saved > 0 ? saved : 1;
  });
  useEffect(() => writeSetting(SNAP_GRID_KEY, snapGrid ? "on" : "off"), [snapGrid]);
  useEffect(() => writeSetting(GRID_STEP_KEY, String(gridStep)), [gridStep]);
  const [view, setView] = useState({ cx: 0, cy: 0, zoom: 4 });
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [pointer, setPointer] = useState<{ sx: number; sy: number; world: Pt } | null>(null);
  const [hover, setHover] = useState<Hit>({ kind: "none" });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [, setHistoryTick] = useState(0);

  const canvasRef = useRef<HTMLDivElement>(null);
  /** The latest merge action, for the keyboard handler. */
  const mergeRef = useRef<() => void>(() => {});
  const past = useRef<SketchPath[][]>([]);
  const future = useRef<SketchPath[][]>([]);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  const checkpoint = useCallback((snapshot: SketchPath[] = pathsRef.current) => {
    past.current.push(clonePaths(snapshot));
    if (past.current.length > 200) past.current.shift();
    future.current = [];
    setHistoryTick((t) => t + 1);
  }, []);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(clonePaths(pathsRef.current));
    setPaths(previous);
    setSelection(emptySelection());
    setActivePathId(null);
    setHistoryTick((t) => t + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(clonePaths(pathsRef.current));
    setPaths(next);
    setSelection(emptySelection());
    setActivePathId(null);
    setHistoryTick((t) => t + 1);
  }, []);

  // ---- View -------------------------------------------------------------

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const toScreen = useCallback(
    (x: number, y: number): Pt => [(x - view.cx) * view.zoom + size.width / 2, size.height / 2 - (y - view.cy) * view.zoom],
    [view, size],
  );
  const toWorld = useCallback(
    (sx: number, sy: number): Pt => [(sx - size.width / 2) / view.zoom + view.cx, (size.height / 2 - sy) / view.zoom + view.cy],
    [view, size],
  );

  const fitView = useCallback(() => {
    let bounds = sketchBounds({ paths: pathsRef.current });
    if (!bounds && guides.length) {
      // A new sketch on a face opens framed on that face.
      const xs = guides.flatMap(([a, b]) => [a[0], b[0]]), ys = guides.flatMap(([a, b]) => [a[1], b[1]]);
      bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    const el = canvasRef.current;
    const width = el?.clientWidth || size.width, height = el?.clientHeight || size.height;
    if (!bounds) {
      setView({ cx: 0, cy: 0, zoom: Math.min(width, height) / 120 });
      return;
    }
    const w = Math.max(bounds.maxX - bounds.minX, 10), h = Math.max(bounds.maxY - bounds.minY, 10);
    setView({
      cx: (bounds.minX + bounds.maxX) / 2,
      cy: (bounds.minY + bounds.maxY) / 2,
      zoom: Math.min(width / (w * 1.4), height / (h * 1.4)),
    });
  }, [size, guides]);

  const fittedOnce = useRef(false);
  useEffect(() => {
    if (fittedOnce.current || size.width < 10) return;
    fittedOnce.current = true;
    fitView();
  }, [size, fitView]);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    setView((v) => {
      const zoom = Math.min(Math.max(v.zoom * Math.exp(-e.deltaY * 0.0015), 0.02), 2000);
      // Keep the point under the cursor where it is.
      const wx = (sx - rect.width / 2) / v.zoom + v.cx, wy = (rect.height / 2 - sy) / v.zoom + v.cy;
      return { zoom, cx: wx - (sx - rect.width / 2) / zoom, cy: wy - (rect.height / 2 - sy) / zoom };
    });
  }, []);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // ---- Lookup helpers ----------------------------------------------------

  const findPath = (list: SketchPath[], id: string) => list.find((p) => p.id === id);

  /** Paths the Pen may add or delete anchors on: those with anything selected. */
  const isPathSelected = useCallback(
    (id: string) => selection.paths.has(id) || [...selection.anchors].some((k) => parseKey(k).pathId === id),
    [selection],
  );

  const snap = useCallback(
    (p: Pt, options: { from?: Pt | null; shift?: boolean; exclude?: Set<string> } = {}): Pt => {
      if (options.shift && options.from) return constrain45(options.from, p);
      const reach = SNAP_PX / view.zoom;
      let best: Pt | null = null, bestD = reach;
      for (const path of pathsRef.current) {
        path.anchors.forEach((a, i) => {
          if (options.exclude?.has(keyOf(path.id, i))) return;
          const d = Math.hypot(a.x - p[0], a.y - p[1]);
          if (d < bestD) { bestD = d; best = [a.x, a.y]; }
        });
      }
      for (const [ga, gb] of guides) {
        for (const q of [ga, gb]) {
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < bestD) { bestD = d; best = q; }
        }
      }
      if (best) return best;
      if (snapGrid && gridStep > 0) return [Math.round(p[0] / gridStep) * gridStep, Math.round(p[1] / gridStep) * gridStep];
      return p;
    },
    [view.zoom, snapGrid, gridStep, guides],
  );

  const hitFromTarget = (target: EventTarget | null): Hit => {
    const el = (target as Element | null)?.closest?.("[data-hit]") as HTMLElement | SVGElement | null;
    if (!el) return { kind: "none" };
    const kind = el.getAttribute("data-hit");
    const pathId = el.getAttribute("data-path") ?? "";
    const index = Number(el.getAttribute("data-index"));
    if (kind === "anchor") return { kind, pathId, index };
    if (kind === "handle") return { kind, pathId, index, which: el.getAttribute("data-which") === "in" ? "in" : "out" };
    if (kind === "segment") return { kind, pathId, index };
    if (kind === "fill") return { kind, pathId };
    return { kind: "none" };
  };

  /**
   * What is under the pointer. Handles come from the element hit; anchors by
   * distance, so an anchor is caught anywhere within a few pixels rather than
   * only on its 7 px square — a close click that just missed the square used
   * to add an anchor on top of the start instead of closing the path.
   */
  const hitAt = (target: EventTarget | null, sx: number, sy: number): Hit => {
    const element = hitFromTarget(target);
    if (element.kind === "handle") return element;
    let best: Hit = element, bestD = ANCHOR_HIT_PX;
    for (const path of pathsRef.current) {
      path.anchors.forEach((a, index) => {
        const [ax, ay] = toScreen(a.x, a.y);
        const d = Math.hypot(ax - sx, ay - sy);
        if (d <= bestD) { bestD = d; best = { kind: "anchor", pathId: path.id, index }; }
      });
    }
    return best;
  };

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    return { sx, sy, world: toWorld(sx, sy) };
  };

  const finishPath = useCallback(() => {
    if (!activePathId) return;
    const path = findPath(pathsRef.current, activePathId);
    // A lone click leaves a stray point that can never become a shape.
    if (path && path.anchors.length < 2) setPaths((list) => list.filter((p) => p.id !== activePathId));
    setActivePathId(null);
  }, [activePathId]);

  const switchTool = useCallback((next: Tool) => {
    finishPath();
    setTool(next);
  }, [finishPath]);

  // ---- Pointer handling --------------------------------------------------

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const { sx, sy, world } = localPoint(e);
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    if (e.button === 1 || spaceHeld) {
      setDrag({ kind: "pan", sx, sy, cx: view.cx, cy: view.cy });
      return;
    }
    const hit = hitAt(e.target, sx, sy);
    const list = pathsRef.current;

    if (tool === "pen") {
      const active = activePathId ? findPath(list, activePathId) : undefined;
      if (active) {
        const last = active.anchors.length - 1;
        if (hit.kind === "anchor" && hit.pathId === active.id && hit.index === 0 && active.anchors.length > 1) {
          checkpoint();
          setPaths((ps) => ps.map((p) => (p.id === active.id ? { ...p, closed: true } : p)));
          setDrag({ kind: "pull", pathId: active.id, index: 0, base: clonePaths(list), sx, sy, moved: false, closing: true });
          setSelection({ paths: new Set(), anchors: new Set([keyOf(active.id, 0)]) });
          setActivePathId(null);
          return;
        }
        if (hit.kind === "anchor" && hit.pathId === active.id && hit.index === last) {
          // Clicking the last anchor again retracts its forward handle, so
          // the next segment leaves it as a corner.
          checkpoint();
          setPaths((ps) => ps.map((p) => (p.id !== active.id ? p : {
            ...p, anchors: p.anchors.map((a, i) => (i === last ? { ...a, outX: 0, outY: 0, mode: "corner" } : a)),
          })));
          setDrag({ kind: "handle", pathId: active.id, index: last, which: "out", base: clonePaths(list), breakOnly: true, moved: false });
          return;
        }
        if (hit.kind === "anchor" && hit.pathId !== active.id) {
          const other = findPath(list, hit.pathId);
          if (other && !other.closed && (hit.index === 0 || hit.index === other.anchors.length - 1)) {
            // Joining onto the end of another open path makes them one.
            checkpoint();
            const tail = hit.index === 0 ? other : reversed(other);
            setPaths((ps) => ps
              .filter((p) => p.id !== other.id)
              .map((p) => (p.id === active.id ? { ...p, anchors: [...p.anchors, ...tail.anchors.map((a) => ({ ...a }))] } : p)));
            setActivePathId(null);
            setSelection({ paths: new Set([active.id]), anchors: new Set() });
            return;
          }
        }
        const lastAnchor = active.anchors[last];
        const at = snap(world, { from: [lastAnchor.x, lastAnchor.y], shift: e.shiftKey });
        checkpoint();
        const index = active.anchors.length;
        setPaths((ps) => ps.map((p) => (p.id === active.id ? { ...p, anchors: [...p.anchors, makeAnchor(at[0], at[1])] } : p)));
        setSelection({ paths: new Set(), anchors: new Set([keyOf(active.id, index)]) });
        setDrag({ kind: "pull", pathId: active.id, index, base: list, sx, sy, moved: false, closing: false });
        return;
      }

      if (hit.kind === "anchor") {
        const path = findPath(list, hit.pathId)!;
        if (!path.closed && (hit.index === 0 || hit.index === path.anchors.length - 1)) {
          // Continue an open path from whichever end was clicked.
          if (hit.index === 0 && path.anchors.length > 1) {
            checkpoint();
            setPaths((ps) => ps.map((p) => (p.id === path.id ? reversed(p) : p)));
          }
          setActivePathId(path.id);
          setSelection({ paths: new Set(), anchors: new Set([keyOf(path.id, hit.index === 0 ? path.anchors.length - 1 : hit.index)]) });
          return;
        }
        // Clicking any other anchor with the Pen does not delete it (that is
        // the Delete Anchor Point tool's job): a new path starts there.
      }
      if (hit.kind === "segment" && isPathSelected(hit.pathId)) {
        addAnchorAt(hit.pathId, hit.index, world);
        return;
      }
      const at = snap(world);
      const id = newId();
      checkpoint();
      const next = [...list, { id, anchors: [makeAnchor(at[0], at[1])], closed: false }];
      setPaths(next);
      setActivePathId(id);
      setSelection({ paths: new Set(), anchors: new Set([keyOf(id, 0)]) });
      setDrag({ kind: "pull", pathId: id, index: 0, base: next, sx, sy, moved: false, closing: false });
      return;
    }

    if (tool === "scissors") {
      if (hit.kind === "anchor") cutAt(hit.pathId, hit.index);
      else if (hit.kind === "segment") {
        const path = findPath(list, hit.pathId);
        if (!path) return;
        const { t } = nearestOnCubic(segmentCubic(path, hit.index), world);
        cutAt(hit.pathId, hit.index + 1, insertAnchor(path, hit.index, t));
      }
      return;
    }

    if (tool === "add") {
      if (hit.kind === "segment") addAnchorAt(hit.pathId, hit.index, world);
      return;
    }

    if (tool === "delete") {
      if (hit.kind === "anchor") {
        checkpoint();
        setPaths((ps) => deleteAnchors(ps, new Set([keyOf(hit.pathId, hit.index)])));
        setSelection({ paths: new Set([hit.pathId]), anchors: new Set() });
      }
      return;
    }

    if (tool === "convert") {
      if (hit.kind === "handle") {
        setDrag({ kind: "handle", pathId: hit.pathId, index: hit.index, which: hit.which, base: clonePaths(list), breakOnly: true, moved: false });
        return;
      }
      if (hit.kind === "anchor") {
        setSelection({ paths: new Set(), anchors: new Set([keyOf(hit.pathId, hit.index)]) });
        setDrag({ kind: "pull", pathId: hit.pathId, index: hit.index, base: clonePaths(list), sx, sy, moved: false, closing: false });
      }
      return;
    }

    if (tool === "direct") {
      if (hit.kind === "handle") {
        setDrag({ kind: "handle", pathId: hit.pathId, index: hit.index, which: hit.which, base: clonePaths(list), breakOnly: e.altKey, moved: false });
        return;
      }
      if (hit.kind === "anchor") {
        const key = keyOf(hit.pathId, hit.index);
        let keys = new Set(selection.anchors);
        if (e.shiftKey) {
          if (keys.has(key)) { keys.delete(key); setSelection({ paths: new Set(), anchors: keys }); return; }
          keys.add(key);
        } else if (!keys.has(key)) {
          keys = new Set([key]);
        }
        setSelection({ paths: new Set(), anchors: keys });
        setDrag({ kind: "move", start: world, base: clonePaths(list), keys: [...keys], grab: { pathId: hit.pathId, index: hit.index }, moved: false, sx, sy });
        return;
      }
      if (hit.kind === "segment") {
        const path = findPath(list, hit.pathId)!;
        const a = keyOf(path.id, hit.index), b = keyOf(path.id, (hit.index + 1) % path.anchors.length);
        if (!isStraight(path, hit.index) && !e.shiftKey) {
          // Dragging a curve reshapes it through the point that was grabbed.
          const { t } = nearestOnCubic(segmentCubic(path, hit.index), world);
          setSelection({ paths: new Set(), anchors: new Set([a, b]) });
          setDrag({ kind: "reshape", pathId: path.id, index: hit.index, t: Math.min(Math.max(t, 0.12), 0.88), start: world, base: clonePaths(list), moved: false });
          return;
        }
        const keys = e.shiftKey ? new Set([...selection.anchors, a, b]) : new Set([a, b]);
        setSelection({ paths: new Set(), anchors: keys });
        setDrag({ kind: "move", start: world, base: clonePaths(list), keys: [...keys], grab: null, moved: false, sx, sy });
        return;
      }
      if (hit.kind === "fill") {
        const path = findPath(list, hit.pathId)!;
        const keys = new Set(path.anchors.map((_, i) => keyOf(path.id, i)));
        setSelection({ paths: new Set(), anchors: keys });
        setDrag({ kind: "move", start: world, base: clonePaths(list), keys: [...keys], grab: null, moved: false, sx, sy });
        return;
      }
      if (!e.shiftKey) setSelection(emptySelection());
      setDrag({ kind: "marquee", from: world, to: world, additive: e.shiftKey });
      return;
    }

    // Selection tool: whole paths.
    if (hit.kind !== "none") {
      const id = hit.pathId;
      let ids = new Set(selection.paths);
      if (e.shiftKey) {
        if (ids.has(id)) { ids.delete(id); setSelection({ paths: ids, anchors: new Set() }); return; }
        ids.add(id);
      } else if (!ids.has(id)) {
        ids = new Set([id]);
      }
      setSelection({ paths: ids, anchors: new Set() });
      const keys = list.filter((p) => ids.has(p.id)).flatMap((p) => p.anchors.map((_, i) => keyOf(p.id, i)));
      setDrag({ kind: "move", start: world, base: clonePaths(list), keys, grab: { pathId: id, index: 0 }, moved: false, sx, sy });
      return;
    }
    if (!e.shiftKey) setSelection(emptySelection());
    setDrag({ kind: "marquee", from: world, to: world, additive: e.shiftKey });
  };

  const addAnchorAt = (pathId: string, index: number, world: Pt) => {
    const path = findPath(pathsRef.current, pathId);
    if (!path) return;
    const { t } = nearestOnCubic(segmentCubic(path, index), world);
    checkpoint();
    setPaths((ps) => ps.map((p) => (p.id === pathId ? insertAnchor(p, index, t) : p)));
    setSelection({ paths: new Set(), anchors: new Set([keyOf(pathId, index + 1)]) });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { sx, sy, world } = localPoint(e);
    setPointer({ sx, sy, world });
    if (!drag) {
      setHover(hitAt(e.target, sx, sy));
      return;
    }
    switch (drag.kind) {
      case "pan":
        setView((v) => ({ ...v, cx: drag.cx - (sx - drag.sx) / v.zoom, cy: drag.cy + (sy - drag.sy) / v.zoom }));
        return;
      case "marquee":
        setDrag({ ...drag, to: world });
        return;
      case "move": {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < DRAG_START_PX) return;
        if (!drag.moved) checkpoint(drag.base);
        let dx = world[0] - drag.start[0], dy = world[1] - drag.start[1];
        if (e.shiftKey) {
          const c = constrain45([0, 0], [dx, dy]);
          dx = c[0]; dy = c[1];
        } else if (drag.grab) {
          const grabbed = findPath(drag.base, drag.grab.pathId)!.anchors[drag.grab.index];
          const target = snap([grabbed.x + dx, grabbed.y + dy], { exclude: new Set(drag.keys) });
          dx = target[0] - grabbed.x; dy = target[1] - grabbed.y;
        }
        const keys = new Set(drag.keys);
        setPaths(drag.base.map((p) => ({
          ...p,
          anchors: p.anchors.map((a, i) => (keys.has(keyOf(p.id, i)) ? { ...a, x: a.x + dx, y: a.y + dy } : a)),
        })));
        if (!drag.moved) setDrag({ ...drag, moved: true });
        return;
      }
      case "handle": {
        if (!drag.moved) checkpoint(drag.base);
        const basePath = findPath(drag.base, drag.pathId)!;
        const a = basePath.anchors[drag.index];
        let target: Pt = world;
        if (e.shiftKey) target = constrain45([a.x, a.y], world);
        const hx = target[0] - a.x, hy = target[1] - a.y;
        const breakIt = drag.breakOnly || e.altKey;
        setPaths(drag.base.map((p) => {
          if (p.id !== drag.pathId) return p;
          return {
            ...p,
            anchors: p.anchors.map((b, i) => {
              if (i !== drag.index) return b;
              const next = { ...b };
              if (drag.which === "out") { next.outX = hx; next.outY = hy; } else { next.inX = hx; next.inY = hy; }
              if (breakIt) return { ...next, mode: "corner" as const };
              return linkHandles(next, drag.which);
            }),
          };
        }));
        if (!drag.moved) setDrag({ ...drag, moved: true });
        return;
      }
      case "pull": {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < DRAG_START_PX) return;
        if (!drag.moved && tool === "convert") checkpoint(drag.base);
        const basePath = findPath(pathsRef.current, drag.pathId) ?? findPath(drag.base, drag.pathId)!;
        const a = basePath.anchors[drag.index];
        let target: Pt = world;
        if (e.shiftKey) target = constrain45([a.x, a.y], world);
        const hx = target[0] - a.x, hy = target[1] - a.y;
        // Alt bends the anchor: only the handle that shapes the segment being
        // drawn moves — the outgoing one normally, the incoming one on closing.
        const alt = e.altKey;
        setPaths((ps) => ps.map((p) => (p.id !== drag.pathId ? p : {
          ...p,
          anchors: p.anchors.map((b, i) => {
            if (i !== drag.index) return b;
            if (alt && drag.closing) return { ...b, inX: -hx, inY: -hy, mode: "corner" as const };
            if (alt) return { ...b, outX: hx, outY: hy, mode: "corner" as const };
            // Dragged-out handles start equal; a symmetric anchor stays so,
            // anything else becomes smooth, as in Illustrator.
            return { ...b, outX: hx, outY: hy, inX: -hx, inY: -hy, mode: b.mode === "symmetric" ? "symmetric" as const : "smooth" as const };
          }),
        })));
        if (!drag.moved) setDrag({ ...drag, moved: true });
        return;
      }
      case "reshape": {
        if (!drag.moved) checkpoint(drag.base);
        const t = drag.t, u = 1 - t;
        // Moving both handles by the same vector moves B(t) by 3ut of it.
        const k = 1 / (3 * u * t);
        const mx = (world[0] - drag.start[0]) * k, my = (world[1] - drag.start[1]) * k;
        setPaths(drag.base.map((p) => {
          if (p.id !== drag.pathId) return p;
          const n = p.anchors.length;
          const j = (drag.index + 1) % n;
          const anchors = p.anchors.map((b) => ({ ...b }));
          const a = anchors[drag.index], b = anchors[j];
          a.outX += mx; a.outY += my;
          b.inX += mx; b.inY += my;
          anchors[drag.index] = linkHandles(a, "out");
          anchors[j] = linkHandles(anchors[j], "in");
          return { ...p, anchors };
        }));
        if (!drag.moved) setDrag({ ...drag, moved: true });
        return;
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag;
    setDrag(null);
    if (!current) return;
    if (current.kind === "marquee") {
      const minX = Math.min(current.from[0], current.to[0]), maxX = Math.max(current.from[0], current.to[0]);
      const minY = Math.min(current.from[1], current.to[1]), maxY = Math.max(current.from[1], current.to[1]);
      const inside = (a: SketchAnchor) => a.x >= minX && a.x <= maxX && a.y >= minY && a.y <= maxY;
      if (tool === "direct") {
        const keys = new Set(current.additive ? selection.anchors : []);
        for (const p of pathsRef.current) p.anchors.forEach((a, i) => { if (inside(a)) keys.add(keyOf(p.id, i)); });
        setSelection({ paths: new Set(), anchors: keys });
      } else {
        const ids = new Set(current.additive ? selection.paths : []);
        for (const p of pathsRef.current) if (p.anchors.some(inside)) ids.add(p.id);
        setSelection({ paths: ids, anchors: new Set() });
      }
    }
    if (current.kind === "pull" && tool === "convert" && !current.moved) {
      // A click with the Anchor Point tool turns a smooth anchor into a corner.
      const path = findPath(pathsRef.current, current.pathId);
      const a = path?.anchors[current.index];
      if (a && (hasHandle(a.inX, a.inY) || hasHandle(a.outX, a.outY))) {
        checkpoint();
        setPaths((ps) => ps.map((p) => (p.id !== current.pathId ? p : {
          ...p, anchors: p.anchors.map((b, i) => (i === current.index ? { ...b, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" as const } : b)),
        })));
      }
    }
    (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
  };

  // ---- Keyboard ------------------------------------------------------------

  const nudge = useCallback((dx: number, dy: number) => {
    const keys = new Set(selection.anchors);
    for (const p of pathsRef.current) if (selection.paths.has(p.id)) p.anchors.forEach((_, i) => keys.add(keyOf(p.id, i)));
    if (!keys.size) return;
    checkpoint();
    setPaths((ps) => ps.map((p) => ({
      ...p, anchors: p.anchors.map((a, i) => (keys.has(keyOf(p.id, i)) ? { ...a, x: a.x + dx, y: a.y + dy } : a)),
    })));
  }, [selection, checkpoint]);

  const deleteSelection = useCallback(() => {
    if (selection.paths.size) {
      checkpoint();
      setPaths((ps) => ps.filter((p) => !selection.paths.has(p.id)));
    } else if (selection.anchors.size) {
      checkpoint();
      setPaths((ps) => deleteAnchors(ps, selection.anchors));
    }
    setSelection(emptySelection());
  }, [selection, checkpoint]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      // The editor owns the keyboard while open: Delete must not remove the
      // selected 3D object behind it, nor V or A switch the app's tools.
      e.stopPropagation();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); mergeRef.current(); return; }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if (tool === "direct") setSelection({ paths: new Set(), anchors: new Set(pathsRef.current.flatMap((p) => p.anchors.map((_, i) => keyOf(p.id, i)))) });
        else { finishPath(); setTool("select"); setSelection({ paths: new Set(pathsRef.current.map((p) => p.id)), anchors: new Set() }); }
        return;
      }
      if (e.key === " ") { e.preventDefault(); setSpaceHeld(true); return; }
      if (e.key === "Escape") {
        e.preventDefault();
        if (activePathId) finishPath();
        else setSelection(emptySelection());
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); finishPath(); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (activePathId) {
          const path = findPath(pathsRef.current, activePathId);
          if (!path) return;
          checkpoint();
          if (path.anchors.length <= 1) {
            setPaths((ps) => ps.filter((p) => p.id !== activePathId));
            setActivePathId(null);
          } else {
            setPaths((ps) => ps.map((p) => (p.id === activePathId ? { ...p, anchors: p.anchors.slice(0, -1) } : p)));
          }
          return;
        }
        deleteSelection();
        return;
      }
      const arrows: Record<string, Pt> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (arrows[e.key]) {
        e.preventDefault();
        const step = (snapGrid ? gridStep : 0.1) * (e.shiftKey ? 10 : 1);
        nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
        return;
      }
      if (mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "c" && e.shiftKey) switchTool("convert");
      else if (key === "c") switchTool("scissors");
      else if (key === "v") switchTool("select");
      else if (key === "a") switchTool("direct");
      else if (key === "p") switchTool("pen");
      else if (e.key === "+" || e.key === "=") switchTool("add");
      else if (e.key === "-" || e.key === "_") switchTool("delete");
      else if (key === "f") fitView();
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === " ") setSpaceHeld(false); };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [tool, activePathId, undo, redo, finishPath, switchTool, deleteSelection, nudge, snapGrid, gridStep, fitView]);

  // ---- Derived -------------------------------------------------------------

  const closedCount = paths.filter((p) => p.closed).length;
  const openCount = paths.length - closedCount;

  const selectedAnchors = useMemo(() => {
    const out: { key: string; path: SketchPath; index: number; anchor: SketchAnchor }[] = [];
    for (const key of selection.anchors) {
      const { pathId, index } = parseKey(key);
      const path = paths.find((p) => p.id === pathId);
      if (path?.anchors[index]) out.push({ key, path, index, anchor: path.anchors[index] });
    }
    return out;
  }, [selection, paths]);

  const selectedPathIds = useMemo(() => {
    const ids = new Set(selection.paths);
    for (const s of selectedAnchors) ids.add(s.path.id);
    return ids;
  }, [selection, selectedAnchors]);

  const setAnchorMode = (mode: AnchorMode) => {
    if (!selectedAnchors.length) return;
    checkpoint();
    const keys = new Set(selectedAnchors.map((s) => s.key));
    setPaths((ps) => ps.map((p) => ({
      ...p,
      anchors: p.anchors.map((a, i) => (keys.has(keyOf(p.id, i)) ? convertAnchor(p, i, mode) : a)),
    })));
  };

  const setAnchorCoordinate = (axis: "x" | "y", mm: number) => {
    if (selectedAnchors.length !== 1) return;
    const { path, index } = selectedAnchors[0];
    checkpoint();
    setPaths((ps) => ps.map((p) => (p.id !== path.id ? p : {
      ...p, anchors: p.anchors.map((a, i) => (i === index ? { ...a, [axis]: mm } : a)),
    })));
  };

  /** Cuts one path at an anchor; `path` overrides the stored one (a Scissors
   *  click on a segment first adds the anchor it cuts at). */
  const cutAt = (pathId: string, index: number, path?: SketchPath) => {
    const source = path ?? findPath(pathsRef.current, pathId);
    if (!source) return;
    const pieces = breakPath(source, [index], newId);
    if (pieces.length === 1 && pieces[0] === source) return;
    checkpoint();
    setPaths((ps) => ps.flatMap((p) => (p.id === pathId ? pieces : [p])));
    setSelection({ paths: new Set(pieces.map((p) => p.id)), anchors: new Set() });
    if (activePathId === pathId) setActivePathId(null);
  };

  const breakSelected = () => {
    const byPath = new Map<string, number[]>();
    for (const s of selectedAnchors) byPath.set(s.path.id, [...(byPath.get(s.path.id) ?? []), s.index]);
    if (!byPath.size) return;
    checkpoint();
    setPaths((ps) => ps.flatMap((p) => {
      const cuts = byPath.get(p.id);
      if (!cuts) return [p];
      const pieces = breakPath(p, cuts, newId);
      return pieces;
    }));
    setSelection(emptySelection());
  };
  /** The merge the two selected anchors allow, if they allow one. */
  const mergePlan = selectedAnchors.length === 2
    ? mergeAnchors(paths, { pathId: selectedAnchors[0].path.id, index: selectedAnchors[0].index }, { pathId: selectedAnchors[1].path.id, index: selectedAnchors[1].index })
    : null;
  const mergeSelected = () => {
    if (selectedAnchors.length !== 2) return;
    const plan = mergeAnchors(pathsRef.current,
      { pathId: selectedAnchors[0].path.id, index: selectedAnchors[0].index },
      { pathId: selectedAnchors[1].path.id, index: selectedAnchors[1].index });
    if (!plan) return;
    checkpoint();
    setPaths(plan.paths);
    setSelection({ paths: new Set(), anchors: new Set([keyOf(plan.merged.pathId, plan.merged.index)]) });
    setActivePathId(null);
  };
  mergeRef.current = mergeSelected;
  /** Selected anchors that a cut would change: not the loose ends of an open path. */
  const breakable = selectedAnchors.some((s) => s.path.closed || (s.index > 0 && s.index < s.path.anchors.length - 1));

  const setPathsClosed = (closed: boolean) => {
    checkpoint();
    setPaths((ps) => ps.map((p) => {
      if (!selectedPathIds.has(p.id) || p.anchors.length < 2) return p;
      const first = p.anchors[0], last = p.anchors[p.anchors.length - 1];
      // Ends left on top of each other by a cut join back into one anchor.
      if (closed && p.anchors.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) {
        const anchors = p.anchors.slice(0, -1);
        anchors[0] = { ...first, inX: last.inX, inY: last.inY };
        return { ...p, anchors, closed };
      }
      return p.anchors.length > 2 ? { ...p, closed } : p;
    }));
    if (activePathId && selectedPathIds.has(activePathId)) setActivePathId(null);
  };

  // ---- Render --------------------------------------------------------------

  const screenPathData = (path: SketchPath, closeIt = path.closed) => {
    if (!path.anchors.length) return "";
    const f = (v: number) => v.toFixed(2);
    const [x0, y0] = toScreen(path.anchors[0].x, path.anchors[0].y);
    let d = `M${f(x0)} ${f(y0)}`;
    const count = closeIt ? path.anchors.length : path.anchors.length - 1;
    for (let i = 0; i < count && path.anchors.length > 1; i++) {
      const [, c1, c2, p1] = segmentCubic(path, i);
      const s1 = toScreen(...c1), s2 = toScreen(...c2), e1 = toScreen(...p1);
      d += ` C${f(s1[0])} ${f(s1[1])} ${f(s2[0])} ${f(s2[1])} ${f(e1[0])} ${f(e1[1])}`;
    }
    return closeIt ? `${d} Z` : d;
  };

  const segmentData = (path: SketchPath, index: number) => {
    const [p0, c1, c2, p1] = segmentCubic(path, index).map((p) => toScreen(p[0], p[1]));
    return `M${p0[0]} ${p0[1]} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p1[0]} ${p1[1]}`;
  };

  // Grid: the finest 1-2-5 step that stays at least 8 px apart.
  const grid = useMemo(() => {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const minor = steps.find((s) => s * view.zoom >= 8) ?? 5000;
    const major = minor * (String(minor).startsWith("2") ? 5 : 10);
    const [x0, y1] = toWorld(0, 0), [x1, y0] = toWorld(size.width, size.height);
    const lines: { d: string; kind: "minor" | "major" | "axis" }[] = [];
    const push = (kind: "minor" | "major" | "axis", horizontal: boolean, v: number) => {
      if (horizontal) { const sy = toScreen(0, v)[1]; lines.push({ kind, d: `M0 ${sy} H${size.width}` }); }
      else { const sx = toScreen(v, 0)[0]; lines.push({ kind, d: `M${sx} 0 V${size.height}` }); }
    };
    const kindOf = (v: number) => (Math.abs(v) < minor / 2 ? "axis" : Math.abs(v / major - Math.round(v / major)) < 1e-6 ? "major" : "minor");
    for (let v = Math.ceil(x0 / minor) * minor; v <= x1; v += minor) push(kindOf(v), false, v);
    for (let v = Math.ceil(y0 / minor) * minor; v <= y1; v += minor) push(kindOf(v), true, v);
    return { lines, major };
  }, [view, size, toScreen, toWorld]);

  const active = activePathId ? paths.find((p) => p.id === activePathId) : undefined;
  let rubberBand: string | null = null;
  let closeHint = false;
  if (tool === "pen" && active && pointer && !drag && !spaceHeld) {
    const last = active.anchors[active.anchors.length - 1];
    const first = active.anchors[0];
    closeHint = hover.kind === "anchor" && hover.pathId === active.id && hover.index === 0 && active.anchors.length > 1;
    const target = closeHint ? ([first.x, first.y] as Pt) : snap(pointer.world, { from: [last.x, last.y], shift: false });
    const c1 = toScreen(last.x + last.outX, last.y + last.outY);
    const c2 = closeHint ? toScreen(first.x + first.inX, first.y + first.inY) : toScreen(...target);
    const p0 = toScreen(last.x, last.y), p1 = toScreen(...target);
    rubberBand = `M${p0[0]} ${p0[1]} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p1[0]} ${p1[1]}`;
  }

  let cursorHint = "";
  if (tool === "pen" && !drag) {
    if (closeHint) cursorHint = "Close path";
    else if (!active && hover.kind === "anchor") {
      const path = paths.find((p) => p.id === hover.pathId);
      if (path && !path.closed && (hover.index === 0 || hover.index === path.anchors.length - 1)) cursorHint = "Continue path";
    } else if (active && hover.kind === "anchor" && hover.pathId !== active.id) {
      const path = paths.find((p) => p.id === hover.pathId);
      if (path && !path.closed && (hover.index === 0 || hover.index === path.anchors.length - 1)) cursorHint = "Join paths";
    } else if (!active && hover.kind === "segment" && isPathSelected(hover.pathId)) cursorHint = "Add anchor";
  } else if (tool === "add" && hover.kind === "segment") cursorHint = "Add anchor";
  else if (tool === "scissors" && (hover.kind === "segment" || hover.kind === "anchor")) cursorHint = "Cut path here";
  else if (tool === "delete" && hover.kind === "anchor") cursorHint = "Delete anchor";

  // Where a click would add (or cut at) an anchor, shown on the path under the
  // pointer before clicking: the nearest point on the curve, the same point
  // the click uses.
  let insertPreview: Pt | null = null;
  const adds = tool === "add" || tool === "scissors" || (tool === "pen" && !active && hover.kind === "segment" && isPathSelected(hover.pathId));
  if (adds && hover.kind === "segment" && pointer && !drag && !spaceHeld) {
    const path = paths.find((p) => p.id === hover.pathId);
    if (path && hover.index < segmentCount(path)) insertPreview = nearestOnCubic(segmentCubic(path, hover.index), pointer.world).point;
  }

  const cursor = spaceHeld || drag?.kind === "pan" ? (drag ? "grabbing" : "grab") : tool === "select" || tool === "direct" ? "default" : "crosshair";

  // Handles shown: on selected anchors and on the anchor the Pen is drawing from.
  const handleAnchors = new Set(selection.anchors);
  if (active && active.anchors.length) handleAnchors.add(keyOf(active.id, active.anchors.length - 1));

  const shown = (mm: number) => +fromMillimetres(mm, displayUnit).toFixed(decimals);
  const unit = UNIT_LABEL[displayUnit];
  const single = selectedAnchors.length === 1 ? selectedAnchors[0] : null;
  const allMode = (mode: AnchorMode) => selectedAnchors.length > 0 && selectedAnchors.every((s) => s.anchor.mode === mode);
  const selectedPaths = paths.filter((p) => selectedPathIds.has(p.id));
  const depths = useMemo(() => nestingDepths(paths), [paths]);
  const shapeCount = depths.filter((d, i) => d >= 0 && d % 2 === 0 && Math.abs(pathArea(paths[i])) > 1e-9).length;
  const holeCount = depths.filter((d) => d > 0 && d % 2 === 1).length;
  // One compound fill, each path wound by whether it is solid or a hole, so
  // the canvas shows exactly what gets extruded: nested paths cut, while
  // overlapping ones merge (nonzero winding) as they do in the solid.
  const compoundFill = paths.map((path, i) => {
    if (depths[i] < 0) return "";
    const solid = depths[i] % 2 === 0;
    return screenPathData(solid === pathArea(path) > 0 ? path : reversed(path));
  }).join(" ");

  return (
    <div className="sketch-editor" role="dialog" aria-modal="true" aria-label={title}>
      <header className="sketch-header">
        <div className="sketch-title">
          <strong>{title}</strong>
          <span>Draw closed shapes, then extrude them. A shape inside another becomes a hole.</span>
        </div>
        <div className="sketch-header-actions">
          <button type="button" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">Undo</button>
          <button type="button" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Shift+Z)">Redo</button>
          <button type="button" onClick={fitView} title="Fit the drawing in view (F)">Fit</button>
          <span className="sketch-header-sep" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!closedCount}
            title={closedCount ? undefined : "Close at least one path to extrude it"}
            onClick={() => { finishPath(); onApply({ paths: pathsRef.current.filter((p) => p.anchors.length > 1) }, depth); }}
          >{applyLabel}</button>
        </div>
      </header>

      <div className="sketch-body">
        <nav className="sketch-tools" aria-label="Sketch tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tool === t.id ? "active" : ""}
              onClick={() => switchTool(t.id)}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
            >
              <ToolGlyph tool={t.id} />
            </button>
          ))}
        </nav>

        <div
          ref={canvasRef}
          className="sketch-canvas"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { if (!drag) setPointer(null); }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg width={size.width} height={size.height}>
            <g className="sketch-grid">
              {grid.lines.map((l, i) => <path key={i} d={l.d} className={l.kind} />)}
            </g>
            <g className="sketch-guides">
              {guides.map(([a, b], i) => {
                const [x1, y1] = toScreen(a[0], a[1]), [x2, y2] = toScreen(b[0], b[1]);
                return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
              })}
            </g>
            <OriginMarker at={toScreen(0, 0)} />

            <path d={compoundFill} className="sketch-fill-visual" fillRule="nonzero" pointerEvents="none" />
            {paths.map((path) => (
              <g key={path.id} className={`sketch-path ${selectedPathIds.has(path.id) ? "selected" : ""} ${path.closed ? "closed" : "open"}`}>
                {path.closed && (
                  <path d={screenPathData(path)} className="sketch-fill" data-hit="fill" data-path={path.id} />
                )}
                <path d={screenPathData(path)} className="sketch-stroke" />
                {Array.from({ length: segmentCount(path) }, (_, i) => (
                  <path key={i} d={segmentData(path, i)} className="sketch-segment-hit" data-hit="segment" data-path={path.id} data-index={i} />
                ))}
              </g>
            ))}

            {rubberBand && <path d={rubberBand} className="sketch-rubber" />}
            {insertPreview && (() => {
              const [px, py] = toScreen(insertPreview[0], insertPreview[1]);
              return tool === "scissors"
                ? <path d={`M${px - 5} ${py - 5} L${px + 5} ${py + 5} M${px + 5} ${py - 5} L${px - 5} ${py + 5}`} className="sketch-insert-preview cut" />
                : <rect x={px - ANCHOR_PX / 2} y={py - ANCHOR_PX / 2} width={ANCHOR_PX} height={ANCHOR_PX} className="sketch-insert-preview" />;
            })()}

            {paths.map((path) => path.anchors.map((a, i) => {
              if (!handleAnchors.has(keyOf(path.id, i))) return null;
              const [ax, ay] = toScreen(a.x, a.y);
              const handles: ReactNode[] = [];
              for (const which of ["in", "out"] as const) {
                const hx = which === "in" ? a.inX : a.outX, hy = which === "in" ? a.inY : a.outY;
                if (!hasHandle(hx, hy)) continue;
                const [sx, sy] = toScreen(a.x + hx, a.y + hy);
                handles.push(
                  <g key={which}>
                    <line x1={ax} y1={ay} x2={sx} y2={sy} className="sketch-handle-line" />
                    <circle cx={sx} cy={sy} r={4} className="sketch-handle" data-hit="handle" data-path={path.id} data-index={i} data-which={which} />
                  </g>,
                );
              }
              return <g key={`${path.id}-h${i}`}>{handles}</g>;
            }))}

            {paths.map((path) => path.anchors.map((a, i) => {
              const [ax, ay] = toScreen(a.x, a.y);
              const selected = selection.anchors.has(keyOf(path.id, i)) || selection.paths.has(path.id);
              const isStart = !path.closed && i === 0 && path.id === activePathId;
              return (
                <rect
                  key={`${path.id}-a${i}`}
                  x={ax - ANCHOR_PX / 2}
                  y={ay - ANCHOR_PX / 2}
                  width={ANCHOR_PX}
                  height={ANCHOR_PX}
                  className={`sketch-anchor ${selected ? "selected" : ""} ${isStart ? "start" : ""} ${a.mode}`}
                  data-hit="anchor"
                  data-path={path.id}
                  data-index={i}
                />
              );
            }))}

            {drag?.kind === "marquee" && (() => {
              const [x0, y0] = toScreen(...drag.from), [x1, y1] = toScreen(...drag.to);
              return <rect x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} className="sketch-marquee" />;
            })()}
          </svg>

          {cursorHint && pointer && (
            <div className="sketch-cursor-hint" style={{ left: pointer.sx + 14, top: pointer.sy + 14 }}>{cursorHint}</div>
          )}
          <div className="sketch-readout">
            {pointer ? `X ${shown(pointer.world[0])}  Y ${shown(pointer.world[1])} ${unit}` : ""}
            <span>Grid {shown(grid.major)} {unit} · Wheel zooms · Space or middle-drag pans</span>
          </div>
        </div>

        <aside className="sketch-panel">
          <section className="sketch-section">
            <div className="field-label">{TOOLS.find((t) => t.id === tool)!.label} tool</div>
            <p className="sketch-hint">{TOOLS.find((t) => t.id === tool)!.hint}</p>
          </section>

          <section className="sketch-section">
            <div className="field-label">Anchor {selectedAnchors.length > 1 ? `(${selectedAnchors.length})` : ""}</div>
            {single ? (
              <div className="sketch-xy">
                <LengthInput label="X" axis={0} valueMm={single.anchor.x} unit={displayUnit} decimals={decimals} onCommit={(mm) => setAnchorCoordinate("x", mm)} />
                <LengthInput label="Y" axis={1} valueMm={single.anchor.y} unit={displayUnit} decimals={decimals} onCommit={(mm) => setAnchorCoordinate("y", mm)} />
              </div>
            ) : (
              <p className="sketch-hint">{selectedAnchors.length ? "Several anchors selected." : "Select an anchor with the Direct Selection tool (A)."}</p>
            )}
            <div className="sketch-segmented" role="group" aria-label="Anchor type">
              <button type="button" className={`sketch-icon-button ${allMode("corner") ? "active" : ""}`} disabled={!selectedAnchors.length} onClick={() => setAnchorMode("corner")} title="Corner: handles move independently">
                <AnchorGlyph kind="corner" /><span>Corner</span>
              </button>
              <button type="button" className={`sketch-icon-button ${allMode("smooth") ? "active" : ""}`} disabled={!selectedAnchors.length} onClick={() => setAnchorMode("smooth")} title="Smooth: handles stay in line, each with its own length">
                <AnchorGlyph kind="smooth" /><span>Smooth</span>
              </button>
              <button type="button" className={`sketch-icon-button ${allMode("symmetric") ? "active" : ""}`} disabled={!selectedAnchors.length} onClick={() => setAnchorMode("symmetric")} title="Symmetric: handles stay in line and equally long">
                <AnchorGlyph kind="symmetric" /><span>Symmetric</span>
              </button>
            </div>
            <div className="sketch-segmented" role="group" aria-label="Anchor actions">
              <button
                type="button"
                className="sketch-icon-button"
                disabled={!breakable}
                onClick={breakSelected}
                title="Break: cut the path at the selected anchor, leaving two ends you can drag apart (Scissors tool: C)"
              ><AnchorGlyph kind="break" /><span>Break</span></button>
              <button
                type="button"
                className="sketch-icon-button"
                disabled={!mergePlan}
                onClick={mergeSelected}
                title="Merge: snap the two selected anchors together into one (Ctrl+J)"
              ><AnchorGlyph kind="merge" /><span>Merge</span></button>
            </div>
            {selectedAnchors.length === 2 && !mergePlan && (
              <p className="sketch-hint">These two can't merge: pick neighbouring anchors, or the ends of open paths.</p>
            )}
            {selectedAnchors.length < 2 && (
              <p className="sketch-hint">Shift-click a second anchor to merge two into one.</p>
            )}
          </section>

          <section className="sketch-section">
            <div className="field-label">Path</div>
            {selectedPaths.length ? (
              <>
                <p className="sketch-hint">
                  {selectedPaths.length === 1
                    ? `${selectedPaths[0].anchors.length} anchors · ${selectedPaths[0].closed ? "closed" : "open"}`
                    : `${selectedPaths.length} paths`}
                </p>
                <div className="sketch-segmented">
                  <button type="button" disabled={selectedPaths.every((p) => p.closed || p.anchors.length < 3)} onClick={() => setPathsClosed(true)}>Close</button>
                  <button type="button" onClick={() => { checkpoint(); setPaths((ps) => ps.filter((p) => !selectedPathIds.has(p.id))); setSelection(emptySelection()); setActivePathId(null); }}>Delete</button>
                </div>
              </>
            ) : (
              <p className="sketch-hint">No path selected.</p>
            )}
          </section>

          <section className="sketch-section">
            <div className="field-label">Snapping</div>
            <label className="sketch-check">
              <input type="checkbox" checked={snapGrid} onChange={(e) => setSnapGrid(e.target.checked)} />
              Snap to grid
            </label>
            <LengthInput label="Grid" valueMm={gridStep} unit={displayUnit} decimals={decimals} min={0.01} onCommit={(mm) => setGridStep(mm)} />
            <p className="sketch-hint">Anchors always snap to other anchors{guides.length ? " and to the corners of the face you picked (grey)" : ""}. Hold Shift for 45° angles.</p>
          </section>

          <section className="sketch-section sketch-extrude">
            <div className="field-label">Extrude</div>
            <LengthInput label="Height" axis={2} valueMm={depth} unit={displayUnit} decimals={decimals} min={0.01} onCommit={(mm) => setDepth(mm)} />
            <p className="sketch-hint">
              {closedCount
                ? `${shapeCount} ${shapeCount === 1 ? "shape" : "shapes"}${holeCount ? ` with ${holeCount} ${holeCount === 1 ? "hole" : "holes"}` : ""} will be extruded${openCount ? `; ${openCount} open ${openCount === 1 ? "path is" : "paths are"} ignored` : ""}.`
                : "Close a path to extrude it: click its first anchor with the Pen."}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** A length field in the display unit that accepts arithmetic, committing on Enter or blur. */
function LengthInput({ label, valueMm, unit, decimals, min, axis, onCommit }: {
  label: string; valueMm: number; unit: DisplayUnit; decimals: number; min?: number; axis?: 0 | 1 | 2;
  onCommit: (mm: number) => void;
}) {
  const format = useCallback((mm: number) => String(+fromMillimetres(mm, unit).toFixed(decimals)), [unit, decimals]);
  const [text, setText] = useState(() => format(valueMm));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(format(valueMm)); }, [valueMm, focused, format]);
  const commit = () => {
    const value = evaluateMathExpression(text);
    if (value === null || !Number.isFinite(value)) { setText(format(valueMm)); return; }
    const mm = toMillimetres(value, unit);
    if (min !== undefined && mm < min) { setText(format(valueMm)); return; }
    if (Math.abs(mm - valueMm) > 1e-9) onCommit(mm);
  };
  return (
    <label className={`sketch-length ${axis !== undefined ? `axis-${axis}` : ""}`}>
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onFocus={(e) => { setFocused(true); e.currentTarget.select(); }}
        onBlur={() => { setFocused(false); commit(); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
          if (e.key === "Escape") { setText(format(valueMm)); (e.target as HTMLInputElement).blur(); }
        }}
      />
      <span className="sketch-unit">{UNIT_LABEL[unit]}</span>
    </label>
  );
}

/** Icons for the anchor type and anchor action buttons. */
function AnchorGlyph({ kind }: { kind: AnchorMode | "break" | "merge" }) {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const knob = { fill: "#fff", stroke: "currentColor", strokeWidth: 1.3 };
  const node = (x: number, y: number) => <rect x={x - 2.2} y={y - 2.2} width={4.4} height={4.4} fill="currentColor" />;
  let body: ReactNode;
  switch (kind) {
    case "corner":
      // Two straight sides meeting at a sharp point.
      body = <><path d="M3 19L12 6l9 13" {...line} />{node(12, 6)}</>;
      break;
    case "smooth":
      // A curve through the anchor; handles in line but of different lengths.
      body = (
        <>
          <path d="M3 19C4 10 8 8 12 8s8 2 9 11" {...line} />
          <path d="M5 8h13" {...line} strokeWidth={1} />
          <circle cx="5" cy="8" r="1.6" {...knob} />
          <circle cx="18" cy="8" r="1.6" {...knob} />
          {node(10.5, 8)}
        </>
      );
      break;
    case "symmetric":
      // The same curve; handles in line and equally long.
      body = (
        <>
          <path d="M3 19C4 10 8 8 12 8s8 2 9 11" {...line} />
          <path d="M4 8h16" {...line} strokeWidth={1} />
          <circle cx="4" cy="8" r="1.6" {...knob} />
          <circle cx="20" cy="8" r="1.6" {...knob} />
          {node(12, 8)}
        </>
      );
      break;
    case "break":
      // One path pulled apart into two ends.
      body = (
        <>
          <path d="M2 18L9 11M22 18L15 11" {...line} />
          {node(9, 11)}
          {node(15, 11)}
          <path d="M12 3v4M12 15v6" {...line} strokeWidth={1.2} strokeDasharray="1.5 2" />
        </>
      );
      break;
    case "merge":
      // Two ends drawn together into one anchor.
      body = (
        <>
          <path d="M2 18L12 9l10 9" {...line} />
          <path d="M4 7h4M6.5 5L8.5 7l-2 2M20 7h-4M17.5 5L15.5 7l2 2" {...line} strokeWidth={1.2} />
          {node(12, 9)}
        </>
      );
      break;
  }
  return <svg viewBox="0 0 24 24" className="sketch-glyph" aria-hidden="true">{body}</svg>;
}

function OriginMarker({ at: [x, y] }: { at: Pt }) {
  return (
    <g className="sketch-origin" pointerEvents="none">
      <line x1={x} y1={y} x2={x + 28} y2={y} stroke="var(--axis-x)" strokeWidth={2} />
      <line x1={x} y1={y} x2={x} y2={y - 28} stroke="var(--axis-y)" strokeWidth={2} />
      <text x={x + 31} y={y + 4} fill="var(--axis-x)">X</text>
      <text x={x - 4} y={y - 32} fill="var(--axis-y)">Y</text>
      <circle cx={x} cy={y} r={2.5} fill="#25313b" />
    </g>
  );
}

function ToolGlyph({ tool }: { tool: Tool }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (tool) {
    case "select":
      return <svg viewBox="0 0 24 24" className="tool-icon"><path d="M6 3l12 9-5.5 1 3 6-2.5 1.2-3-6L6 18z" fill="currentColor" /></svg>;
    case "direct":
      return <svg viewBox="0 0 24 24" className="tool-icon"><path d="M6 3l12 9-5.5 1 3 6-2.5 1.2-3-6L6 18z" {...common} fill="#fff" /></svg>;
    case "pen":
      return (
        <svg viewBox="0 0 24 24" className="tool-icon">
          <path d="M12 3l6 9-3 8H9l-3-8z" {...common} />
          <path d="M12 3v7" {...common} />
          <circle cx="12" cy="11.5" r="1.4" fill="currentColor" />
          <path d="M9 20h6" {...common} />
        </svg>
      );
    case "add":
    case "delete":
      return (
        <svg viewBox="0 0 24 24" className="tool-icon">
          <path d="M9 3l5 7.5-2.5 6.5h-5L4 10.5z" {...common} />
          <path d={tool === "add" ? "M16 17h6M19 14v6" : "M16 17h6"} {...common} strokeWidth={2} />
        </svg>
      );
    case "scissors":
      return (
        <svg viewBox="0 0 24 24" className="tool-icon">
          <circle cx="6" cy="7" r="2.6" {...common} />
          <circle cx="6" cy="17" r="2.6" {...common} />
          <path d="M8.2 8.4L20 16M8.2 15.6L20 8" {...common} />
        </svg>
      );
    case "convert":
      return (
        <svg viewBox="0 0 24 24" className="tool-icon">
          <path d="M4 18L12 6l8 12" {...common} />
          <rect x="10" y="4" width="4" height="4" fill="currentColor" />
        </svg>
      );
  }
}
