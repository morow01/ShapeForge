import { useEffect, useRef } from "react";
import { Scene } from "./scene";
import type { CameraMode, GizmoMode } from "./scene";
import type { KernelMesh, ScenePart } from "../kernel/types";
import type { SceneNode, Vec3 } from "../document/types";

interface Props {
  parts: ScenePart[];
  result: KernelMesh | null;
  nodes: SceneNode[];
  selectedIds: string[];
  cameraMode: CameraMode;
  gizmoMode: GizmoMode;
  showResult: boolean;
  onSelect: (id: string | null, additive: boolean) => void;
  onTransform: (id: string, patch: { position?: Vec3; rotation?: Vec3 }) => void;
  onDragChange: (dragging: boolean) => void;
}

export function Viewport(props: Props) {
  const { parts, result, nodes, selectedIds, cameraMode, gizmoMode, showResult } = props;

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
    scene.onTransformObject = (id, patch) => latest.current.onTransform(id, patch);
    scene.onDragChange = (dragging) => latest.current.onDragChange(dragging);

    scene.setParts(latest.current.parts);
    scene.setResult(latest.current.result);
    scene.setPlacements(latest.current.nodes, latest.current.selectedIds);
    scene.setCameraMode(latest.current.cameraMode);
    scene.setGizmoMode(latest.current.gizmoMode);
    scene.setShowResult(latest.current.showResult);

    sceneRef.current = scene;
    if (import.meta.env.DEV) {
      (globalThis as unknown as { __scene?: Scene }).__scene = scene;
    }

    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setParts(parts);
  }, [parts]);

  useEffect(() => {
    sceneRef.current?.setResult(result);
  }, [result]);

  // Placement is cheap and must follow every node/selection change.
  useEffect(() => {
    sceneRef.current?.setPlacements(nodes, selectedIds);
  }, [nodes, selectedIds]);

  useEffect(() => {
    sceneRef.current?.setCameraMode(cameraMode);
  }, [cameraMode]);

  useEffect(() => {
    sceneRef.current?.setGizmoMode(gizmoMode);
  }, [gizmoMode]);

  useEffect(() => {
    sceneRef.current?.setShowResult(showResult);
  }, [showResult]);

  return <div className="viewport" ref={hostRef} />;
}
