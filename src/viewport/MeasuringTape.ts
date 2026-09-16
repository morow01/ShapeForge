import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import * as THREE from "three";
import { formatLength, type DisplayUnit } from "../measurement";
import type { FaceInfo } from "../kernel/types";

type Part = { id?: string; mesh: THREE.Mesh; wire: THREE.LineSegments; group: THREE.Group; faces?: FaceInfo[] };

type Attachment = {
  partId?: string;
  localPoint: THREE.Vector3;
  localNormal?: THREE.Vector3;
  localEdge?: THREE.Vector3[];
};

type Pick = {
  point: THREE.Vector3;
  normal?: THREE.Vector3;
  edge?: THREE.Vector3[];
  attachment: Attachment;
  hint: string;
};

type Reading = {
  points: THREE.Vector3[];
  length: number;
  kind: string;
  delta?: THREE.Vector3;
  startAttachment?: Attachment;
  endAttachment?: Attachment;
  mode?: string;
};

type Mark = { row?: HTMLDivElement; value?: HTMLSpanElement; id: number; reading: Reading; line: LineSegments2; outline: LineSegments2; dots: THREE.Points; label: HTMLDivElement };

/** Read-only measurements of displayed geometry. Persists and tracks moving objects in real-time. */
export class MeasuringTape {
  private active = false;
  private mode = "points";
  private start: Pick | null = null;
  private startMark: Mark | null = null;
  private preview: Mark | null = null;
  private pins: Mark[] = [];
  private panel = document.createElement("section");
  private list = document.createElement("div");
  private status = document.createElement("p");
  private layer = new THREE.Group();
  private serial = 0;
  private host: HTMLElement;
  private camera: () => THREE.Camera;
  private parts: () => Part[];
  private format: () => { unit: DisplayUnit; decimals: number };
  private lineColor: string;
  private showNumbers = false;
  private keepVisible = false;
  private snapPoints = true;
  private snapEdges = false;
  constructor(host: HTMLElement, scene: THREE.Scene,
    camera: () => THREE.Camera, parts: () => Part[],
    format: () => { unit: DisplayUnit; decimals: number }) {
    this.host = host; this.camera = camera; this.parts = parts; this.format = format;
    try {
      this.lineColor = localStorage.getItem("shapeforge_tape_color") || "#0284c7";
      this.showNumbers = localStorage.getItem("shapeforge_tape_show_numbers") === "true";
      this.keepVisible = localStorage.getItem("shapeforge_tape_keep_visible") === "true";
      const snapPointsSaved = localStorage.getItem("shapeforge_tape_snap_points");
      this.snapPoints = snapPointsSaved === null ? true : snapPointsSaved === "true";
      this.snapEdges = localStorage.getItem("shapeforge_tape_snap_edges") === "true";
    } catch {
      this.lineColor = "#0284c7";
      this.showNumbers = false;
      this.keepVisible = false;
      this.snapPoints = true;
      this.snapEdges = false;
    }
    scene.add(this.layer);
    this.panel.className = "tape-panel"; this.panel.setAttribute("aria-label", "Measuring tape");
    const heading = document.createElement("strong"); heading.textContent = "Measuring tape";
    const modes = document.createElement("div"); modes.className = "tape-modes";
    const modeConfigs = [
      {
        mode: "points",
        name: "Point to point",
        icon: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="19" r="2.5" fill="currentColor"/><circle cx="19" cy="5" r="2.5" fill="currentColor"/><line x1="7" y1="17" x2="17" y2="7"/></svg>'
      },
      {
        mode: "edge",
        name: "Edge length",
        icon: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" opacity="0.3"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" opacity="0.3"/><line x1="4" y1="7.5" x2="4" y2="16.5" stroke-width="2.6"/><circle cx="4" cy="7.5" r="1.5" fill="currentColor"/><circle cx="4" cy="16.5" r="1.5" fill="currentColor"/></svg>'
      },
      {
        mode: "faces",
        name: "Gap / thickness",
        icon: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="3.5" height="16" rx="0.75" fill="currentColor" fill-opacity="0.25"/><rect x="17.5" y="4" width="3.5" height="16" rx="0.75" fill="currentColor" fill-opacity="0.25"/><path d="M6.5 12h11M9.5 9.5L6.5 12l3 2.5m5-5l3 2.5-3 2.5"/></svg>'
      }
    ] as const;

    for (const { mode, name, icon } of modeConfigs) {
      const button = document.createElement("button");
      button.innerHTML = icon;
      button.title = name;
      button.setAttribute("aria-label", name);
      button.setAttribute("aria-pressed", String(mode === this.mode));
      button.onclick = () => {
        this.setMode(mode);
        for (const child of modes.children) child.setAttribute("aria-pressed", String(child === button));
      };
      modes.append(button);
    }
    const colorRow = document.createElement("div"); colorRow.className = "tape-color-row";
    const colorLabel = document.createElement("span"); colorLabel.className = "tape-color-label"; colorLabel.textContent = "Line colour";
    const swatches = document.createElement("div"); swatches.className = "tape-color-swatches";
    const presetColors = ["#0284c7", "#f59e0b", "#10b981", "#e11d48", "#8b5cf6", "#334155"];

    const pickerLabel = document.createElement("label");
    pickerLabel.className = "tape-color-custom";
    pickerLabel.title = "Pick custom colour";
    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "tape-color-picker-input";
    picker.value = this.lineColor.startsWith("#") ? this.lineColor : "#0284c7";
    const pickerSwatch = document.createElement("span");
    pickerSwatch.className = "tape-color-custom-preview";
    pickerSwatch.style.backgroundColor = this.lineColor;

    const updateSwatches = () => {
      for (const el of Array.from(swatches.children) as HTMLElement[]) {
        if (el.dataset.color) el.setAttribute("aria-checked", String(el.dataset.color.toLowerCase() === this.lineColor.toLowerCase()));
      }
      pickerSwatch.style.backgroundColor = this.lineColor;
      picker.value = this.lineColor.startsWith("#") ? this.lineColor : "#0284c7";
    };

    for (const hex of presetColors) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "tape-color-swatch";
      swatch.dataset.color = hex;
      swatch.style.backgroundColor = hex;
      swatch.title = hex;
      swatch.onclick = () => { this.setLineColor(hex); updateSwatches(); };
      swatches.append(swatch);
    }

