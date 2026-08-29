import { PRIMITIVES } from "./types";
import type {
  BooleanOp,
  CameraMode,
  EditOp,
  PrimitiveKind,
  ProjectData,
  ProjectFile,
  ProjectMeta,
  SceneNode,
  Vec3,
} from "./types";

const INDEX_KEY = "cad.projects_index";
const ACTIVE_PROJECT_KEY = "cad.active_project_id";
const PROJECT_PREFIX = "cad.project.";
const LEGACY_KEY = "cad.document";
const CAMERA_KEY = "cad.camera";
const VERSION = 1;

interface StoredLegacy {
  version: number;
  nodes: unknown;
}

const OPS: BooleanOp[] = ["union", "subtract", "intersect"];

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * Saved JSON is untrusted — it may be from an older build, hand-edited, or
 * truncated. Anything that does not match is dropped rather than crashing the
 * kernel later with a half-formed node.
 */
export function parseNode(raw: unknown): SceneNode | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;

  if (typeof n.id !== "string" || typeof n.name !== "string") return null;
  if (!isVec3(n.position) || !isVec3(n.rotation)) return null;
  const base = {
    id: n.id,
    name: n.name,
    position: n.position,
    rotation: n.rotation,
    scale: isVec3(n.scale)
      ? (n.scale.map((v) => Math.max(0.01, v)) as Vec3)
      : typeof n.scale === "number" && Number.isFinite(n.scale) && n.scale > 0
        ? ([n.scale, n.scale, n.scale] as Vec3)
        : ([1, 1, 1] as Vec3),
    isHole: n.isHole === true,
    color: typeof n.color === "string" && /^#[0-9a-fA-F]{6}$/.test(n.color) ? n.color : undefined,
    transparent: typeof n.transparent === "boolean" ? n.transparent : undefined,
    hidden: n.hidden === true,
  };

  if (n.type === "group") {
    if (!Array.isArray(n.children)) return null;
    const op = OPS.includes(n.op as BooleanOp) ? (n.op as BooleanOp) : "union";
    const children = n.children.map(parseNode).filter((c): c is SceneNode => c !== null);
    return { ...base, type: "group", op, children, collapsed: n.collapsed === true };
  }

  if (n.type === "object") {
    const kind = n.kind as PrimitiveKind;
    if (!kind || !(kind in PRIMITIVES)) return null;
    if (!n.params || typeof n.params !== "object") return null;

    // Fill in any parameter added since the save was written.
    const params: Record<string, number> = { ...PRIMITIVES[kind].defaults };
    for (const [k, v] of Object.entries(n.params as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
    }
    return { ...base, type: "object", kind, params };
  }

  if (n.type === "build") {
    if (!Array.isArray(n.sources) || !Array.isArray(n.keep)) return null;
    const sources = n.sources.map(parseNode).filter((s): s is SceneNode => s !== null);
    if (sources.length < 2) return null;
    const limit = 1 << sources.length;
    const keep = (n.keep as unknown[]).filter(
      (m): m is number => typeof m === "number" && Number.isInteger(m) && m > 0 && m < limit,
    );
    if (!keep.length) return null;
    return { ...base, type: "build", sources, keep };
  }

  if (n.type === "import") {
    if (typeof n.blobId !== "string" || typeof n.fileName !== "string") return null;
    if (typeof n.byteSize !== "number") return null;
    const raw = n.svg as { thickness?: unknown; width?: unknown; height?: unknown } | undefined;
    const svg =
      raw && typeof raw.thickness === "number" && Number.isFinite(raw.thickness)
        ? {
            thickness: Math.max(0.1, raw.thickness),
            width: typeof raw.width === "number" ? raw.width : 0,
            height: typeof raw.height === "number" ? raw.height : 0,
          }
        : undefined;
    return {
      ...base,
      type: "import",
      blobId: n.blobId,
      fileName: n.fileName,
      byteSize: n.byteSize,
      svg,
    };
  }

  if (n.type === "edit") {
    const parsedBase = parseNode(n.base);
    if (!parsedBase || (parsedBase.type !== "object" && parsedBase.type !== "group")) return null;
    if (!Array.isArray(n.ops)) return null;
    const ops = n.ops.map(parseOp).filter((op): op is EditOp => op !== null);
    // Losing the edits is bad; losing the OBJECT is worse. An edit node whose
    // op list cannot be read still has a perfectly good base shape, and
    // returning null here deleted the whole thing — which is exactly what "I
    // refreshed the page and my extruded object is gone" was: one unreadable
    // op, and the box went with it.
    if (!ops.length) return { ...parsedBase, id: base.id, name: base.name, position: base.position, rotation: base.rotation, scale: base.scale, isHole: base.isHole };
    return { ...base, type: "edit", base: parsedBase, ops };
  }

  return null;
}

