import { useDoc, driveHooks } from "../document/store";
import {
  addRemoteProject,
  collectImportBlobIds,
  deleteProjectStorage,
  hasProjectContents,
  listFolders,
  listProjects,
  loadProject,
  loadThumbnail,
  parseProjectFile,
  saveProject,
  setProjectLocation,
  updateProjectMeta,
  writeFolderList,
} from "../document/persist";
import { getBlob, putBlob } from "../document/blobStore";
import type { FolderMeta, ProjectData, ProjectMeta } from "../document/types";
import { DriveApi, DriveAuthError, DriveError, FOLDER_MIME } from "./api";
import type { DriveFile } from "./api";
import { getAccessToken, hasToken, signedOutByGoogle } from "./auth";
import { APP_FOLDER_NAME, ASSETS_FOLDER_NAME } from "./config";
import { useDrive } from "./state";
import { decodeTags, encodeTags } from "../document/tags";

/* Keeps the designs and folders in this browser matched to the ShapeForge folder in Google Drive.
   Drive is the shared copy: every design is one small .shapeforge file, imported STL and 3MF files
   are separate files in a _files folder (stored once however many designs use them), and folders
   are real Drive folders with the same names and nesting. */

const ROOT_KEY = "cad.drive.rootId";
const ASSETS_KEY = "cad.drive.assetsId";
const BLOBS_KEY = "cad.drive.blobs";
const DIRTY_KEY = "cad.drive.dirty";
const TRASH_KEY = "cad.drive.trash";
const VERSIONS_KEY = "cad.drive.versionsId";
const LAST_VERSION_KEY = "cad.drive.lastVersion";
const LAST_PRUNE_KEY = "cad.drive.lastPrune";
// A snapshot is taken at most this often while a design is being edited.
const AUTO_VERSION_GAP_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_VERSIONS_DAYS = 30;
// Longer than the editor's own autosave delay, so the version sent is the one just saved.
const PUSH_DELAY_MS = 3000;

let api: DriveApi | null = null;

export function driveApi(): DriveApi {
  if (!api) api = new DriveApi(getAccessToken);
  return api;
}

/** Lets a test swap in a fake Drive. */
export function setDriveApiForTests(fake: DriveApi | null): void {
  api = fake;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* losing a cache entry only costs a lookup later */
  }
}

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* as above */
  }
}

/** Forget the remembered Drive ids, for when Drive says something we expected is gone. */
export function resetDriveCaches(): void {
  writeString(ROOT_KEY, null);
  writeString(ASSETS_KEY, null);
  writeString(VERSIONS_KEY, null);
  writeJson(BLOBS_KEY, {});
}

// ---- which designs still need sending ----

const dirtySet = (): Set<string> => new Set(readJson<string[]>(DIRTY_KEY, []));
const saveDirty = (set: Set<string>) => writeJson(DIRTY_KEY, [...set]);

export function markDirty(id: string): void {
  const set = dirtySet();
  set.add(id);
  saveDirty(set);
}

function clearDirty(id: string): void {
  const set = dirtySet();
  if (set.delete(id)) saveDirty(set);
}

export const isDirty = (id: string): boolean => dirtySet().has(id);

// ---- Drive's folder structure ----

async function ensureRoot(): Promise<{ rootId: string; assetsId: string }> {
  let rootId = readString(ROOT_KEY);
  let assetsId = readString(ASSETS_KEY);
  if (rootId && assetsId) return { rootId, assetsId };

  const files = await driveApi().listAll();
  const root = files.find((f) => f.appProperties?.kind === "root");
  rootId = root?.id ?? (await driveApi().createFolder(APP_FOLDER_NAME, undefined, "root")).id;
  const assets = files.find((f) => f.appProperties?.kind === "assets" && (f.parents ?? []).includes(rootId!));
  assetsId = assets?.id ?? (await driveApi().createFolder(ASSETS_FOLDER_NAME, rootId, "assets")).id;
  writeString(ROOT_KEY, rootId);
  writeString(ASSETS_KEY, assetsId);
  return { rootId, assetsId };
}

function setFolderDriveId(localId: string, driveId: string | undefined): void {
  writeFolderList(
    listFolders().map((f) => {
      if (f.id !== localId) return f;
      const next = { ...f };
      if (driveId) next.driveId = driveId;
      else delete next.driveId;
      return next;
    }),
  );
}