    picker.oninput = (e) => {
      const val = (e.target as HTMLInputElement).value;
      this.setLineColor(val);
      updateSwatches();
    };
    pickerLabel.append(picker, pickerSwatch);
    swatches.append(pickerLabel);
    updateSwatches();
    colorRow.append(colorLabel, swatches);

    const optionsGroup = document.createElement("div");
    optionsGroup.className = "tape-options-group";

    const snapPointsRow = document.createElement("label");
    snapPointsRow.className = "tape-option-row";
    const snapPointsLabel = document.createElement("span");
    snapPointsLabel.textContent = "Snap to points (corners/midpoints)";
    const snapPointsCheckbox = document.createElement("input");
    snapPointsCheckbox.type = "checkbox";
    snapPointsCheckbox.checked = this.snapPoints;
    snapPointsCheckbox.onchange = () => {
      this.snapPoints = snapPointsCheckbox.checked;
      try { localStorage.setItem("shapeforge_tape_snap_points", String(this.snapPoints)); } catch {}
    };
    snapPointsRow.append(snapPointsLabel, snapPointsCheckbox);

    const snapEdgesRow = document.createElement("label");
    snapEdgesRow.className = "tape-option-row";
    const snapEdgesLabel = document.createElement("span");
    snapEdgesLabel.textContent = "Snap to edges (slide along line)";
    const snapEdgesCheckbox = document.createElement("input");
    snapEdgesCheckbox.type = "checkbox";
    snapEdgesCheckbox.checked = this.snapEdges;
    snapEdgesCheckbox.onchange = () => {
      this.snapEdges = snapEdgesCheckbox.checked;
      try { localStorage.setItem("shapeforge_tape_snap_edges", String(this.snapEdges)); } catch {}
    };
    snapEdgesRow.append(snapEdgesLabel, snapEdgesCheckbox);

