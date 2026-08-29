import { useEffect, useRef } from "react";
import { Scene } from "./scene";
import type { CameraMode, ToolMode, WireframeMode } from "./scene";
import type { PreviewBuild, ScenePart } from "../kernel/types";
import type { PrimitiveKind, SceneNode, Vec3 } from "../document/types";

interface Props {
  parts: ScenePart[];
  nodes: SceneNode[];
  selectedIds: string[];
  cameraMode: CameraMode;
  toolMode: ToolMode;
  placementKind: PrimitiveKind | null;
  resizeConstrained: boolean;
  /** Wireframe display mode: off, clean edges, full tessellated mesh, or xray. */
  wireframe: WireframeMode;
  /** Smart Guides on/off — snapping while dragging. */
  snapEnabled: boolean;
  onSelect: (id: string | null, additive: boolean) => void;
  /** Marquee-select release: every id caught inside the drawn rectangle. */
  onSelectMany: (ids: string[], additive: boolean) => void;
  onTransform: (id: string, patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
  onAlign: (updates: { id: string; position: Vec3 }[]) => void;
  /** Alt-drag: creates a copy of `id` and returns its new id (or null),
   *  synchronously, so the Scene can keep dragging that id instead. */
  onDuplicate: (id: string) => string | null;
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
  onDragChange: (dragging: boolean) => void;
  onSelectEdges: (id: string | null, points: Vec3[]) => void;
  onPlaceSurface: (point: Vec3, normal: Vec3) => void;
  /** Handed the Scene on mount and null on unmount. A keyboard action like
   *  Drop has to call INTO the scene (it needs the built geometry), which the
   *  one-way props everything else uses cannot express. */
  onSceneReady?: (scene: Scene | null) => void;
  /** Shape Builder: every region and whether it is in the shape. */
  onCellsChanged?: (cells: { mask: number; kept: boolean }[]) => void;
}

export function Viewport(props: Props) {
  const { parts, nodes, selectedIds, cameraMode, toolMode, resizeConstrained, wireframe, snapEnabled } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);

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
    scene.onDuplicateObject = (id) => latest.current.onDuplicate(id);
    scene.onPushPullFace = (id, op, positionDelta) =>
      latest.current.onPushPull(id, op, positionDelta);
    scene.onPreviewPushPull = (id, op) => latest.current.onPreviewPushPull(id, op);
    scene.onDragChange = (dragging) => latest.current.onDragChange(dragging);
    scene.onSelectEdges = (id, points) => latest.current.onSelectEdges(id, points);
    scene.onPlaceSurface = (point, normal) => latest.current.onPlaceSurface(point, normal);
    scene.onCellsChanged = (cells) => latest.current.onCellsChanged?.(cells);

    scene.setParts(latest.current.parts);
    scene.setPlacements(latest.current.nodes, latest.current.selectedIds);
    scene.setCameraMode(latest.current.cameraMode);
    scene.setToolMode(latest.current.toolMode);
    scene.setPlacementPreview(latest.current.placementKind);
    scene.setResizeConstrained(latest.current.resizeConstrained);
    scene.setWireframe(latest.current.wireframe);
    scene.setSnapEnabled(latest.current.snapEnabled);

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
    sceneRef.current?.setPlacementPreview(props.placementKind);
  }, [props.placementKind]);

  useEffect(() => {
    sceneRef.current?.setResizeConstrained(resizeConstrained);
  }, [resizeConstrained]);

  useEffect(() => {
    sceneRef.current?.setWireframe(wireframe);
  }, [wireframe]);

  useEffect(() => {
    sceneRef.current?.setSnapEnabled(snapEnabled);
  }, [snapEnabled]);

  return <div className="viewport" ref={hostRef} />;
}