// Folders being made right now. Two syncs asking for the same one share a single request,
// otherwise Drive ends up with the folder twice.
const makingFolder = new Map<string, Promise<string>>();

/** The Drive folder matching a local folder, made (with its parents) if it does not exist yet. */
async function driveFolderFor(localFolderId: string | null): Promise<string> {
  const { rootId } = await ensureRoot();
  if (!localFolderId) return rootId;
  const folder = listFolders().find((f) => f.id === localFolderId);
  if (!folder) return rootId;
  if (folder.driveId) return folder.driveId;
  const running = makingFolder.get(folder.id);
  if (running) return running;
  const job = (async () => {
    const parent = await driveFolderFor(folder.parentId);
    const made = await driveApi().createFolder(folder.name, parent, "folder", { localId: folder.id });
    setFolderDriveId(folder.id, made.id);
    return made.id;
  })();
  makingFolder.set(folder.id, job);
  try {
    return await job;
  } finally {
    makingFolder.delete(folder.id);
  }
}

// ---- sending ----

async function ensureBlobUploaded(blobId: string, assetsId: string): Promise<void> {
  const known = readJson<Record<string, string>>(BLOBS_KEY, {});
  if (known[blobId]) return;
  const bytes = await getBlob(blobId);
  if (!bytes) return;
  const file = await driveApi().upload({
    name: blobId,
    parentId: assetsId,
    mimeType: "application/octet-stream",
    body: bytes,
    kind: "blob",
    properties: { blobId },
  });
  known[blobId] = file.id;
  writeJson(BLOBS_KEY, known);
}

const designFileName = (name: string) => `${name.replace(/[\\/]/g, "-")}.shapeforge`;

function designJson(project: ProjectData): string {
  return JSON.stringify({
    format: "shapeforge",
    version: 1,
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    exportedAt: Date.now(),
    nodes: project.nodes,
    camera: project.camera ?? null,
  });
}

/** Sends one design (and any imported files it uses) to Drive, creating or replacing its file. */
export async function pushProject(id: string, attempt = 0): Promise<void> {
  const project = loadProject(id);
  if (!project) return;
  const meta = listProjects().find((p) => p.id === id);

  try {
    const { assetsId } = await ensureRoot();
    const blobIds = new Set<string>();
    collectImportBlobIds(project.nodes, blobIds);
    for (const blobId of blobIds) await ensureBlobUploaded(blobId, assetsId);

    const parentId = await driveFolderFor(meta?.folderId ?? null);
    const file = await driveApi().upload({
      fileId: meta?.driveId,
      name: designFileName(project.name),
      parentId,
      mimeType: "application/json",
      body: designJson(project),
      kind: "design",
      properties: { localId: project.id, tags: encodeTags(meta?.tags), starred: meta?.starred ? "1" : "0" },
      thumbnail: loadThumbnail(id),
    });

    // Heal a design that was moved while Drive was out of reach.
    const parents = file.parents ?? [];
    if (!parents.includes(parentId) || parents.length > 1) {
      await driveApi().updateMetadata(file.id, {
        addParent: parents.includes(parentId) ? undefined : parentId,
        removeParent: parents.filter((p) => p !== parentId).join(",") || undefined,
      });
    }

    updateProjectMeta(id, (m) => {
      m.driveId = file.id;
      m.location = "drive";
      m.driveModified = file.modifiedTime;
      delete m.remote;
    });
    clearDirty(id);
    try {
      await maybeAutoVersion(project);
    } catch {
      /* history is a bonus; a failure never blocks saving the design */
    }
  } catch (error) {
    // Something we remembered is gone from Drive (deleted by hand): forget it and try once more.
    if (error instanceof DriveError && error.status === 404 && attempt === 0) {
      resetDriveCaches();
      updateProjectMeta(id, (m) => {
        delete m.driveId;
      });
      for (const f of listFolders()) if (f.driveId) setFolderDriveId(f.id, undefined);
      return pushProject(id, 1);
    }
    throw error;
  }
}

// ---- receiving ----

async function refreshBlobMap(): Promise<Record<string, string>> {
  const files = await driveApi().listAll();
  const map: Record<string, string> = {};
  for (const f of files) if (f.appProperties?.kind === "blob") map[f.appProperties.blobId ?? f.name] = f.id;
  writeJson(BLOBS_KEY, map);
  return map;
}

