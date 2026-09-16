import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

interface Props {
  /** Freshly built each time the caller's shape changes — this component
   *  takes ownership and disposes them when replaced or on unmount. */
  geometries: THREE.BufferGeometry[];
  color: string;
  /** Changing this snaps the camera back to the default corner instead of
   *  keeping the current orbit angle. Use it for anything that can flip the
   *  shape's whole orientation (e.g. the revolve axis) — otherwise the old
   *  angle can end up edge-on to the new shape and it reads as a sliver. */
  resetKey?: string | number;
}

interface Rig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  framed: boolean;
  raf: number;
}

const DEFAULT_DIR = new THREE.Vector3(1, -1.3, 1).normalize();

/** Follow the shape's center while preserving zoom during edits. Only the
 * initial frame and explicit Reset view fit the camera to the shape. */
function frame(rig: Rig, dir?: THREE.Vector3, preserveDistance = false) {
  const box = new THREE.Box3().setFromObject(rig.group);
  const sphere = new THREE.Sphere();
  const hasBounds = !box.isEmpty() && box.getBoundingSphere(sphere).radius > 1e-6;
  const target = hasBounds ? sphere.center : new THREE.Vector3();
  const radius = hasBounds ? sphere.radius : 10;
  const direction = dir ? dir.clone() : rig.camera.position.clone().sub(rig.controls.target);
  if (direction.lengthSq() < 1e-9) direction.copy(DEFAULT_DIR);
  direction.normalize();
  const fitDistance = (radius / Math.sin((rig.camera.fov * Math.PI) / 360)) * 1.35;
  const distance = preserveDistance ? rig.camera.position.distanceTo(rig.controls.target) : fitDistance;
  rig.controls.target.copy(target);
  rig.camera.position.copy(target).addScaledVector(direction, distance);
  rig.camera.near = Math.max(Math.min(distance, fitDistance) / 100, 0.001);
  rig.camera.far = Math.max(distance, fitDistance) * 100;
  rig.camera.updateProjectionMatrix();
  rig.controls.update();
}

/**
 * A small, self-contained Three.js viewport — its own renderer, camera and
 * orbit controls, entirely separate from the main Scene — for previewing a
 * shape in isolation. Right-drag orbits, matching the main scene's own
 * TinkerCAD-style binding (see Scene.applyControlBindings).
 */
export function Shape3DPreview({ geometries, color, resetKey }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<Rig | null>(null);
  const lastResetKeyRef = useRef(resetKey);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(50, -80, 100);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-70, 40, -30);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(40, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.copy(DEFAULT_DIR).multiplyScalar(10);

    // A closed-loop revolve profile (e.g. a torus's own offset outline) can
    // come out with the winding flipped on part of the surface — visible as
    // a see-through crease with single-sided rendering. Double-sided keeps
    // the preview solid-looking even then.
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const group = new THREE.Group();
    scene.add(group);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // Matches Scene.applyControlBindings: left click is free for other use,
    // right-drag orbits, same as the main viewport.
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.enablePan = false;
    controls.minDistance = 0.01;
    controls.maxDistance = 1e6;

    const rig: Rig = { camera, controls, group, material, framed: false, raf: 0 };
    rigRef.current = rig;

    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      rig.raf = requestAnimationFrame(tick);
    };
    tick();

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth, h = Math.max(1, host.clientHeight);
      if (w <= 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    return () => {
      cancelAnimationFrame(rig.raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      for (const child of group.children) (child as THREE.Mesh).geometry.dispose();
      material.dispose();
      host.removeChild(renderer.domElement);
      rigRef.current = null;
    };
  }, []);

  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return;
    // The group is empty here: the previous run's cleanup below already
    // cleared it before this one runs.
    for (const geometry of geometries) {
      rig.group.add(new THREE.Mesh(geometry, rig.material));
    }
    const orientationChanged = lastResetKeyRef.current !== resetKey;
    lastResetKeyRef.current = resetKey;
    frame(rig, orientationChanged ? DEFAULT_DIR : undefined, rig.framed);
    rig.framed = true;
    return () => {
      for (const child of [...rig.group.children]) rig.group.remove(child);
      for (const geometry of geometries) geometry.dispose();
    };
  }, [geometries, resetKey]);

  useEffect(() => {
    rigRef.current?.material.color.set(color);
  }, [color]);

  const zoom = (factor: number) => {
    const rig = rigRef.current;
    if (!rig) return;
    const offset = rig.camera.position.clone().sub(rig.controls.target).multiplyScalar(factor);
    if (offset.length() > 0.02) rig.camera.position.copy(rig.controls.target).add(offset);
    rig.controls.update();
  };

  const reset = () => {
    const rig = rigRef.current;
    if (rig) frame(rig, DEFAULT_DIR);
  };

  return (
    <div className="shape-preview">
      <div className="shape-preview-canvas" ref={hostRef} />
      <div className="shape-preview-controls">
        <button type="button" className="shape-preview-btn shape-preview-reset" title="Reset view" onClick={reset}>
          <svg viewBox="0 0 24 24" width="13" height="13">
            <path d="M12 4l8 8-8 8-8-8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="shape-preview-btn" title="Zoom in" onClick={() => zoom(0.8)}>+</button>
        <button type="button" className="shape-preview-btn" title="Zoom out" onClick={() => zoom(1.25)}>−</button>
      </div>
    </div>
  );
}