function parseOp(raw: unknown): EditOp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "fillet" || o.kind === "chamfer") {
    if (!isVec3(o.point) || typeof o.distance !== "number" || !Number.isFinite(o.distance) || o.distance <= 0) return null;
    const points = Array.isArray(o.points) ? o.points.filter(isVec3) : undefined;
    return { kind: o.kind, point: o.point, points: points?.length ? points : undefined, distance: o.distance };
  }
  if (o.kind === "shell") {
    if (typeof o.thickness !== "number" || !Number.isFinite(o.thickness) || o.thickness <= 0) return null;
    const points = Array.isArray(o.points) ? o.points.filter(isVec3) : [];
    return { kind: "shell", thickness: o.thickness, points };
  }
  if (o.kind === "resizeFace") {
    if (!isVec3(o.point) || !isVec3(o.normal)) return null;
    if (typeof o.offset !== "number" || !Number.isFinite(o.offset)) return null;
    return { kind: "resizeFace", point: o.point, normal: o.normal, offset: o.offset };
  }
  if (o.kind === "offsetExtrude") {
    if (!isVec3(o.point) || !isVec3(o.normal)) return null;
    if (typeof o.inset !== "number" || !Number.isFinite(o.inset)) return null;
    if (typeof o.height !== "number" || !Number.isFinite(o.height)) return null;
    return { kind: "offsetExtrude", point: o.point, normal: o.normal, inset: o.inset, height: o.height };
  }
  // An op kind this build has never heard of is still somebody's work, and
  // the kernel already knows to report and skip one rather than misapply it
  // (see replayEdit). Deleting it here instead — which is what happened when
  // offsetExtrude was added without teaching this function about it — takes
  // the edit out of the saved file for good the next time it is written.
  if (typeof o.kind === "string" && o.kind !== "pushPull") return o as unknown as EditOp;
  if (!isVec3(o.point) || !isVec3(o.normal)) return null;
  if (typeof o.distance !== "number" || !Number.isFinite(o.distance)) return null;
  return { point: o.point, normal: o.normal, distance: o.distance };
}

export function parseProjectData(raw: unknown): ProjectData | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.name !== "string") return null;
  if (!Array.isArray(p.nodes)) return null;

  const nodes = p.nodes.map(parseNode).filter((n): n is SceneNode => n !== null);
  const createdAt = typeof p.createdAt === "number" ? p.createdAt : Date.now();
  const updatedAt = typeof p.updatedAt === "number" ? p.updatedAt : Date.now();
  let camera: StoredCamera | null = null;
  if (p.camera && typeof p.camera === "object") {
    const c = p.camera as Record<string, unknown>;
    if (
      (c.mode === "perspective" || c.mode === "orthographic") &&
      isVec3(c.position) &&
      isVec3(c.target)
    ) {
      camera = {
        mode: c.mode,
        position: c.position,
        target: c.target,
        zoom: typeof c.zoom === "number" ? c.zoom : undefined,
      };
    }
  }

  return {
    version: VERSION,
    id: p.id,
    name: p.name,
    createdAt,
    updatedAt,
    nodes,
    camera,
  };
}

/** Lists all saved project summaries. Automatically migrates legacy cad.document if present. */
export function listProjects(): ProjectMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectMeta[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      }
    }
  } catch {
    /* fallback to migration below */
  }

  // Check legacy document or create initial project
  const initialNodes = loadLegacyDocument();
  const initialProject: ProjectData = {
    version: VERSION,
    id: `p-${Date.now()}`,
    name: initialNodes.length ? "My First Design" : "Untitled Project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes: initialNodes,
    camera: loadCameraState(),
  };

  saveProject(initialProject);
  setActiveProjectId(initialProject.id);

  return [
    {
      id: initialProject.id,
      name: initialProject.name,
      createdAt: initialProject.createdAt,
      updatedAt: initialProject.updatedAt,
      objectCount: initialProject.nodes.length,
    },
  ];
}

export function getActiveProjectId(): string {
  try {
    const active = localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (active) return active;
  } catch {
    /* ignore */
  }
  const list = listProjects();
  return list[0]?.id ?? `p-${Date.now()}`;
}

export function setActiveProjectId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    /* ignore */
  }
}

