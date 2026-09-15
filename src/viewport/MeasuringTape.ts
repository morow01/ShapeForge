import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import * as THREE from "three";
import { formatLength, type DisplayUnit } from "../measurement";
import type { FaceInfo } from "../kernel/types";

type Part = { mesh: THREE.Mesh; wire: THREE.LineSegments; group: THREE.Group; faces?: FaceInfo[] };
type Pick = { point: THREE.Vector3; normal?: THREE.Vector3; edge?: THREE.Vector3[]; hint: string };
type Reading = { points: THREE.Vector3[]; length: number; kind: string; delta?: THREE.Vector3 };
type Mark = { row?: HTMLDivElement; value?: HTMLSpanElement; id: number; reading: Reading; line: LineSegments2; outline: LineSegments2; dots: THREE.Points; label: HTMLDivElement };

/** Read-only measurements of displayed geometry. Cleared when geometry changes. */
export class MeasuringTape {
  private active = false;
  private mode = "points";
  private start: Pick | null = null;
  private preview: Mark | null = null;
  private pins: Mark[] = [];
  private panel = document.createElement("section");
  private list = document.createElement("div");
  private status = document.createElement("p");
  private layer = new THREE.Group();
  private signature = "";
  private serial = 0;
  private host: HTMLElement;
  private camera: () => THREE.Camera;
  private parts: () => Part[];
  private format: () => { unit: DisplayUnit; decimals: number };
  constructor(host: HTMLElement, scene: THREE.Scene,
    camera: () => THREE.Camera, parts: () => Part[],
    format: () => { unit: DisplayUnit; decimals: number }) {
    this.host = host; this.camera = camera; this.parts = parts; this.format = format;
    scene.add(this.layer);
    this.panel.className = "tape-panel"; this.panel.setAttribute("aria-label", "Measuring tape");
    const heading = document.createElement("strong"); heading.textContent = "Measuring tape";
    const modes = document.createElement("div"); modes.className = "tape-modes";
    for (const [mode, name] of [["points", "Point to point"], ["faces", "Gap / thickness"], ["edge", "Edge length"]] as const) {
      const button = document.createElement("button"); button.textContent = name; button.setAttribute("aria-pressed", String(mode === this.mode));
      button.onclick = () => { this.setMode(mode); for (const child of modes.children) child.setAttribute("aria-pressed", String(child === button)); }; modes.append(button);
    }
    this.list.className = "tape-saved-list"; this.status.setAttribute("aria-live", "polite");
    const cancel = document.createElement("button"); cancel.textContent = "Cancel current"; cancel.onclick = () => this.cancel();
    const clear = document.createElement("button"); clear.textContent = "Clear all"; clear.onclick = () => this.clear();
    const note = document.createElement("small"); note.textContent = "Hover a row to highlight its line. Hover or click a dimension in the scene to reveal ×. Measurements clear when the model changes.";
    this.panel.append(heading, modes, this.status, this.list, cancel, clear, note); this.setActive(false);
  }
  mountPanel(host: HTMLElement) { host.append(this.panel); }
  setMode(mode: "points" | "faces" | "edge") { this.mode = mode; this.cancel(); }
  setActive(active: boolean) { this.active = active; this.panel.hidden = !active; this.layer.visible = active; this.cancel(); for (const p of this.pins) p.label.hidden = !active; }
  private instruction() { return this.mode === "edge" ? "Hover an edge, then click to pin its length." : this.mode === "faces" ? "Select two parallel flat faces. Imported meshes use the clicked facets." : "Select a start point. Corners and edge midpoints snap automatically."; }
  cancel() { this.start = null; this.drop(this.preview); this.preview = null; this.status.textContent = this.instruction(); }
  clear() { this.cancel(); for (const p of this.pins) this.drop(p); this.pins = []; this.serial = 0;  }
  private drop(mark: Mark | null) { if (!mark) return; mark.line.removeFromParent(); mark.outline.removeFromParent(); mark.outline.material.dispose(); mark.dots.removeFromParent(); mark.dots.geometry.dispose(); (mark.dots.material as THREE.Material).dispose(); mark.line.geometry.dispose(); (mark.line.material as THREE.Material).dispose(); mark.label.remove(); mark.row?.remove(); }
  private pick(e: PointerEvent): Pick | null {
    const rect = this.host.getBoundingClientRect(), camera = this.camera();
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2), camera);
    const parts = this.parts().filter(p => p.group.visible);
    const hit = ray.intersectObjects(parts.map(p => p.mesh), false)[0];
    if (this.mode === "faces") {
      if (!hit?.face || hit.faceIndex == null) return null;
      const part = parts.find(p => p.mesh === hit.object)!;
      const groupIndex = part.mesh.geometry.groups.findIndex(g => hit.faceIndex! * 3 >= g.start && hit.faceIndex! * 3 < g.start + g.count);
      const faceInfo = part.faces?.[groupIndex];
      if (faceInfo && !faceInfo.planar) return null;
      return { point: hit.point, normal: hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize(), hint: faceInfo ? "Flat face" : "Mesh facet (approximate)" };
    }
    const screen = (p: THREE.Vector3) => { const q = p.clone().project(camera); return new THREE.Vector2(rect.left + (q.x + 1) * rect.width / 2, rect.top + (1 - q.y) * rect.height / 2); };
    const cursor = new THREE.Vector2(e.clientX, e.clientY);
    let best = 11, picked: Pick | null = null;
    const visible = (p: THREE.Vector3) => {
      const q = p.clone().project(camera); if (q.z < -1 || q.z > 1) return false;
      const probe = new THREE.Raycaster(); probe.setFromCamera(new THREE.Vector2(q.x, q.y), camera);
      const front = probe.intersectObjects(parts.map(v => v.mesh), false)[0];
      return !front || probe.ray.origin.distanceTo(p) <= front.distance + 0.05;
    };
    for (const part of parts) {
      const geometry = part.wire.geometry, pos = geometry.getAttribute("position"); if (!pos) continue;
      part.wire.updateWorldMatrix(true, false);
      for (const group of geometry.groups) {
        const points: THREE.Vector3[] = [];
        for (let i = group.start; i < group.start + group.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(part.wire.matrixWorld));
        for (let i = 0; i + 1 < points.length; i += 2) {
          const a = points[i], b = points[i + 1];
          if (this.mode === "edge") {
            const sa = screen(a), sb = screen(b), d = sb.clone().sub(sa);
            const t = Math.max(0, Math.min(1, cursor.clone().sub(sa).dot(d) / (d.lengthSq() || 1)));
            const distance = cursor.distanceTo(sa.addScaledVector(d, t)); const point = a.clone().lerp(b, t);
            if (distance < best && visible(point)) { best = distance; picked = { point, edge: points, hint: "Edge" }; }
          } else if (points.length === 2) {
            for (const [point, hint] of [[a, "Corner"], [b, "Corner"], [a.clone().lerp(b, 0.5), "Midpoint"]] as const) {
              const distance = screen(point).distanceTo(cursor);
              if (distance < best && visible(point)) { best = distance; picked = { point: point.clone(), hint }; }
            }
          }
        }
      }
    }
    if (picked) return picked;
    if (this.mode === "edge") return null;
    if (hit) return { point: hit.point, hint: "Surface point" };
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return point ? { point, hint: "Workplane point" } : null;
  }
  private reading(p: Pick): Reading | null {
    if (p.edge) { let length = 0; for (let i = 0; i + 1 < p.edge.length; i += 2) length += p.edge[i].distanceTo(p.edge[i + 1]); return { points: p.edge, length, kind: "Edge" }; }
    if (!this.start) return null;
    const a = this.start.point, b = p.point;
    if (this.mode === "faces") {
      if (!p.normal || !this.start.normal || Math.abs(p.normal.dot(this.start.normal)) < 0.99999) { this.status.textContent = "Choose a flat face parallel to the first face."; return null; }
      const offset = b.clone().sub(a).dot(this.start.normal);
      return { points: [a, a.clone().addScaledVector(this.start.normal, offset)], length: Math.abs(offset), kind: this.start.hint.startsWith("Mesh") || p.hint.startsWith("Mesh") ? "Facet gap ≈" : "Gap" };
    }
    return { points: [a, b], length: a.distanceTo(b), kind: "Distance", delta: b.clone().sub(a) };
  }
  private add(reading: Reading, id = this.serial + 1): Mark {
    const geometry = new LineSegmentsGeometry(); geometry.setPositions(reading.points.flatMap(p => p.toArray()));
    const outline = new LineSegments2(geometry, new LineMaterial({ color: 0xffffff, linewidth: 2.6, depthTest: false, depthWrite: false })); outline.renderOrder = 100;
    const line = new LineSegments2(geometry, new LineMaterial({ color: 0x31556b, linewidth: 1.4, depthTest: false, depthWrite: false })); line.renderOrder = 101;
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(reading.points), new THREE.PointsMaterial({ color: 0x31556b, size: 4, sizeAttenuation: false, depthTest: false, depthWrite: false })); dots.renderOrder = 102;
    this.layer.add(outline, line, dots); const label = document.createElement("div"); label.className = "tape-label"; label.append(document.createElement("span")); this.host.append(label);
    return { id, reading, line, outline, dots, label };
  }

  move(e: PointerEvent) {
    if (e.buttons) return;
    const p = this.pick(e); this.drop(this.preview); this.preview = null; 
    if (!p) { this.status.textContent = this.mode === "faces" ? "Choose a flat face or mesh facet." : "Hover a visible edge."; return; }
    this.status.textContent = `${p.hint} • ${this.start ? "Click endpoint to pin." : this.mode === "edge" ? "Click to pin." : "Click to start."}`;
    const reading = this.reading(p);
    if (reading) this.preview = this.add(reading);
    else if (!this.start) { this.preview = this.add({ points: [p.point, p.point], length: 0, kind: p.hint }); this.preview.label.dataset.hint = p.hint; }
  }
  click(e: PointerEvent) {
    const p = this.pick(e); if (!p) return;
    if (this.mode !== "edge" && !this.start) { this.start = p; this.status.textContent = "Start selected. Choose the endpoint."; return; }
    const reading = this.reading(p); if (!reading || (this.mode !== "faces" && reading.length < 1e-7)) return;
    const id = ++this.serial;
    const mark = this.add(reading, id); this.pins.push(mark);
    const remove = document.createElement("button"); remove.className = "tape-remove"; remove.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>'; remove.setAttribute("aria-label", "Remove measurement " + id);
    mark.label.addEventListener("pointerdown", event => event.stopPropagation());
    const erase = () => { this.drop(mark); this.pins = this.pins.filter(p => p !== mark); };
    remove.onclick = event => { event.stopPropagation(); erase(); };
    mark.label.tabIndex = 0;
    mark.label.onclick = () => mark.label.focus();
    const row = document.createElement("div"), badge = document.createElement("span"), name = document.createElement("span"), value = document.createElement("span"), rowRemove = document.createElement("button");
    row.className = "tape-saved-row"; badge.className = "tape-number"; badge.textContent = String(id); name.textContent = reading.kind;
    value.className = "tape-saved-value"; mark.value = value; mark.row = row;
    rowRemove.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>'; rowRemove.setAttribute("aria-label", "Delete measurement " + id); rowRemove.onclick = erase;
    const highlight = (active: boolean) => { mark.label.classList.toggle("tape-highlight", active); row.classList.toggle("tape-highlight", active); };
    row.onmouseenter = () => highlight(true); row.onmouseleave = () => highlight(false);
    row.addEventListener("focusin", () => highlight(true)); row.addEventListener("focusout", () => highlight(false));
    mark.label.onmouseenter = () => highlight(true); mark.label.onmouseleave = () => highlight(false);
    row.append(badge, name, value, rowRemove); this.list.append(row);
    mark.label.append(remove); this.cancel();
  }
  private value(length: number) { const f = this.format(); return `${formatLength(length, f.unit, f.decimals)} ${f.unit}`; }
  render() {
    const signature = this.parts().map(p => { p.mesh.updateWorldMatrix(true, false); return `${p.mesh.geometry.uuid}:${p.group.visible}:${p.mesh.matrixWorld.elements.join(",")}`; }).join(";");
    if (this.signature && signature !== this.signature) this.clear(); this.signature = signature;
    if (!this.active) return;
    const rect = this.host.getBoundingClientRect();
    for (const mark of [...this.pins, ...(this.preview ? [this.preview] : [])]) {
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
      mark.label.hidden = !!mark.label.dataset.hint || p.z < -1 || p.z > 1;
      mark.label.style.left = `${(p.x + 1) * rect.width / 2}px`; mark.label.style.top = `${(1 - p.y) * rect.height / 2}px`;
      mark.label.style.transform = total >= Math.max(80, mark.label.offsetWidth + 28) ? "translate(-50%, -50%)" : "translate(-50%, -135%)";

      mark.label.querySelector("span")!.textContent = this.value(mark.reading.length);
      if (mark.value) mark.value.textContent = this.value(mark.reading.length);
      mark.label.title = mark.reading.kind + (mark.reading.delta ? " · " + ["X", "Y", "Z"].map((axis, i) => axis + " " + this.value(Math.abs(mark.reading.delta!.getComponent(i)))).join(" · ") : "");
    }


  }
  dispose() { this.clear(); this.layer.removeFromParent(); this.panel.remove(); }
}