/** Makes sure every imported file a design uses is on this computer, downloading what is missing. */
async function ensureBlobsLocal(nodes: ProjectData["nodes"]): Promise<void> {
  const blobIds = new Set<string>();
  collectImportBlobIds(nodes, blobIds);
  let map = readJson<Record<string, string>>(BLOBS_KEY, {});
  for (const blobId of blobIds) {
    if (await getBlob(blobId)) continue;
    if (!map[blobId]) map = await refreshBlobMap();
    if (map[blobId]) await putBlob(blobId, await driveApi().downloadBytes(map[blobId]));
  }
}

/** Downloads a design's contents (and any imported files it needs) from Drive into this browser. */
export async function fetchProject(id: string): Promise<boolean> {
  const meta = listProjects().find((p) => p.id === id);
  if (!meta?.driveId) return false;
  const text = await driveApi().downloadText(meta.driveId);
  const parsed = parseProjectFile(text, meta.name);
  if (!parsed) return false;
  parsed.id = id;
  parsed.name = meta.name;

  await ensureBlobsLocal(parsed.nodes);

  saveProject(parsed);
  updateProjectMeta(id, (m) => {
    delete m.remote;
    m.location = "drive";
  });
  return true;
}

function newFolderId(): string {
  return `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Brings the local list in line with Drive: folders and designs made on another computer appear
 * here (a design's contents are only fetched when it is first opened), and ones that were removed
 * from Drive lose their link. Designs waiting to be sent are never overwritten.
 */
export async function pullIndex(openProjectId?: string): Promise<void> {
  const files = await driveApi().listAll();
  const root = files.find((f) => f.appProperties?.kind === "root");
  const assets = files.find((f) => f.appProperties?.kind === "assets");
  if (root) writeString(ROOT_KEY, root.id);
  if (assets) writeString(ASSETS_KEY, assets.id);

  const blobMap: Record<string, string> = {};
  for (const f of files) if (f.appProperties?.kind === "blob") blobMap[f.appProperties.blobId ?? f.name] = f.id;
  writeJson(BLOBS_KEY, blobMap);

  // Folders, parents before children.
  const driveFolders = files.filter((f) => f.mimeType === FOLDER_MIME && f.appProperties?.kind === "folder");
  const byDriveId = new Map(driveFolders.map((f) => [f.id, f]));
  const depthOf = (f: DriveFile): number => {
    let depth = 0;
    let cursor: DriveFile | undefined = f;
    while (cursor && depth < 50) {
      const parent: string | undefined = cursor.parents?.[0];
      cursor = parent ? byDriveId.get(parent) : undefined;
      if (cursor) depth++;
    }
    return depth;
  };
  const folders: FolderMeta[] = listFolders();
  const localByDrive = new Map<string, string>();
  for (const f of folders) if (f.driveId) localByDrive.set(f.driveId, f.id);

  const localParentOf = (f: DriveFile): string | null => {
    const parent = f.parents?.[0];
    return parent && parent !== root?.id ? localByDrive.get(parent) ?? null : null;
  };

  for (const df of [...driveFolders].sort((a, b) => depthOf(a) - depthOf(b))) {
    const existingId = localByDrive.get(df.id);
    if (existingId) {
      const lf = folders.find((f) => f.id === existingId)!;
      lf.name = df.name;
      lf.parentId = localParentOf(df);
    } else if (df.appProperties?.localId && folders.some((f) => f.id === df.appProperties?.localId)) {
      // A second Drive folder for a folder we already have (made by two syncs at once): the same
      // folder, so its designs show up there instead of in a duplicate. The first one found is linked.
      const same = folders.find((f) => f.id === df.appProperties?.localId)!;
      if (!same.driveId) same.driveId = df.id;
      localByDrive.set(df.id, same.id);
    } else {
      const wanted = df.appProperties?.localId;
      const created: FolderMeta = {
        id: wanted && !folders.some((f) => f.id === wanted) ? wanted : newFolderId(),
        name: df.name,
        parentId: localParentOf(df),
        createdAt: Date.parse(df.modifiedTime ?? "") || Date.now(),
        driveId: df.id,
      };
      folders.push(created);
      localByDrive.set(df.id, created.id);
    }
  }
  const onDrive = new Set(driveFolders.map((f) => f.id));
  for (const f of folders) if (f.driveId && !onDrive.has(f.driveId)) delete f.driveId;
  writeFolderList(folders);

  // Designs.
  const driveDesigns = files.filter((f) => f.appProperties?.kind === "design");
  const seen = new Set<string>();
  const metas = listProjects();
  for (const d of driveDesigns) {
    const localId = d.appProperties?.localId || `p-${d.id}`;
    const existing = metas.find((m) => m.driveId === d.id) ?? metas.find((m) => m.id === localId);
    const name = d.name.replace(/\.shapeforge$/i, "");
    const folderId = localParentOf(d) ?? undefined;
    seen.add(existing?.id ?? localId);
    if (!existing) {
      addRemoteProject({
        id: localId,
        name,
        createdAt: Date.parse(d.modifiedTime ?? "") || Date.now(),
        updatedAt: Date.parse(d.modifiedTime ?? "") || Date.now(),
        objectCount: 0,
        location: "drive",
        ...(folderId ? { folderId } : {}),
        ...(decodeTags(d.appProperties?.tags).length ? { tags: decodeTags(d.appProperties?.tags) } : {}),
        ...(d.appProperties?.starred === "1" ? { starred: true } : {}),
        driveId: d.id,
        driveModified: d.modifiedTime,
        remote: true,
      });
    } else {
      updateProjectMeta(existing.id, (m) => {
        m.driveId = d.id;
        m.location = "drive";
        if (isDirty(m.id)) return; // our version is newer and still waiting to be sent
        m.name = name;
        if (folderId) m.folderId = folderId;
        else delete m.folderId;
        // Tags and the star are only present on files saved by this version or later.
        if (d.appProperties?.tags !== undefined) {
          const tags = decodeTags(d.appProperties.tags);
          if (tags.length) m.tags = tags;
          else delete m.tags;
        }
        if (d.appProperties?.starred !== undefined) {
          if (d.appProperties.starred === "1") m.starred = true;
          else delete m.starred;
        }
        // Changed on Drive since we last sent or fetched it: fetch again the next time it is opened,
        // unless it is open right now (replacing it under the editor would lose unsaved work).
        if (m.driveModified && m.driveModified !== d.modifiedTime && m.id !== openProjectId) {
          m.remote = true;
        }
      });
    }
  }

  // A design that Drive no longer lists was removed elsewhere. One with nothing here to lose goes
  // away; one with contents just loses its link and will be sent again the next time it is saved.
  for (const m of metas) {
    if (!m.driveId || seen.has(m.id)) continue;
    if (!hasProjectContents(m.id) || m.remote) deleteProjectStorage(m.id);
    else updateProjectMeta(m.id, (x) => { delete x.driveId; });
  }
}

// ---- moves, renames and deletes ----

// ---- feedback notes ----

export type SyncedNote = { id: string; text: string; version: string; at: number; done: boolean; updatedAt?: number };
type NotesFile = { format: "shapeforge-notes"; notes: SyncedNote[]; deleted: Record<string, number> };

const NOTES_FILE_NAME = "feedback-notes.json";
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const noteStamp = (n: SyncedNote) => n.updatedAt ?? n.at;

/** Two lists of notes become one: the latest edit of each note wins, and a delete wins over an older copy. */
export function mergeNotes(
  localNotes: SyncedNote[],
  localDeleted: Record<string, number>,
  remoteNotes: SyncedNote[],
  remoteDeleted: Record<string, number>,
): { notes: SyncedNote[]; deleted: Record<string, number> } {
  const byId = new Map<string, SyncedNote>();
  // Remote first, so on an exact tie this computer's copy is kept.
  for (const n of [...remoteNotes, ...localNotes]) {
    const current = byId.get(n.id);
    if (!current || noteStamp(n) >= noteStamp(current)) byId.set(n.id, n);
  }
  const deleted: Record<string, number> = { ...remoteDeleted };
  for (const [id, at] of Object.entries(localDeleted)) deleted[id] = Math.max(deleted[id] ?? 0, at);
  const cutoff = Date.now() - TOMBSTONE_MS;
  for (const [id, at] of Object.entries(deleted)) {
    const note = byId.get(id);
    if (note && noteStamp(note) > at) delete deleted[id]; // edited after it was deleted somewhere else: it stays
    else byId.delete(id);
    if (deleted[id] !== undefined && at < cutoff) delete deleted[id];
  }
  const notes = [...byId.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { notes, deleted };
}

const canonNotes = (notes: SyncedNote[], deleted: Record<string, number>) =>
  JSON.stringify([
    [...notes].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).map((n) => [n.id, n.text, n.version, n.at, n.done, n.updatedAt ?? null]),
    Object.entries(deleted).sort(([a], [b]) => a.localeCompare(b)),
  ]);

/** Brings the notes on this computer and the copy in Drive level, and returns the combined list. */
export async function syncNotesWithDrive(
  local: SyncedNote[],
  localDeleted: Record<string, number>,
): Promise<{ notes: SyncedNote[]; deleted: Record<string, number> }> {
  const { rootId } = await ensureRoot();
  const file = await driveApi().findByKind("notes");
  let remote: NotesFile | null = null;
  if (file) {
    try {
      remote = JSON.parse(await driveApi().downloadText(file.id)) as NotesFile;
    } catch {
      remote = null; // unreadable: it is replaced by the merged copy below
    }
  }
  const merged = mergeNotes(local, localDeleted, remote?.notes ?? [], remote?.deleted ?? {});
  if (!remote || canonNotes(remote.notes ?? [], remote.deleted ?? {}) !== canonNotes(merged.notes, merged.deleted)) {
    const body: NotesFile = { format: "shapeforge-notes", notes: merged.notes, deleted: merged.deleted };
    await driveApi().upload({
      fileId: file?.id,
      name: NOTES_FILE_NAME,
      parentId: rootId,
      mimeType: "application/json",
      body: JSON.stringify(body),
      kind: "notes",
    });
  }
  return merged;
}

// ---- version history ----

export type DesignVersion = { id: string; at: number; label: string | null; manual: boolean; shapes: number | null };

async function ensureVersionsFolder(): Promise<string> {
  const cached = readString(VERSIONS_KEY);
  if (cached) return cached;
  const { rootId } = await ensureRoot();
  const found = await driveApi().findVersionsFolder();
  const id = found?.id ?? (await driveApi().createFolder("_versions", rootId, "versions")).id;
  writeString(VERSIONS_KEY, id);
  return id;
}

async function writeVersion(project: ProjectData, label: string | null, manual: boolean): Promise<void> {
  const parentId = await ensureVersionsFolder();
  const meta = listProjects().find((p) => p.id === project.id);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await driveApi().upload({
    name: designFileName(`${project.name} ${stamp}`),
    parentId,
    mimeType: "application/json",
    body: designJson(project),
    kind: "version",
    // Drive limits a property to about 120 characters, key included.
    properties: {
      localId: project.id,
      manual: manual ? "1" : "0",
      label: (label ?? "").slice(0, 60),
      shapes: String(meta?.objectCount ?? project.nodes.length),
    },
  });
  const last = readJson<Record<string, number>>(LAST_VERSION_KEY, {});
  last[project.id] = Date.now();
  writeJson(LAST_VERSION_KEY, last);
}

/** A snapshot of a design while it is being edited, at most one every quarter of an hour. */
async function maybeAutoVersion(project: ProjectData): Promise<void> {
  const last = readJson<Record<string, number>>(LAST_VERSION_KEY, {});
  if (Date.now() - (last[project.id] ?? 0) < AUTO_VERSION_GAP_MS) return;
  await writeVersion(project, null, false);
  await pruneVersions(project.id);
}

/** Thins out old automatic snapshots: all of the last day, then one per day for a month. Named versions stay. */
async function pruneVersions(localId: string): Promise<void> {
  const pruned = readJson<Record<string, number>>(LAST_PRUNE_KEY, {});
  if (Date.now() - (pruned[localId] ?? 0) < DAY_MS) return;
  pruned[localId] = Date.now();
  writeJson(LAST_PRUNE_KEY, pruned);
  const now = Date.now();
  const seenDays = new Set<string>();
  for (const file of await driveApi().listVersions(localId)) {
    if (file.appProperties?.manual === "1") continue;
    const at = Date.parse(file.modifiedTime ?? "") || now;
    const age = now - at;
    if (age < DAY_MS) continue;
    const day = new Date(at).toDateString();
    if (age > KEEP_VERSIONS_DAYS * DAY_MS || seenDays.has(day)) await driveApi().trash(file.id);
    else seenDays.add(day);
  }
}

/** A named version the person asked for. It is kept until they remove it. */
export async function saveVersion(id: string, label: string): Promise<boolean> {
  const project = loadProject(id);
  if (!project) return false;
  await writeVersion(project, label.trim() || "Saved version", true);
  return true;
}

export async function listDesignVersions(id: string): Promise<DesignVersion[]> {
  const files = await driveApi().listVersions(id);
  return files.map((f) => ({
    id: f.id,
    at: Date.parse(f.modifiedTime ?? "") || 0,
    label: f.appProperties?.label || null,
    manual: f.appProperties?.manual === "1",
    shapes: f.appProperties?.shapes ? Number(f.appProperties.shapes) : null,
  }));
}

export async function deleteVersion(versionFileId: string): Promise<void> {
  await driveApi().trash(versionFileId);
}

async function loadVersionData(versionFileId: string, fallbackName: string): Promise<ProjectData | null> {
  const parsed = parseProjectFile(await driveApi().downloadText(versionFileId), fallbackName);
  if (!parsed) return null;
  await ensureBlobsLocal(parsed.nodes);
  return parsed;
}

/** Puts an older version back as the design. What it replaces is kept as a version first. */
export async function restoreVersion(designId: string, versionFileId: string): Promise<boolean> {
  const meta = listProjects().find((p) => p.id === designId);
  if (!meta) return false;
  const parsed = await loadVersionData(versionFileId, meta.name);
  if (!parsed) return false;
  const current = loadProject(designId);
  if (current) await writeVersion(current, "Before restoring", true);
  parsed.id = designId;
  parsed.name = meta.name;
  saveProject(parsed);
  // Now holds real contents here, so it must not be fetched from Drive again; send it as the newest.
  updateProjectMeta(designId, (m) => {
    delete m.remote;
    m.location = "drive";
  });
  queuePush(designId);
  return true;
}

/** An older version as a new design of its own, leaving the current one untouched. */
export async function versionAsCopy(designId: string, versionFileId: string): Promise<ProjectData | null> {
  const meta = listProjects().find((p) => p.id === designId);
  const parsed = await loadVersionData(versionFileId, meta?.name ?? "Design");
  if (!parsed) return null;
  parsed.id = `p-${Date.now()}`;
  parsed.name = `${meta?.name ?? parsed.name} (older version)`;
  parsed.createdAt = Date.now();
  parsed.updatedAt = Date.now();
  return parsed;
}

/** While signed in everything lives on Drive: a design kept only in this browser is adopted
 *  as soon as it has something in it. Empty drafts stay local so no empty files are made. */
function adoptIntoDrive(id: string): boolean {
  if (useDrive.getState().status !== "signedIn") return false;
  const meta = listProjects().find((p) => p.id === id);
  if (!meta || meta.remote || meta.location === "drive" || meta.objectCount === 0) return false;
  if (!setProjectLocation(id, "drive")) return false;
  useDoc.getState().refreshProjectsList();
  return true;
}

function adoptAllIntoDrive(): void {
  for (const p of listProjects()) if (adoptIntoDrive(p.id)) markDirty(p.id);
}

/** Sends a design again a moment after it changed; if Drive cannot be reached it stays marked. */
const timers = new Map<string, number>();
export function queuePush(id: string): void {
  markDirty(id);
  window.clearTimeout(timers.get(id));
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      void runSync(() => pushProject(id));
    }, PUSH_DELAY_MS),
  );
}

async function trashOnDrive(driveId: string): Promise<void> {
  try {
    await driveApi().trash(driveId);
  } catch (error) {
    if (!(error instanceof DriveError && error.status === 404)) throw error;
  }
}

/** Sends everything that was waiting: designs saved while offline, and deletions. */
export async function flushPending(): Promise<void> {
  const trash = readJson<string[]>(TRASH_KEY, []);
  if (trash.length) {
    writeJson(TRASH_KEY, []);
    for (const driveId of trash) {
      try {
        await trashOnDrive(driveId);
      } catch (error) {
        writeJson(TRASH_KEY, [...readJson<string[]>(TRASH_KEY, []), driveId]);
        throw error;
      }
    }
  }
  for (const id of dirtySet()) await pushProject(id);
}

/** Runs a Drive job, keeping the connection state and the last error up to date. */
export async function runSync<T>(job: () => Promise<T>): Promise<T | undefined> {
  const drive = useDrive.getState();
  if (drive.status !== "signedIn" && !hasToken()) return undefined;
  drive.setBusy(true);
  try {
    const result = await job();
    useDrive.getState().markSynced();
    return result;
  } catch (error) {
    if (error instanceof DriveAuthError) {
      signedOutByGoogle();
      useDrive.getState().setStatus("signedOut");
    }
    useDrive.getState().setError(
      error instanceof Error && error.message ? error.message : "Couldn't reach Google Drive. Your changes will be sent next time.",
    );
    return undefined;
  } finally {
    useDrive.getState().setBusy(false);
  }
}

/** Reads Drive's current state, sends anything waiting, and refreshes what the Home page shows. */
export async function syncNow(): Promise<void> {
  await runSync(async () => {
    adoptAllIntoDrive();
    await flushPending();
    // Folders made before Drive was connected (or still empty) get their Drive twin too.
    for (const f of listFolders()) if (!f.driveId) await driveFolderFor(f.id);
    await pullIndex(useDoc.getState().currentProjectId);
    useDoc.getState().refreshProjectsList();
    useDoc.getState().refreshFolders();
  });
}

// ---- hooks the Home page actions call, so every change reaches Drive ----

function pushFolderToDrive(folderId: string, change: (driveId: string) => Promise<unknown>): void {
  const folder = listFolders().find((f) => f.id === folderId);
  if (!folder?.driveId) return;
  void runSync(() => change(folder.driveId!));
}

async function moveFolderOnDrive(folderId: string): Promise<void> {
  const folder = listFolders().find((f) => f.id === folderId);
  if (!folder?.driveId) return;
  const parent = await driveFolderFor(folder.parentId);
  const current = await driveApi().getFile(folder.driveId);
  const others = (current.parents ?? []).filter((p) => p !== parent);
  if (others.length || !(current.parents ?? []).includes(parent)) {
    await driveApi().updateMetadata(folder.driveId, {
      addParent: (current.parents ?? []).includes(parent) ? undefined : parent,
      removeParent: others.join(",") || undefined,
    });
  }
}

export function installDriveHooks(): void {
  driveHooks.onProjectChanged = (id) => {
    adoptIntoDrive(id);
    const meta = listProjects().find((p) => p.id === id);
    if (meta?.location === "drive") queuePush(id);
  };
  driveHooks.onProjectDeleted = (meta: ProjectMeta) => {
    clearDirty(meta.id);
    if (!meta.driveId) return;
    const driveId = meta.driveId;
    writeJson(TRASH_KEY, [...readJson<string[]>(TRASH_KEY, []), driveId]);
    void runSync(flushPending);
  };
  driveHooks.onFolderRenamed = (folderId) => {
    const folder = listFolders().find((f) => f.id === folderId);
    if (folder) pushFolderToDrive(folderId, (driveId) => driveApi().updateMetadata(driveId, { name: folder.name }));
  };
  driveHooks.onFolderDeleted = ({ folder, designIds, subfolderIds }) => {
    if (!folder.driveId) return;
    void runSync(async () => {
      for (const id of designIds) {
        const meta = listProjects().find((p) => p.id === id);
        if (meta?.driveId) await pushProject(id);
      }
      for (const id of subfolderIds) await moveFolderOnDrive(id);
      await trashOnDrive(folder.driveId!);
    });
  };

  // Every edit to a design that lives on Drive is sent a moment later. Opening a design changes
  // the open design's id too, so only a change within the same design counts.
  useDoc.subscribe((state, previous) => {
    if (state.nodes === previous.nodes || state.currentProjectId !== previous.currentProjectId) return;
    // The editor's own save lands a moment after the edit, so give it time before adopting.
    const id = state.currentProjectId;
    window.setTimeout(() => {
      adoptIntoDrive(id);
      if (listProjects().find((p) => p.id === id)?.location === "drive") queuePush(id);
    }, 600);
  });
}