    const numbersRow = document.createElement("label");
    numbersRow.className = "tape-option-row";
    const numbersLabel = document.createElement("span");
    numbersLabel.textContent = "Show numbers on scene";
    const numbersCheckbox = document.createElement("input");
    numbersCheckbox.type = "checkbox";
    numbersCheckbox.checked = this.showNumbers;
    numbersCheckbox.onchange = () => {
      this.showNumbers = numbersCheckbox.checked;
      try { localStorage.setItem("shapeforge_tape_show_numbers", String(this.showNumbers)); } catch {}
    };
    numbersRow.append(numbersLabel, numbersCheckbox);

    const keepRow = document.createElement("label");
    keepRow.className = "tape-option-row";
    const keepLabel = document.createElement("span");
    keepLabel.textContent = "Keep dimensions on scene";
    const keepCheckbox = document.createElement("input");
    keepCheckbox.type = "checkbox";
    keepCheckbox.checked = this.keepVisible;
    keepCheckbox.onchange = () => {
      this.keepVisible = keepCheckbox.checked;
      try { localStorage.setItem("shapeforge_tape_keep_visible", String(this.keepVisible)); } catch {}
      this.layer.visible = this.active || this.keepVisible;
      for (const p of this.pins) p.label.hidden = !(this.active || this.keepVisible);
    };
    keepRow.append(keepLabel, keepCheckbox);
    optionsGroup.append(snapPointsRow, snapEdgesRow, numbersRow, keepRow);

