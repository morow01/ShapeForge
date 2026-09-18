import { useEffect, useRef, useState } from "react";
import { Scene } from "./scene";
import type { CameraMode, ToolMode, WireframeMode, AlignSubMode, DuplicateResult } from "./scene";
import type { PreviewBuild, ScenePart } from "../kernel/types";
import type { PrimitiveKind, SceneNode, Vec3 } from "../document/types";
import type { DisplayUnit } from "../measurement";
import { EyeOffIcon, HomeIcon, ZoomToFitIcon } from "../ui/icons";

interface Props {
  parts: ScenePart[];
  nodes: SceneNode[];
  selectedIds: string[];
  cameraMode: CameraMode;
  toolMode: ToolMode;
  alignSubMode?: AlignSubMode;
  /** Only Push/Pull owns the draggable face-normal arrow and its distance pill. */
  facePushPullEnabled: boolean;
  placementKind: PrimitiveKind | null;
  resizeConstrained: boolean;
  /** The Exact Spacing panel's "stays fixed" object id, when exactly two
   *  objects are selected — see Scene.alignFixedId. Null the rest of the
   *  time, including with any other selection count. */
  alignFixedId: string | null;
  /** Wireframe display mode: off, clean edges, full tessellated mesh, or xray. */
  wireframe: WireframeMode;
  /** Smart Guides on/off — snapping while dragging. */
  snapEnabled: boolean;
  /** Quantize body dragging to the visible millimetre grid. */
  gridSnapEnabled: boolean;
  /** Keep collision contact patches visible while an object is selected. */
  showSelectedCollisionContacts: boolean;
  /** Exploded view outward displacement factor (0 to 1). */
  explodeAmount?: number;
  plateVisible?: boolean;
  /** The view cube and axis triad in the corner (and its Home button). */
  viewCubeVisible?: boolean;
  /** The hide button on the view cube's hover toolbar. */
  onHideViewCube?: () => void;
  plateSize?: { width: number; depth: number };
  displayUnit: DisplayUnit;
  decimalPlaces: number;
  onSelect: (id: string | null, additive: boolean) => void;
  /** Marquee-select release: every id caught inside the drawn rectangle. */
  onSelectMany: (ids: string[], additive: boolean) => void;
  onTransform: (id: string, patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
  onAlign: (updates: { id: string; position: Vec3 }[]) => void;
  /** Alt-drag: creates copies of `target` and returns new ids,
   *  synchronously, so the Scene can keep dragging those ids instead. */
  onDuplicate: (target: string | string[]) => DuplicateResult | null;
  /** Push/pull: a face on `id` was dragged `distance` mm along its normal. */
  onPushPull: (
    id: string,
    op: { point: Vec3; normal: Vec3; distance: number },
    positionDelta: Vec3,
  ) => void;
  /** Live preview during a push/pull drag — see Scene.onPreviewPushPull's own
   *  doc comment. Not a document edit; just asks for a mesh to show. */
  onPreviewPushPull: (
    id: string,
    op: { point: Vec3; normal: Vec3; distance: number },
  ) => Promise<PreviewBuild | null>;
  /** Mirrors the live arrow/readout distance into the bottom Distance field. */
  onPushPullDistanceChange: (distanceMm: number) => void;
  onDragChange: (dragging: boolean) => void;
  onSelectEdges: (id: string | null, points: Vec3[]) => void;
  onSelectFace: (id: string | null, point: Vec3 | null, normal: Vec3 | null, size: number, edges: Vec3[]) => void;
  onPlaceSurface: (point: Vec3, normal: Vec3) => void;
  /** Fired instead of onPlaceSurface when the box/cylinder placement tool was
   *  used as a drag (footprint size, then height) rather than a plain click. */
  onPlaceSurfaceSized?: (point: Vec3, normal: Vec3, targetId: string | undefined, sizeOverride: Record<string, number>) => void;
  onSelectAnchor?: (id: string | null) => void;
  /** Handed the Scene on mount and null on unmount. A keyboard action like
   *  Drop has to call INTO the scene (it needs the built geometry), which the
   *  one-way props everything else uses cannot express. */
  onSceneReady?: (scene: Scene | null) => void;
  /** Shape Builder: every region and whether it is in the shape. */
  onCellsChanged?: (cells: { mask: number; kept: boolean }[]) => void;
}

export function Viewport(props: Props) {
  const { parts, nodes, selectedIds, cameraMode, toolMode, resizeConstrained, wireframe, snapEnabled, gridSnapEnabled, showSelectedCollisionContacts } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);

