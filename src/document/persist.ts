import { PRIMITIVES } from "./types";
import { parseSketch } from "../sketch/geometry";
import { getBlob, putBlob } from "./blobStore";
import type {
  BooleanOp,
  CameraMode,
  EditOp,
  FolderMeta,
  LowPoly,
  PrimitiveKind,
  ProjectData,
  ProjectFile,
  ProjectLocation,
  ProjectMeta,
  SceneNode,
  Vec3,
} from "./types";

const INDEX_KEY = "cad.projects_index";
const ACTIVE_PROJECT_KEY = "cad.active_project_id";
const PROJECT_PREFIX = "cad.project.";
const LEGACY_KEY = "cad.document";
const CAMERA_KEY = "cad.camera";
// "2" marks the larger, smoother pictures; the first, smaller ones (cad.thumb.) are discarded.
const FOLDERS_KEY = "cad.folders";
const THUMB_PREFIX = "cad.thumb2.";
const OLD_THUMB_PREFIX = "cad.thumb.";
let oldThumbnailsPurged = false;

function purgeOldThumbnails(): void {
  if (oldThumbnailsPurged) return;
  oldThumbnailsPurged = true;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(OLD_THUMB_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* nothing to purge if storage is unavailable */
  }
}
const VERSION = 1;

interface StoredLegacy {
  version: number;
  nodes: unknown;
}

const OPS: BooleanOp[] = ["assembly", "union", "subtract", "intersect"];

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * Saved JSON is untrusted — it may be from an older build, hand-edited, or
 * truncated. Anything that does not match is dropped rather than crashing the
 * kernel later with a half-formed node.
 */
/** Saved faceting settings, or undefined for anything that isn't a usable
 *  pair of positive numbers — an absent/!malformed value means full detail. */
function parseLowPoly(raw: unknown): LowPoly | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { facet, even } = raw as { facet?: unknown; even?: unknown };
  if (typeof facet !== "number" || !Number.isFinite(facet) || facet <= 0) return undefined;
  return { facet, even: typeof even === "number" && Number.isFinite(even) && even > 0 ? even : 0 };
}

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
    hideLines: n.hideLines === true ? true : undefined,
    lowPoly: parseLowPoly(n.lowPoly),
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
    const text = typeof n.text === "string" ? n.text : undefined;
    const fontName = typeof n.fontName === "string" ? n.fontName : undefined;
    const sketch = kind === "sketch" ? parseSketch(n.sketch) ?? { paths: [] } : undefined;
    return {
      ...base,
      type: "object",
      kind,
      params,
      ...(text !== undefined ? { text } : {}),
      ...(fontName !== undefined ? { fontName } : {}),
      ...(sketch ? { sketch } : {}),
    };
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
    const piece = typeof n.piece === "number" && Number.isInteger(n.piece) && n.piece >= 0 ? n.piece : undefined;
    return { ...base, type: "build", sources, keep, ...(piece !== undefined ? { piece } : {}) };
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
    if (
      !parsedBase ||
      (parsedBase.type !== "object" && parsedBase.type !== "group" && parsedBase.type !== "build")
    ) return null;
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
    // A fillet or chamfer made by selecting a FACE is anchored by that face,
    // and its `point` is only the click in the middle of it — not on any
    // edge. Dropping `face` here left the op pointing at no edge at all, so
    // after a refresh it failed, and the automatic dead-op cleanup then
    // deleted it from the document for good.
    const f = o.face as Record<string, unknown> | undefined;
    const face = f && isVec3(f.point) && isVec3(f.normal) ? { point: f.point, normal: f.normal } : undefined;
    return {
      kind: o.kind,
      point: o.point,
      points: points?.length ? points : undefined,
      ...(face ? { face } : {}),
      distance: o.distance,
    };
  }
  if (o.kind === "shell") {
    if (typeof o.thickness !== "number" || !Number.isFinite(o.thickness) || o.thickness <= 0) return null;
    const points = Array.isArray(o.points) ? o.points.filter(isVec3) : [];
    const normal = isVec3(o.normal) ? o.normal : undefined;
    // 0 is a real value — an open-ended hollow — so it must survive a reload
    // rather than quietly turning back into a closed bottom.
    const bottomThickness = typeof o.bottomThickness === "number" && Number.isFinite(o.bottomThickness) && o.bottomThickness >= 0 ? o.bottomThickness : undefined;
    const openingInset = typeof o.openingInset === "number" && Number.isFinite(o.openingInset) && o.openingInset >= 0 ? o.openingInset : undefined;
    const r = o.rim as { kind?: unknown; width?: unknown; depth?: unknown } | undefined;
    const rim = r && (r.kind === "ledge" || r.kind === "lip") &&
      [r.width, r.depth].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)
      ? { kind: r.kind as "ledge" | "lip", width: r.width as number, depth: r.depth as number }
      : undefined;
    return { kind: "shell", thickness: o.thickness, points, normal, bottomThickness, openingInset, rim };
  }
  if (o.kind === "resizeFace") {
    if (!isVec3(o.point) || !isVec3(o.normal)) return null;
    if (typeof o.offset !== "number" || !Number.isFinite(o.offset)) return null;
    // The independent-handle drag carries its whole result in `stretch`, not
    // `offset` (which stays 0 for it) — dropping this field here silently
    // turned every handle-based resize back into a no-op the moment the page
    // reloaded, since offset:0 does nothing on its own.
    const s = o.stretch as Record<string, unknown> | undefined;
    const stretch = s && isPair(s.scale) && isPair(s.origin) && isPair(s.translation)
      ? { scale: s.scale, origin: s.origin, translation: s.translation }
      : undefined;
    return { kind: "resizeFace", point: o.point, normal: o.normal, offset: o.offset, ...(stretch ? { stretch } : {}) };
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
  // A first-ever launch has not chosen a home for its design yet; one carried over
  // from the old single-document storage was already being kept.
  setProjectLocation(initialProject.id, initialNodes.length ? "browser" : "draft");
  setActiveProjectId(initialProject.id);

  return [
    {
      id: initialProject.id,
      name: initialProject.name,
      createdAt: initialProject.createdAt,
      updatedAt: initialProject.updatedAt,
      objectCount: initialProject.nodes.length,
      location: initialNodes.length ? "browser" : "draft",
    },
  ];
}