    this.list.className = "tape-saved-list"; this.status.setAttribute("aria-live", "polite");
    const cancel = document.createElement("button"); cancel.textContent = "Cancel current"; cancel.onclick = () => this.cancel();
    const clear = document.createElement("button"); clear.textContent = "Clear all"; clear.onclick = () => this.clear();
    const note = document.createElement("small"); note.textContent = "Hover a row to highlight its line. Hover or click a dimension in the scene to reveal ×. Measurements track objects dynamically.";
    this.panel.append(heading, modes, colorRow, optionsGroup, this.status, this.list, cancel, clear, note); this.setActive(false);
    window.addEventListener("keydown", this.onKeyDown, true);
  }
  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    if (e.key === "Escape" && this.start) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.cancel();
    }
  };
  mountPanel(host: HTMLElement) { host.append(this.panel); }
  setLineColor(color: string) {
    this.lineColor = color;
    try { localStorage.setItem("shapeforge_tape_color", color); } catch {}
    const c = new THREE.Color(color);
    for (const mark of [...this.pins, ...(this.preview ? [this.preview] : []), ...(this.startMark ? [this.startMark] : [])]) {
      mark.line.material.color.copy(c);
      (mark.dots.material as THREE.PointsMaterial).color.copy(c);
    }
  }
  setMode(mode: "points" | "faces" | "edge") { this.mode = mode; this.cancel(); }
  setActive(active: boolean) { this.active = active; this.panel.hidden = !active; this.layer.visible = active || this.keepVisible; this.cancel(); for (const p of this.pins) p.label.hidden = !(active || this.keepVisible); }
  private instruction() { return this.mode === "edge" ? "Hover an edge, then click to pin its length." : this.mode === "faces" ? "Click a flat face to start, then hover over an opposite or parallel face." : "Select a start point. Corners, edges, and midpoints snap automatically."; }
  cancel() { this.start = null; this.drop(this.startMark); this.startMark = null; this.drop(this.preview); this.preview = null; this.status.textContent = this.instruction(); }
  clear() { this.cancel(); for (const p of this.pins) this.drop(p); this.pins = []; this.serial = 0;  }
  private drop(mark: Mark | null) { if (!mark) return; mark.line.removeFromParent(); mark.outline.removeFromParent(); mark.outline.material.dispose(); mark.dots.removeFromParent(); mark.dots.geometry.dispose(); (mark.dots.material as THREE.Material).dispose(); mark.line.geometry.dispose(); (mark.line.material as THREE.Material).dispose(); mark.label.remove(); mark.row?.remove(); }
  private getCanvasRect(): DOMRect {
    const canvas = this.host.querySelector("canvas");
    return (canvas ?? this.host).getBoundingClientRect();
  }
  private makeAttachment(part: Part | undefined, worldPoint: THREE.Vector3, worldNormal?: THREE.Vector3, worldEdge?: THREE.Vector3[]): Attachment {
    if (!part || !part.id) {
      return {
        localPoint: worldPoint.clone(),
        localNormal: worldNormal?.clone(),
        localEdge: worldEdge?.map(p => p.clone())
      };
    }
    part.group.updateWorldMatrix(true, false);
    const inv = part.group.matrixWorld.clone().invert();
    const localPoint = worldPoint.clone().applyMatrix4(inv);
    let localNormal: THREE.Vector3 | undefined;
    if (worldNormal) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(part.group.matrixWorld).invert();
      localNormal = worldNormal.clone().applyMatrix3(normalMatrix).normalize();
    }
    let localEdge: THREE.Vector3[] | undefined;
    if (worldEdge) {
      localEdge = worldEdge.map(p => p.clone().applyMatrix4(inv));
    }
    return {
      partId: part.id,
      localPoint,
      localNormal,
      localEdge
    };
  }
  private pick(e: PointerEvent): Pick | null {
    const rect = this.getCanvasRect(), camera = this.camera();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
    const parts = this.parts().filter(p => p.group.visible);
    const hit = ray.intersectObjects(parts.map(p => p.mesh), false)[0];
    if (this.mode === "faces") {
      if (!hit?.face || hit.faceIndex == null) {
        if (hit) {
          const hitPart = parts.find(p => p.mesh === hit.object);
          return { point: hit.point, attachment: this.makeAttachment(hitPart, hit.point), hint: "Surface point" };
        }
        if (this.start) {
          const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
          return point ? { point, attachment: this.makeAttachment(undefined, point), hint: "Workplane point" } : null;
        }
        return null;
      }
      const part = parts.find(p => p.mesh === hit.object)!;
      const groupIndex = part.mesh.geometry.groups.findIndex(g => hit.faceIndex! * 3 >= g.start && hit.faceIndex! * 3 < g.start + g.count);
      const faceInfo = part.faces?.[groupIndex];
      const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      const attachment = this.makeAttachment(part, hit.point, normal);
      if (faceInfo && !faceInfo.planar) {
        return { point: hit.point, normal, attachment, hint: "Curved surface (not planar)" };
      }
      return { point: hit.point, normal, attachment, hint: faceInfo ? "Flat face" : "Mesh facet (approximate)" };
    }
    const screen = (p: THREE.Vector3) => {
      const q = p.clone().project(camera);
      return new THREE.Vector2(rect.left + ((q.x + 1) * rect.width) / 2, rect.top + ((1 - q.y) * rect.height) / 2);
    };
    const cursor = new THREE.Vector2(e.clientX, e.clientY);
    let bestPointDist = 14;
    let pickedPoint: (Pick & { distance: number }) | null = null;
    let bestEdgeDist = 10;
    let pickedEdge: (Pick & { distance: number }) | null = null;

    const visible = (p: THREE.Vector3) => {
      const q = p.clone().project(camera); if (q.z < -1 || q.z > 1) return false;
      const probe = new THREE.Raycaster(); probe.setFromCamera(new THREE.Vector2(q.x, q.y), camera);
      const front = probe.intersectObjects(parts.map(v => v.mesh), false)[0];
      if (!front) return true;
      const distToP = probe.ray.origin.distanceTo(p);
      return distToP <= front.distance + Math.max(1.0, front.distance * 0.015);
    };

    for (const part of parts) {
      const geometry = part.wire.geometry, pos = geometry.getAttribute("position");
      if (pos && pos.count > 0) {
        part.wire.updateWorldMatrix(true, false);
        const groups = geometry.groups && geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: pos.count }];
        for (const group of groups) {
          const points: THREE.Vector3[] = [];
          for (let i = group.start; i < group.start + group.count; i++) {
            points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(part.wire.matrixWorld));
          }
          for (let i = 0; i + 1 < points.length; i += 2) {
            const a = points[i], b = points[i + 1];
            const ab = b.clone().sub(a);
            const abLenSq = ab.lengthSq();

            if (this.mode === "edge") {
              if (abLenSq > 1e-8) {
                const ao = a.clone().sub(ray.ray.origin);
                const d = ray.ray.direction;
                const dDotAb = d.dot(ab), dDotAo = d.dot(ao), abDotAo = ab.dot(ao);
                const denom = abLenSq - dDotAb * dDotAb;
                const t = Math.abs(denom) > 1e-6 ? Math.max(0, Math.min(1, (dDotAb * dDotAo - abDotAo) / denom)) : 0;
                const point = a.clone().addScaledVector(ab, t);
                const distance = screen(point).distanceTo(cursor);
                if (distance < 14 && distance < bestEdgeDist && visible(point)) {
                  bestEdgeDist = distance;
                  pickedEdge = {
                    point,
                    edge: points,
                    attachment: this.makeAttachment(part, point, undefined, points),
                    hint: "Edge",
                    distance
                  };
                }
              }
            } else {
              if (this.snapPoints) {
                const cornerDistA = screen(a).distanceTo(cursor);
                if (cornerDistA < 14 && cornerDistA < bestPointDist && visible(a)) {
                  bestPointDist = cornerDistA;
                  pickedPoint = {
                    point: a.clone(),
                    attachment: this.makeAttachment(part, a),
                    hint: "Corner",
                    distance: cornerDistA
                  };
                }
                const cornerDistB = screen(b).distanceTo(cursor);
                if (cornerDistB < 14 && cornerDistB < bestPointDist && visible(b)) {
                  bestPointDist = cornerDistB;
                  pickedPoint = {
                    point: b.clone(),
                    attachment: this.makeAttachment(part, b),
                    hint: "Corner",
                    distance: cornerDistB
                  };
                }
                const mid = a.clone().lerp(b, 0.5);
                const midDist = screen(mid).distanceTo(cursor);
                if (midDist < 12 && midDist < bestPointDist && visible(mid)) {
                  bestPointDist = midDist;
                  pickedPoint = {
                    point: mid,
                    attachment: this.makeAttachment(part, mid),
                    hint: "Midpoint",
                    distance: midDist
                  };
                }
              }

              if (this.snapEdges && abLenSq > 1e-8) {
                const ao = a.clone().sub(ray.ray.origin);
                const d = ray.ray.direction;
                const dDotAb = d.dot(ab), dDotAo = d.dot(ao), abDotAo = ab.dot(ao);
                const denom = abLenSq - dDotAb * dDotAb;
                const t = Math.abs(denom) > 1e-6 ? Math.max(0, Math.min(1, (dDotAb * dDotAo - abDotAo) / denom)) : 0;
                const point = a.clone().addScaledVector(ab, t);
                const distance = screen(point).distanceTo(cursor);
                if (distance < 10 && distance < bestEdgeDist && visible(point)) {
                  bestEdgeDist = distance;
                  pickedEdge = {
                    point,
                    attachment: this.makeAttachment(part, point),
                    hint: "Edge point",
                    distance
                  };
                }
              }
            }
          }
        }
      }
    }

    if (this.mode === "edge") return pickedEdge;
    if (this.snapPoints && pickedPoint) return pickedPoint;
    if (this.snapEdges && pickedEdge) return pickedEdge;
    if (hit) {
      const hitPart = parts.find(p => p.mesh === hit.object);
      return { point: hit.point, attachment: this.makeAttachment(hitPart, hit.point), hint: "Surface point" };
    }
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return point ? { point, attachment: this.makeAttachment(undefined, point), hint: "Workplane point" } : null;
  }
  private reading(p: Pick): Reading | null {
    if (p.edge) {
      let length = 0;
      for (let i = 0; i + 1 < p.edge.length; i += 2) length += p.edge[i].distanceTo(p.edge[i + 1]);
      return {
        points: p.edge,
        length,
        kind: "Edge",
        startAttachment: p.attachment,
        mode: "edge"
      };
    }
    if (!this.start) return null;
    const a = this.start.point, b = p.point;
    if (this.mode === "faces") {
      if (!this.start.normal) return null;
      const dot = p.normal ? p.normal.dot(this.start.normal) : 0;
      const isParallel = Math.abs(Math.abs(dot) - 1.0) < 0.02 || Math.abs(dot) >= 0.98;
      if (!isParallel || !p.normal) {
        this.status.textContent = "Hover an opposite or parallel face to measure gap/thickness.";
        return {
          points: [a, b],
          length: a.distanceTo(b),
          kind: "Not parallel",
          startAttachment: this.start.attachment,
          endAttachment: p.attachment,
          mode: "faces"
        };
      }
      const offset = b.clone().sub(a).dot(this.start.normal);
      const projOnFace1 = b.clone().addScaledVector(this.start.normal, -offset);
      const length = Math.abs(offset);
      this.status.textContent = `Parallel face • Gap: ${this.value(length)} • Click to pin.`;
      return {
        points: [projOnFace1, b],
        length,
        kind: this.start.hint.startsWith("Mesh") || p.hint.startsWith("Mesh") ? "Facet gap ≈" : "Gap",
        startAttachment: this.start.attachment,
        endAttachment: p.attachment,
        mode: "faces"
      };
    }
    return {
      points: [a, b],
      length: a.distanceTo(b),
      kind: "Distance",
      delta: b.clone().sub(a),
      startAttachment: this.start.attachment,
      endAttachment: p.attachment,
      mode: "points"
    };
  }
  private add(reading: Reading, id = this.serial + 1): Mark {
    const geometry = new LineSegmentsGeometry(); geometry.setPositions(reading.points.flatMap(p => p.toArray()));
    const outline = new LineSegments2(geometry, new LineMaterial({ color: 0xffffff, linewidth: 2.6, depthTest: false, depthWrite: false })); outline.renderOrder = 100;
    const line = new LineSegments2(geometry, new LineMaterial({ color: new THREE.Color(this.lineColor).getHex(), linewidth: 1.4, depthTest: false, depthWrite: false })); line.renderOrder = 101;
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(reading.points), new THREE.PointsMaterial({ color: new THREE.Color(this.lineColor).getHex(), size: 6, sizeAttenuation: false, depthTest: false, depthWrite: false })); dots.renderOrder = 102;
    this.layer.add(outline, line, dots);
    const label = document.createElement("div");
    label.className = "tape-label";
    const chip = document.createElement("span");
    chip.className = "tape-chip";
    const val = document.createElement("span");
    val.className = "tape-val";
    label.append(chip, val);
    this.host.append(label);
    return { id, reading, line, outline, dots, label };
  }

  move(e: PointerEvent) {
    if (e.buttons) return;
    const p = this.pick(e);
    this.drop(this.preview);
    this.preview = null;
    if (!p) {
      this.status.textContent = this.mode === "faces" ? (this.start ? "Hover over an opposite or parallel face." : "Hover over a flat face to start.") : "Hover a visible edge.";
      return;
    }
    if (!this.start) {
      this.status.textContent = `${p.hint} • ${this.mode === "edge" ? "Click to pin." : "Click to start."}`;
      this.preview = this.add({ points: [p.point, p.point], length: 0, kind: p.hint, startAttachment: p.attachment });
      this.preview.label.dataset.hint = p.hint;
      return;
    }
    const reading = this.reading(p);
    if (reading) {
      this.preview = this.add(reading);
      if (reading.kind === "Not parallel") {
        this.preview.label.dataset.hint = "not-parallel";
      }
    }
  }
  click(e: PointerEvent) {
    const p = this.pick(e); if (!p) return;
    if (this.mode !== "edge" && !this.start) {
      if (this.mode === "faces" && p.hint.startsWith("Curved")) {
        this.status.textContent = "Gap tool requires a flat planar face. Click a flat face to start.";
        return;
      }
      this.start = p;
      this.startMark = this.add({ points: [p.point, p.point], length: 0, kind: "Start", startAttachment: p.attachment });
      this.startMark.label.dataset.hint = "start";
      this.status.textContent = this.mode === "faces" ? "Start face selected. Hover over an opposite or parallel face to measure." : "Start point selected. Hover and click a second point to measure distance.";
      return;
    }
    const reading = this.reading(p);
    if (!reading || reading.kind === "Not parallel" || (this.mode !== "faces" && reading.length < 1e-7)) return;
    const id = ++this.serial;
    const mark = this.add(reading, id);
    this.pins.push(mark);
    mark.label.classList.add("tape-pinned");
    const swap = document.createElement("span"); swap.className = "tape-swap"; swap.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>Delete'; swap.setAttribute("aria-label", "Delete measurement " + id);
    mark.label.append(swap);
    mark.label.addEventListener("pointerdown", event => event.stopPropagation());
    const erase = () => { this.drop(mark); this.pins = this.pins.filter(p => p !== mark); };
    mark.label.onclick = event => { event.stopPropagation(); erase(); };
    mark.label.tabIndex = 0;
    const row = document.createElement("div"), badge = document.createElement("span"), name = document.createElement("span"), value = document.createElement("span"), rowRemove = document.createElement("button");
    row.className = "tape-saved-row"; badge.className = "tape-number"; badge.textContent = String(id); name.textContent = reading.kind;
    value.className = "tape-saved-value"; mark.value = value; mark.row = row;
    rowRemove.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5"/></svg>';
    rowRemove.setAttribute("aria-label", "Delete measurement " + id);
    rowRemove.title = "Delete measurement " + id;
    rowRemove.onclick = (e) => { e.stopPropagation(); erase(); };
    const highlight = (active: boolean) => {
      mark.label.classList.toggle("tape-highlight", active);
      row.classList.toggle("tape-highlight", active);
      const baseColor = new THREE.Color(this.lineColor).getHex();
      const highlightColor = 0x00a7a5;
      mark.line.material.color.set(active ? highlightColor : baseColor);
      mark.line.material.linewidth = active ? 3.0 : 1.4;
      mark.outline.material.linewidth = active ? 4.6 : 2.6;
      (mark.dots.material as THREE.PointsMaterial).color.set(active ? highlightColor : baseColor);
      (mark.dots.material as THREE.PointsMaterial).size = active ? 10 : 6;
    };
    row.onmouseenter = () => highlight(true);
    row.onmouseleave = () => highlight(false);
    row.addEventListener("focusin", () => highlight(true));
    row.addEventListener("focusout", () => highlight(false));
    mark.label.onmouseenter = () => highlight(true);
    mark.label.onmouseleave = () => highlight(false);
    row.append(badge, name, value, rowRemove);
    this.list.append(row);
    this.cancel();
  }
  private value(length: number) { const f = this.format(); return `${formatLength(length, f.unit, f.decimals)} ${f.unit}`; }

  private updateMark(mark: Mark, partsMap: Map<string, Part>): void {
    const reading = mark.reading;
    if (!reading.startAttachment) return;

    const resolvePoint = (att: Attachment): { point: THREE.Vector3; normal?: THREE.Vector3; edge?: THREE.Vector3[] } => {
      if (!att.partId) {
        return {
          point: att.localPoint.clone(),
          normal: att.localNormal?.clone(),
          edge: att.localEdge?.map(p => p.clone())
        };
      }
      const part = partsMap.get(att.partId);
      if (!part) {
        return {
          point: att.localPoint.clone(),
          normal: att.localNormal?.clone(),
          edge: att.localEdge?.map(p => p.clone())
        };
      }
      part.group.updateWorldMatrix(true, false);
      const worldPoint = att.localPoint.clone().applyMatrix4(part.group.matrixWorld);
      let worldNormal: THREE.Vector3 | undefined;
      if (att.localNormal) {
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(part.group.matrixWorld);
        worldNormal = att.localNormal.clone().applyMatrix3(normalMatrix).normalize();
      }
      let worldEdge: THREE.Vector3[] | undefined;
      if (att.localEdge) {
        worldEdge = att.localEdge.map(p => p.clone().applyMatrix4(part.group.matrixWorld));
      }
      return { point: worldPoint, normal: worldNormal, edge: worldEdge };
    };

    if (reading.mode === "edge" && reading.startAttachment.localEdge) {
      const res = resolvePoint(reading.startAttachment);
      if (res.edge && res.edge.length >= 2) {
        reading.points = res.edge;
        let length = 0;
        for (let i = 0; i + 1 < res.edge.length; i += 2) length += res.edge[i].distanceTo(res.edge[i + 1]);
        reading.length = length;
      }
    } else if (reading.startAttachment && reading.endAttachment) {
      const resA = resolvePoint(reading.startAttachment);
      const resB = resolvePoint(reading.endAttachment);
      const a = resA.point, b = resB.point;

      if (reading.mode === "faces" && resA.normal) {
        const offset = b.clone().sub(a).dot(resA.normal);
        const projA = b.clone().addScaledVector(resA.normal, -offset);
        reading.points = [projA, b];
        reading.length = Math.abs(offset);
      } else {
        reading.points = [a, b];
        reading.length = a.distanceTo(b);
        reading.delta = b.clone().sub(a);
      }
    }

    const coords = reading.points.flatMap(p => p.toArray());
    if (coords.length >= 6) {
      mark.line.geometry.setPositions(coords);
      mark.outline.geometry.setPositions(coords);
      mark.dots.geometry.setFromPoints(reading.points);
    }
  }

  render() {
    const partsList = this.parts();
    const partsMap = new Map<string, Part>();
    for (const p of partsList) {
      if (p.id) partsMap.set(p.id, p);
    }

    if (!this.keepVisible && partsList.length === 0 && this.pins.length > 0) {
      this.clear();
    }

    if (!this.active && (!this.keepVisible || this.pins.length === 0)) return;
    const rect = this.getCanvasRect();
    const marksToRender = this.active ? [...this.pins, ...(this.preview ? [this.preview] : []), ...(this.startMark ? [this.startMark] : [])] : this.pins;
    for (const mark of marksToRender) {
      this.updateMark(mark, partsMap);

      mark.line.material.resolution.set(rect.width, rect.height); mark.outline.material.resolution.set(rect.width, rect.height);
      const projected = mark.reading.points.map(point => point.clone().project(this.camera()));
      const segments: { a: THREE.Vector3; b: THREE.Vector3; length: number }[] = [];
      let total = 0;
      for (let i = 0; i + 1 < projected.length; i += 2) {
        const a = projected[i], b = projected[i + 1];
        const length = Math.hypot((b.x - a.x) * rect.width / 2, (b.y - a.y) * rect.height / 2);
        segments.push({ a, b, length }); total += length;
      }
      let remaining = total / 2, p = projected[0].clone();
      for (const segment of segments) {
        if (remaining <= segment.length) { p = segment.a.clone().lerp(segment.b, segment.length ? remaining / segment.length : 0); break; }
        remaining -= segment.length;
      }
      mark.label.hidden = !(this.active || this.keepVisible) || !!mark.label.dataset.hint || p.z < -1 || p.z > 1;
      mark.label.style.left = `${(p.x + 1) * rect.width / 2}px`; mark.label.style.top = `${(1 - p.y) * rect.height / 2}px`;
      mark.label.style.transform = total >= Math.max(80, mark.label.offsetWidth + 28) ? "translate(-50%, -50%)" : "translate(-50%, -135%)";
      const chipEl = mark.label.querySelector<HTMLSpanElement>(".tape-chip");
      if (chipEl) {
        if (this.showNumbers && mark.id > 0) {
          chipEl.textContent = String(mark.id);
          chipEl.style.display = "flex";
        } else {
          chipEl.style.display = "none";
        }
      }
      const valEl = mark.label.querySelector<HTMLSpanElement>(".tape-val");
      if (valEl) {
        valEl.textContent = this.value(mark.reading.length);
      }
      if (mark.value) mark.value.textContent = this.value(mark.reading.length);
      mark.label.title = mark.reading.kind + (mark.reading.delta ? " · " + ["X", "Y", "Z"].map((axis, i) => axis + " " + this.value(Math.abs(mark.reading.delta!.getComponent(i)))).join(" · ") : "");
    }
  }
  dispose() { window.removeEventListener("keydown", this.onKeyDown, true); this.clear(); this.layer.removeFromParent(); this.panel.remove(); }
}