export function loadProject(id: string): ProjectData | null {
  try {
    const raw = localStorage.getItem(PROJECT_PREFIX + id);
    if (!raw) return null;
    return parseProjectData(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveProject(project: ProjectData): boolean {
  try {
    localStorage.setItem(PROJECT_PREFIX + project.id, JSON.stringify(project));

    // Update index
    let list: ProjectMeta[] = [];
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      if (raw) list = (JSON.parse(raw) as ProjectMeta[]) || [];
    } catch {
      list = [];
    }

    const meta: ProjectMeta = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      objectCount: project.nodes.length,
    };

    const existingIdx = list.findIndex((p) => p.id === project.id);
    if (existingIdx >= 0) {
      list[existingIdx] = meta;
    } else {
      list.push(meta);
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));

    return true;
  } catch {
    return false;
  }
}

export function deleteProjectStorage(id: string): boolean {
  try {
    localStorage.removeItem(PROJECT_PREFIX + id);
    const raw = localStorage.getItem(INDEX_KEY);
    if (raw) {
      const list = (JSON.parse(raw) as ProjectMeta[]).filter((p) => p.id !== id);
      localStorage.setItem(INDEX_KEY, JSON.stringify(list));
    }
    return true;
  } catch {
    return false;
  }
}

function loadLegacyDocument(): SceneNode[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredLegacy;
    if (parsed?.version !== VERSION || !Array.isArray(parsed.nodes)) return [];
    return parsed.nodes.map(parseNode).filter((n): n is SceneNode => n !== null);
  } catch {
    return [];
  }
}

/** Largest numeric id suffix in the tree, so restored ids are never reissued. */
export function highestIdSuffix(nodes: SceneNode[]): number {
  let max = 0;
  const walk = (list: SceneNode[]) => {
    for (const n of list) {
      const m = /^n-(\d+)$/.exec(n.id);
      if (m) max = Math.max(max, Number(m[1]));
      if (n.type === "group") walk(n.children);
      if (n.type === "edit") walk([n.base]);
      if (n.type === "build") walk(n.sources);
    }
  };
  walk(nodes);
  return max;
}

export interface StoredCamera {
  mode: CameraMode;
  position: Vec3;
  target: Vec3;
  zoom?: number;
}

export function loadCameraState(): StoredCamera | null {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCamera>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.mode !== "perspective" && parsed.mode !== "orthographic") return null;
    if (!isVec3(parsed.position) || !isVec3(parsed.target)) return null;
    const zoom =
      typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom) && parsed.zoom > 0
        ? parsed.zoom
        : undefined;
    return {
      mode: parsed.mode,
      position: parsed.position,
      target: parsed.target,
      zoom,
    };
  } catch {
    return null;
  }
}

export function saveCameraState(state: StoredCamera): boolean {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Exports project to a downloadable .shapeforge file. */
export function exportProjectFile(project: ProjectData) {
  const fileData: ProjectFile = {
    format: "shapeforge",
    version: VERSION,
    id: project.id,
    name: project.name,
    exportedAt: Date.now(),
    nodes: project.nodes,
    camera: project.camera ?? loadCameraState(),
  };

  const jsonStr = JSON.stringify(fileData, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = project.name.trim().replace(/[/\\?%*:|"<>]/g, "_") || "Untitled Project";
  a.download = `${safeName}.shapeforge`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Parses project file from string content (supports .shapeforge and general CAD json). */
export function parseProjectFile(content: string, fallbackName = "Imported Project"): ProjectData | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return null;

    let nodesRaw: unknown = raw.nodes;
    if (!Array.isArray(nodesRaw) && Array.isArray(raw)) {
      nodesRaw = raw; // raw array of nodes
    }

    if (!Array.isArray(nodesRaw)) return null;

    const nodes = nodesRaw.map(parseNode).filter((n): n is SceneNode => n !== null);
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName;
    const id = `p-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    let camera: StoredCamera | null = null;
    if (raw.camera && typeof raw.camera === "object") {
      const c = raw.camera as Record<string, unknown>;
      if (
        (c.mode === "perspective" || c.mode === "orthographic") &&
        isVec3(c.position) &&
        isVec3(c.target)
      ) {
        camera = {
          mode: c.mode,
          position: c.position,
          target: c.target,
          zoom: typeof c.zoom === "number" ? c.zoom : undefined,
        };
      }
    }

    return {
      version: VERSION,
      id,
      name,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      updatedAt: Date.now(),
      nodes,
      camera,
    };
  } catch {
    return null;
  }
}