/** Where a design is kept; a design saved before locations existed is in the browser. */
export function locationOf(meta: Pick<ProjectMeta, "location">): ProjectLocation {
  return meta.location ?? "browser";
}

/** Records where a design lives without touching its contents. */
export function setProjectLocation(id: string, location: ProjectLocation): boolean {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return false;
    const list = JSON.parse(raw) as ProjectMeta[];
    const entry = list.find((p) => p.id === id);
    if (!entry) return false;
    entry.location = location;
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Moves a design into a folder (null = top level) without touching its contents. */
export function setProjectFolder(id: string, folderId: string | null): boolean {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return false;
    const list = JSON.parse(raw) as ProjectMeta[];
    const entry = list.find((p) => p.id === id);
    if (!entry) return false;
    if (folderId) entry.folderId = folderId;
    else delete entry.folderId;
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Reads and rewrites the saved list of designs in one step, for the Drive code. */
export function updateProjectMeta(id: string, change: (meta: ProjectMeta) => void): boolean {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return false;
    const list = JSON.parse(raw) as ProjectMeta[];
    const entry = list.find((p) => p.id === id);
    if (!entry) return false;
    change(entry);
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Adds a design to the list without any contents: one that exists on Drive but has not
 *  been opened on this computer yet. Does nothing if the id is already known. */
export function addRemoteProject(meta: ProjectMeta): void {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const list = raw ? (JSON.parse(raw) as ProjectMeta[]) : [];
    if (list.some((p) => p.id === meta.id)) return;
    list.push(meta);
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {
    /* the listing is only a convenience; Drive still has the file */
  }
}

export function hasProjectContents(id: string): boolean {
  try {
    return localStorage.getItem(PROJECT_PREFIX + id) !== null;
  } catch {
    return false;
  }
}

export function writeFolderList(list: FolderMeta[]): boolean {
  return writeFolders(list);
}

export function listFolders(): FolderMeta[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is FolderMeta =>
        !!f && typeof f.id === "string" && typeof f.name === "string" && (f.parentId === null || typeof f.parentId === "string"),
    );
  } catch {
    return [];
  }
}

function writeFolders(list: FolderMeta[]): boolean {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function createFolderEntry(name: string, parentId: string | null, driveId?: string, id?: string): FolderMeta {
  const folder: FolderMeta = {
    ...(driveId ? { driveId } : {}),
    id: id ?? `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "New folder",
    parentId,
    createdAt: Date.now(),
  };
  writeFolders([...listFolders(), folder]);
  return folder;
}

export function renameFolderEntry(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  writeFolders(listFolders().map((f) => (f.id === id ? { ...f, name: trimmed } : f)));
}

/** Removes a folder only. Whatever was inside it (designs and folders) moves up one level. */
export function deleteFolderEntry(id: string): void {
  const folders = listFolders();
  const doomed = folders.find((f) => f.id === id);
  if (!doomed) return;
  writeFolders(
    folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId: doomed.parentId } : f)),
  );
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as ProjectMeta[];
    for (const p of list) {
      if (p.folderId === id) {
        if (doomed.parentId) p.folderId = doomed.parentId;
        else delete p.folderId;
      }
    }
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {
    /* the folder is gone either way; designs keep working */
  }
}

/** Small preview picture shown on the Home page card. Kept apart from the design so
 *  a design's own save stays small; a missing or unwritable one just shows a placeholder. */
export function saveThumbnail(id: string, dataUrl: string): void {
  try {
    localStorage.setItem(THUMB_PREFIX + id, dataUrl);
  } catch {
    /* a thumbnail is never worth failing for */
  }
}

export function loadThumbnail(id: string): string | null {
  purgeOldThumbnails();
  try {
    return localStorage.getItem(THUMB_PREFIX + id);
  } catch {
    return null;
  }
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

    const existingIdx = list.findIndex((p) => p.id === project.id);
    const meta: ProjectMeta = {
      // An autosave must never move a design to a different home or folder, or lose its Drive link.
      ...(existingIdx >= 0 ? list[existingIdx] : {}),
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      objectCount: project.nodes.length,
    };

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

/* ---- Bin: deleted designs wait here for a while before they are gone for good ---- */

const BIN_INDEX_KEY = "cad.bin";
const BIN_DATA_PREFIX = "cad.bin.data.";
const BIN_THUMB_PREFIX = "cad.bin.thumb.";
export const BIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** viaFolder is set when the design went into the Bin as part of a deleted folder. */
export type BinEntry = { meta: ProjectMeta; deletedAt: number; viaFolder?: string };
/** A deleted folder with everything below it: `folders` is the folder itself and its subfolders. */
export type BinFolderEntry = { id: string; folders: FolderMeta[]; deletedAt: number };

const BIN_FOLDERS_KEY = "cad.bin.folders";

function readBinFolders(): BinFolderEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BIN_FOLDERS_KEY) ?? "[]") as BinFolderEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBinFolders(list: BinFolderEntry[]): void {
  localStorage.setItem(BIN_FOLDERS_KEY, JSON.stringify(list));
}

/** A folder's id followed by every folder below it. */
export function collectFolderTree(rootId: string): string[] {
  const all = listFolders();
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const f of all) if (f.parentId === out[i] && !out.includes(f.id)) out.push(f.id);
  return out;
}

/** Deleted folders, newest first. */
export function listBinFolders(): BinFolderEntry[] {
  const list = readBinFolders();
  const now = Date.now();
  const live = list.filter((e) => now - e.deletedAt < BIN_DAYS * DAY_MS);
  if (live.length !== list.length) {
    try {
      writeBinFolders(live);
    } catch {
      /* tidied up next time */
    }
  }
  return live.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** What the Bin holds at the top level: loose designs and whole folders. */
export function binCount(): number {
  return listBin().filter((e) => !e.viaFolder).length + listBinFolders().length;
}

/** Number of designs inside a binned folder. */
export function binFolderDesignCount(rootId: string): number {
  return readBin().filter((e) => e.viaFolder === rootId).length;
}

/** Takes a folder and its subfolders out of the list and keeps a record for Restore. */
export function binFolderTree(rootId: string, at: number): boolean {
  try {
    const ids = collectFolderTree(rootId);
    const all = listFolders();
    const doomed = ids.map((id) => all.find((f) => f.id === id)).filter((f): f is FolderMeta => !!f);
    if (!doomed.length) return false;
    writeBinFolders([...readBinFolders().filter((e) => e.id !== rootId), { id: rootId, folders: doomed, deletedAt: at }]);
    writeFolders(all.filter((f) => !ids.includes(f.id)));
    return true;
  } catch {
    return false;
  }
}

/** Brings a deleted folder back with its subfolders and designs. Returns the designs restored. */
export function restoreBinFolder(rootId: string): string[] | null {
  try {
    const entry = readBinFolders().find((e) => e.id === rootId);
    if (!entry) return null;
    const current = listFolders();
    const restored = entry.folders
      .filter((f) => !current.some((c) => c.id === f.id))
      .map((f) => {
        const { driveId: _drop, ...rest } = f;
        void _drop;
        const parentGone = f.id === rootId && f.parentId && !current.some((c) => c.id === f.parentId);
        return parentGone ? { ...rest, parentId: null } : rest;
      });
    writeFolders([...current, ...restored]);
    const designIds = readBin().filter((e) => e.viaFolder === rootId).map((e) => e.meta.id);
    const back = designIds.filter((id) => restoreFromBin(id));
    writeBinFolders(readBinFolders().filter((e) => e.id !== rootId));
    return back;
  } catch {
    return null;
  }
}

/** Removes a deleted folder, and the designs that went with it, for good. */
export function deleteBinFolder(rootId: string): void {
  try {
    deleteFromBin(readBin().filter((e) => e.viaFolder === rootId).map((e) => e.meta.id));
    writeBinFolders(readBinFolders().filter((e) => e.id !== rootId));
  } catch {
    /* nothing more to do */
  }
}

function readBin(): BinEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BIN_INDEX_KEY) ?? "[]") as BinEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBin(list: BinEntry[]): void {
  localStorage.setItem(BIN_INDEX_KEY, JSON.stringify(list));
}

function dropBinData(id: string): void {
  localStorage.removeItem(BIN_DATA_PREFIX + id);
  localStorage.removeItem(BIN_THUMB_PREFIX + id);
}

/** Deleted designs, newest first. Anything older than the keep time is cleared out here. */
export function listBin(): BinEntry[] {
  const list = readBin();
  const now = Date.now();
  const live = list.filter((e) => now - e.deletedAt < BIN_DAYS * DAY_MS);
  if (live.length !== list.length) {
    try {
      for (const e of list) if (!live.includes(e)) dropBinData(e.meta.id);
      writeBin(live);
    } catch {
      /* it is tidied up next time */
    }
  }
  return live.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Days left before a binned design is cleared. */
export function binDaysLeft(entry: { deletedAt: number }): number {
  return Math.max(0, Math.ceil(BIN_DAYS - (Date.now() - entry.deletedAt) / DAY_MS));
}

/** Copies a design into the Bin just before it is deleted. Empty designs are not worth keeping. */
export function moveToBin(id: string, via?: { folderId: string; at: number }): boolean {
  try {
    const rawIndex = localStorage.getItem(INDEX_KEY);
    const meta = rawIndex ? (JSON.parse(rawIndex) as ProjectMeta[]).find((p) => p.id === id) : undefined;
    const data = localStorage.getItem(PROJECT_PREFIX + id);
    if (!meta || meta.remote || meta.objectCount === 0 || !data) return false;
    localStorage.setItem(BIN_DATA_PREFIX + id, data);
    const thumb = localStorage.getItem(THUMB_PREFIX + id);
    if (thumb) localStorage.setItem(BIN_THUMB_PREFIX + id, thumb);
    writeBin([
      ...readBin().filter((e) => e.meta.id !== id),
      { meta: { ...meta }, deletedAt: via?.at ?? Date.now(), ...(via ? { viaFolder: via.folderId } : {}) },
    ]);
    return true;
  } catch {
    dropBinData(id);
    return false;
  }
}

export function loadBinThumbnail(id: string): string | null {
  try {
    return localStorage.getItem(BIN_THUMB_PREFIX + id);
  } catch {
    return null;
  }
}

/** Puts a binned design back. It is sent to Drive as a new file if Drive is connected. */
export function restoreFromBin(id: string): boolean {
  try {
    const list = readBin();
    const entry = list.find((e) => e.meta.id === id);
    const data = localStorage.getItem(BIN_DATA_PREFIX + id);
    if (!entry || !data) return false;
    localStorage.setItem(PROJECT_PREFIX + id, data);
    const thumb = localStorage.getItem(BIN_THUMB_PREFIX + id);
    if (thumb) localStorage.setItem(THUMB_PREFIX + id, thumb);
    const meta: ProjectMeta = { ...entry.meta, updatedAt: Date.now() };
    delete meta.driveId;
    delete meta.driveModified;
    delete meta.remote;
    if (meta.folderId && !listFolders().some((f) => f.id === meta.folderId)) delete meta.folderId;
    const rawIndex = localStorage.getItem(INDEX_KEY);
    const index = (rawIndex ? (JSON.parse(rawIndex) as ProjectMeta[]) : []).filter((p) => p.id !== id);
    index.push(meta);
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    dropBinData(id);
    writeBin(list.filter((e) => e.meta.id !== id));
    return true;
  } catch {
    return false;
  }
}

/** Removes designs from the Bin for good. */
export function deleteFromBin(ids: string[]): void {
  try {
    const gone = new Set(ids);
    for (const id of gone) dropBinData(id);
    writeBin(readBin().filter((e) => !gone.has(e.meta.id)));
  } catch {
    /* nothing more to do */
  }
}

export function deleteProjectStorage(id: string): boolean {
  try {
    localStorage.removeItem(PROJECT_PREFIX + id);
    localStorage.removeItem(THUMB_PREFIX + id);
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

export function collectImportBlobIds(nodes: SceneNode[], ids: Set<string>) {
  for (const n of nodes) {
    if (n.type === "import") ids.add(n.blobId);
    else if (n.type === "group") collectImportBlobIds(n.children, ids);
    else if (n.type === "build") collectImportBlobIds(n.sources, ids);
    else if (n.type === "edit") collectImportBlobIds([n.base], ids);
  }
}

// btoa/atob only accept one code unit per call's worth of stack, so a large
// STL has to go through in chunks rather than String.fromCharCode(...bytes).
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Exports project to a downloadable .shapeforge file. */
export async function exportProjectFile(project: ProjectData) {
  const blobIds = new Set<string>();
  collectImportBlobIds(project.nodes, blobIds);
  const blobs: Record<string, string> = {};
  for (const id of blobIds) {
    const bytes = await getBlob(id);
    if (bytes) blobs[id] = arrayBufferToBase64(bytes);
  }

  const fileData: ProjectFile = {
    format: "shapeforge",
    version: VERSION,
    id: project.id,
    name: project.name,
    exportedAt: Date.now(),
    nodes: project.nodes,
    camera: project.camera ?? loadCameraState(),
    ...(Object.keys(blobs).length ? { blobs } : {}),
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

/**
 * Writes back any blobs a .shapeforge file carries (see exportProjectFile)
 * into IndexedDB, keyed by the same blobId the import nodes reference, so
 * they resolve on this machine exactly as they did on the one that exported
 * the file. Call alongside parseProjectFile when loading from a file — a
 * project whose nodes came from localStorage instead already has its blobs.
 */
export async function restoreProjectFileBlobs(content: string): Promise<void> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return;
  }
  const blobs = raw.blobs;
  if (!blobs || typeof blobs !== "object") return;
  await Promise.all(
    Object.entries(blobs as Record<string, unknown>).map(async ([id, b64]) => {
      if (typeof b64 !== "string") return;
      try {
        await putBlob(id, base64ToArrayBuffer(b64));
      } catch {
        // Best effort — a failed restore leaves just that one import broken,
        // same as if the file had never carried it.
      }
    }),
  );
}