  // The view cube's tools stay out of sight until the pointer is over the
  // cube. The cube itself is drawn on the canvas, so this watches for the
  // pointer near its box rather than waiting for a hover on some element.
  const cubeBoxRef = useRef<HTMLDivElement>(null);
  const [cubeHover, setCubeHover] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer = 0;
    const set = (over: boolean) => {
      window.clearTimeout(timer);
      // A short grace period on the way out, so crossing the gap between the
      // cube and its toolbar does not make it flicker away.
      if (over) setCubeHover(true);
      else timer = window.setTimeout(() => setCubeHover(false), 250);
    };
    const onMove = (e: PointerEvent) => {
      const box = cubeBoxRef.current?.getBoundingClientRect();
      const pad = 12;
      set(
        !!box &&
          e.clientX >= box.left - pad && e.clientX <= box.right + pad &&
          e.clientY >= box.top - pad && e.clientY <= box.bottom + pad,
      );
    };
    const onLeave = () => set(false);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      window.clearTimeout(timer);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  // Latest values, so a remount (React StrictMode double-invokes effects in
  // dev) can restore the scene without waiting for the props to change.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new Scene(host);
    scene.onSelectObject = (id, additive) => latest.current.onSelect(id, additive);
    scene.onSelectMany = (ids, additive) => latest.current.onSelectMany(ids, additive);
    scene.onTransformObject = (id, patch) => latest.current.onTransform(id, patch);
    scene.onAlignObjects = (updates) => latest.current.onAlign(updates);
    scene.onDuplicateObject = (target) => latest.current.onDuplicate(target);
    scene.onPushPullFace = (id, op, positionDelta) =>
      latest.current.onPushPull(id, op, positionDelta);
    scene.onPreviewPushPull = (id, op) => latest.current.onPreviewPushPull(id, op);
    scene.onPushPullDistanceChange = (distance) => latest.current.onPushPullDistanceChange(distance);
    scene.onDragChange = (dragging) => latest.current.onDragChange(dragging);
    scene.onSelectEdges = (id, points) => latest.current.onSelectEdges(id, points);
    scene.onSelectFace = (id, point, normal, size, edges) => latest.current.onSelectFace(id, point, normal, size, edges);
    scene.onPlaceSurface = (point, normal) => latest.current.onPlaceSurface(point, normal);
    scene.onPlaceSurfaceSized = (point, normal, targetId, sizeOverride) =>
      latest.current.onPlaceSurfaceSized?.(point, normal, targetId, sizeOverride);
    scene.onSelectAnchor = (id) => latest.current.onSelectAnchor?.(id);
    scene.onCellsChanged = (cells) => latest.current.onCellsChanged?.(cells);

    scene.setParts(latest.current.parts);
    scene.setPlacements(latest.current.nodes, latest.current.selectedIds);
    scene.setCameraMode(latest.current.cameraMode);
    scene.setToolMode(latest.current.toolMode);
    scene.setAlignSubMode(latest.current.alignSubMode ?? "box");
    scene.setFacePushPullEnabled(latest.current.facePushPullEnabled);
    scene.setPlacementPreview(latest.current.placementKind);
    scene.setResizeConstrained(latest.current.resizeConstrained);
    scene.setAlignFixedId(latest.current.alignFixedId);
    scene.setWireframe(latest.current.wireframe);
    scene.setSnapEnabled(latest.current.snapEnabled);
    scene.setGridSnapEnabled(latest.current.gridSnapEnabled);
    scene.setShowSelectedCollisionContacts(latest.current.showSelectedCollisionContacts);
    if (latest.current.plateVisible !== undefined) {
      scene.setPlateVisible(latest.current.plateVisible);
    }
    scene.setNavCubeVisible(latest.current.viewCubeVisible !== false);
    if (latest.current.plateSize) {
      scene.setPlateSize(latest.current.plateSize.width, latest.current.plateSize.depth);
    }
    scene.setMeasurementFormat(latest.current.displayUnit, latest.current.decimalPlaces);
    scene.setExplodeAmount(latest.current.explodeAmount ?? 0);

    sceneRef.current = scene;
    latest.current.onSceneReady?.(scene);
    if (import.meta.env.DEV) {
      (globalThis as unknown as { __scene?: Scene }).__scene = scene;
    }

    return () => {
      latest.current.onSceneReady?.(null);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setParts(parts);
  }, [parts]);

  useEffect(() => {
    sceneRef.current?.setPlacements(nodes, selectedIds);
  }, [nodes, selectedIds]);

  useEffect(() => {
    sceneRef.current?.setCameraMode(cameraMode);
  }, [cameraMode]);

  useEffect(() => {
    sceneRef.current?.setToolMode(toolMode);
  }, [toolMode]);

  useEffect(() => {
    sceneRef.current?.setAlignSubMode(props.alignSubMode ?? "box");
  }, [props.alignSubMode]);

  useEffect(() => {
    sceneRef.current?.setFacePushPullEnabled(props.facePushPullEnabled);
  }, [props.facePushPullEnabled]);

  useEffect(() => {
    sceneRef.current?.setPlacementPreview(props.placementKind);
  }, [props.placementKind]);

  useEffect(() => {
    sceneRef.current?.setResizeConstrained(resizeConstrained);
  }, [resizeConstrained]);

  useEffect(() => {
    sceneRef.current?.setAlignFixedId(props.alignFixedId);
  }, [props.alignFixedId]);

  useEffect(() => {
    sceneRef.current?.setWireframe(wireframe);
  }, [wireframe]);

  useEffect(() => {
    sceneRef.current?.setExplodeAmount(props.explodeAmount ?? 0);
  }, [props.explodeAmount]);

  useEffect(() => {
    sceneRef.current?.setSnapEnabled(snapEnabled);
  }, [snapEnabled]);

  useEffect(() => {
    sceneRef.current?.setGridSnapEnabled(gridSnapEnabled);
  }, [gridSnapEnabled]);

  useEffect(() => {
    sceneRef.current?.setShowSelectedCollisionContacts(showSelectedCollisionContacts);
  }, [showSelectedCollisionContacts]);

  useEffect(() => {
    if (props.plateVisible !== undefined) {
      sceneRef.current?.setPlateVisible(props.plateVisible);
    }
  }, [props.plateVisible]);

  useEffect(() => {
    sceneRef.current?.setNavCubeVisible(props.viewCubeVisible !== false);
  }, [props.viewCubeVisible]);

  useEffect(() => {
    if (props.plateSize) {
      sceneRef.current?.setPlateSize(props.plateSize.width, props.plateSize.depth);
    }
  }, [props.plateSize?.width, props.plateSize?.depth]);

  useEffect(() => {
    sceneRef.current?.setMeasurementFormat(props.displayUnit, props.decimalPlaces);
  }, [props.displayUnit, props.decimalPlaces]);

  return (
    <div className="viewport" ref={hostRef}>
      {props.viewCubeVisible !== false && (
        <div className={`navcube-controls${cubeHover ? " is-open" : ""}`} ref={cubeBoxRef}>
          <div className="navcube-tools" role="toolbar" aria-label="View controls">
            <button
              type="button"
              className="navcube-tool"
              onClick={() => sceneRef.current?.resetView()}
              title="Reset to default view (Home)"
              aria-label="Reset to default view"
            >
              <HomeIcon className="navcube-icon" />
            </button>
            <button
              type="button"
              className="navcube-tool"
              onClick={() => sceneRef.current?.zoomToFit()}
              title="Zoom to fit (Z)"
              aria-label="Zoom to fit"
            >
              <ZoomToFitIcon className="navcube-icon" />
            </button>
            <button
              type="button"
              className="navcube-tool"
              onClick={() => props.onHideViewCube?.()}
              title="Hide view cube (show it again from the top bar or Settings)"
              aria-label="Hide view cube"
            >
              <EyeOffIcon className="navcube-icon" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
