import { useDoc, driveHooks } from "../document/store";
import {
  addRemoteProject,
  collectImportBlobIds,
  deleteProjectStorage,
  moveToBin,
  hasProjectContents,
  listFolders,
  listProjects,
  loadProject,
  loadThumbnail,
  parseProjectFile,
  saveProject,
  saveThumbnail,
  setProjectLocation,
  stampThumbnail,
  thumbnailHooks,
  thumbnailStamp,
  updateProjectMeta,
  writeFolderList,
} from "../document/persist";
import { getBlob, putBlob } from "../document/blobStore";
import type { FolderMeta, ProjectData, ProjectMeta } from "../document/types";
import { DriveApi, DriveAuthError, DriveError, DriveScopeError, FOLDER_MIME } from "./api";
import type { DriveFile } from "./api";
import { getAccessToken, hasToken, signedOutByGoogle } from "./auth";
import { APP_FOLDER_NAME, ASSETS_FOLDER_NAME } from "./config";
import { useDrive } from "./state";
import { createSerialRunner } from "./serial";
import { thumbnailAction } from "./thumbRules";
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
/**
 * Folders deleted here whose Drive copy has not been trashed yet, with what has to be moved out of them first
 * (their designs and subfolders move up when only the folder is deleted). Kept on disk and retried until Drive
 * accepts it, like a deleted design: a one-shot attempt that was lost (not connected at that moment, the sign-in
 * had just expired, Drive hiccuped) left the folder in Drive, and the next sync brought it back.
 */
const FOLDER_TRASH_KEY = "cad.drive.trashFolders";
type PendingFolderTrash = { driveId: string; designIds: string[]; subfolderIds: string[] };
const VERSIONS_KEY = "cad.drive.versionsId";
const THUMBS_KEY = "cad.drive.thumbsId";
const THUMB_FILES_KEY = "cad.drive.thumbFiles";
const THUMB_SIGS_KEY = "cad.drive.thumbSigs";
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
  writeString(THUMBS_KEY, null);
  writeJson(THUMB_FILES_KEY, {});
  writeJson(BLOBS_KEY, {});
}

// ---- which designs still need sending ----

const dirtySet = (): Set<string> => new Set(readJson<string[]>(DIRTY_KEY, []));
const saveDirty = (set: Set<string>) => writeJson(DIRTY_KEY, [...set]);

/** Counts every change marked on a design, so a send can tell whether it changed again while it was uploading. */
const changeCount = new Map<string, number>();
const changesOf = (id: string): number => changeCount.get(id) ?? 0;

export function markDirty(id: string): void {
  changeCount.set(id, changesOf(id) + 1);
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
  const rootId = readString(ROOT_KEY);
  const assetsId = readString(ASSETS_KEY);
  if (rootId && assetsId) return { rootId, assetsId };
  // Several syncs can start together on a first sign-in: they share one lookup-or-create, or each would make its own folder.
  if (!rootJob) {
    rootJob = (async () => {
      const files = await driveApi().listAll();
      await consolidateRoots(files);
      const root = files.find((f) => f.appProperties?.kind === "root");
      const newRootId = root?.id ?? (await driveApi().createFolder(APP_FOLDER_NAME, undefined, "root")).id;
      const assets = files.find((f) => f.appProperties?.kind === "assets" && (f.parents ?? []).includes(newRootId));
      const newAssetsId = assets?.id ?? (await driveApi().createFolder(ASSETS_FOLDER_NAME, newRootId, "assets")).id;
      writeString(ROOT_KEY, newRootId);
      writeString(ASSETS_KEY, newAssetsId);
      return { rootId: newRootId, assetsId: newAssetsId };
    })().finally(() => {
      rootJob = null;
    });
  }
  return rootJob;
}

let rootJob: Promise<{ rootId: string; assetsId: string }> | null = null;

/**
 * Two top folders (or two _files folders under one) from syncs that raced: keeps the one already in use, else the
 * one with the most inside, moves what is in the others across, and trashes the emptied ones. Edits `files` to match.
 */
async function consolidateRoots(files: DriveFile[]): Promise<void> {
  const consolidate = async (group: DriveFile[], preferId: string | null) => {
    if (group.length < 2) return;
    const childCount = (f: DriveFile) => files.filter((x) => (x.parents ?? []).includes(f.id)).length;
    const keep =
      group.find((f) => f.id === preferId) ?? [...group].sort((a, b) => childCount(b) - childCount(a))[0];
    for (const extra of group) {
      if (extra.id === keep.id) continue;
      for (const child of files.filter((x) => (x.parents ?? []).includes(extra.id))) {
        await driveApi().updateMetadata(child.id, { addParent: keep.id, removeParent: extra.id });
        child.parents = (child.parents ?? []).map((p) => (p === extra.id ? keep.id : p));
      }
      await trashOnDrive(extra.id);
      files.splice(files.indexOf(extra), 1);
    }
  };
  await consolidate(files.filter((f) => f.mimeType === FOLDER_MIME && f.appProperties?.kind === "root"), readString(ROOT_KEY));
  const rootNow = files.find((f) => f.mimeType === FOLDER_MIME && f.appProperties?.kind === "root");
  if (rootNow) {
    await consolidate(
      files.filter((f) => f.mimeType === FOLDER_MIME && f.appProperties?.kind === "assets" && (f.parents ?? []).includes(rootNow.id)),
      readString(ASSETS_KEY),
    );
  }
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
    // A page closed mid-way can leave a folder on Drive that was never recorded here: use it, never add a second.
    const existing = (await driveApi().findFolders(folder.id))[0];
    if (existing) {
      setFolderDriveId(folder.id, existing.id);
      return existing.id;
    }
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

/** True when the file is in Drive afterwards. False when this computer does not have it, so it could not be sent. */
async function ensureBlobUploaded(blobId: string, assetsId: string): Promise<boolean> {
  const known = readJson<Record<string, string>>(BLOBS_KEY, {});
  if (known[blobId]) return true;
  const bytes = await getBlob(blobId);
  if (!bytes) return false;
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
  return true;
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
  const changesAtStart = changesOf(id);
  const project = loadProject(id);
  if (!project) return;
  const meta = listProjects().find((p) => p.id === id);

  try {
    const { assetsId } = await ensureRoot();
    const blobIds = new Set<string>();
    collectImportBlobIds(project.nodes, blobIds);
    let notSent = 0;
    for (const blobId of blobIds) if (!(await ensureBlobUploaded(blobId, assetsId))) notSent++;
    // A design that points at files nobody can send still goes up (its shapes are worth keeping), but it
    // is marked, so it is not mistaken for a complete copy.
    if (notSent) updateProjectMeta(id, (m) => { m.missingFiles = Math.max(m.missingFiles ?? 0, notSent); });

    const parentId = await driveFolderFor(meta?.folderId ?? null);
    // A design not linked to a Drive file may still have one (made on another computer): use it, never add a second.
    let fileId = meta?.driveId;
    if (!fileId) fileId = (await driveApi().findDesigns(project.id))[0]?.id;
    const file = await driveApi().upload({
      fileId,
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
    // Changed again (renamed, edited) while this was uploading: what Drive now holds is already out of date, so the
    // design stays marked and the send already queued for that change goes out. Clearing it here would let the
    // next sync take Drive's older name and contents over the newer ones.
    if (changesOf(id) === changesAtStart) clearDirty(id);
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
  // Read the file's version first: if it changes while downloading, the next sync simply fetches it again.
  const info = await driveApi().getFile(meta.driveId);
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
    m.driveModified = info.modifiedTime;
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
export async function pullIndex(openProjectId?: string): Promise<string | null> {
  let staleOpen: string | null = null;
  const files = await driveApi().listAll();
  await consolidateRoots(files);
  const root = files.find((f) => f.appProperties?.kind === "root");
  const assets = files.find((f) => f.appProperties?.kind === "assets");
  if (root) writeString(ROOT_KEY, root.id);
  if (assets) writeString(ASSETS_KEY, assets.id);

  const blobMap: Record<string, string> = {};
  for (const f of files) if (f.appProperties?.kind === "blob") blobMap[f.appProperties.blobId ?? f.name] = f.id;
  writeJson(BLOBS_KEY, blobMap);

  // Folders, parents before children.
  // A folder deleted here that Drive has not been told about yet must not be brought back by this very pull.
  const waitingFolders = new Set(readJson<PendingFolderTrash[]>(FOLDER_TRASH_KEY, []).map((j) => j.driveId));
  const allDriveFolders = files.filter(
    (f) => f.mimeType === FOLDER_MIME && f.appProperties?.kind === "folder" && !waitingFolders.has(f.id),
  );
  // Two Drive folders for one local folder: keep the linked (else newest) one, move anything inside across, trash the rest.
  const linkedDriveIds = new Map(listFolders().map((f) => [f.id, f.driveId]));
  const keepFolder = new Map<string, DriveFile>();
  const extraFolders: DriveFile[] = [];
  for (const df of allDriveFolders) {
    const localId = df.appProperties?.localId;
    if (!localId) continue;
    const current = keepFolder.get(localId);
    if (!current) {
      keepFolder.set(localId, df);
      continue;
    }
    const linked = linkedDriveIds.get(localId);
    const keep =
      current.id === linked ? current : df.id === linked ? df : (df.modifiedTime ?? "") > (current.modifiedTime ?? "") ? df : current;
    keepFolder.set(localId, keep);
    extraFolders.push(keep === current ? df : current);
  }
  for (const extra of extraFolders) {
    const keep = keepFolder.get(extra.appProperties!.localId!)!;
    for (const child of files.filter((f) => (f.parents ?? []).includes(extra.id))) {
      await driveApi().updateMetadata(child.id, { addParent: keep.id, removeParent: extra.id });
      child.parents = (child.parents ?? []).map((p) => (p === extra.id ? keep.id : p));
    }
    await trashOnDrive(extra.id);
  }
  const extraIds = new Set(extraFolders.map((f) => f.id));
  const driveFolders = allDriveFolders.filter((f) => !extraIds.has(f.id));
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
  // A folder that was linked to Drive and is no longer there was deleted on another computer: it goes here too,
  // and what was inside it moves up to the nearest folder that remains.
  const goneIds = new Set(folders.filter((f) => f.driveId && !onDrive.has(f.driveId)).map((f) => f.id));
  let keptFolders = folders;
  if (goneIds.size) {
    const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
    const climb = (start: string | null): string | null => {
      const seen = new Set<string>();
      let cursor = start;
      while (cursor && goneIds.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = parentOf.get(cursor) ?? null;
      }
      return cursor;
    };
    keptFolders = folders.filter((f) => !goneIds.has(f.id)).map((f) => ({ ...f, parentId: climb(f.parentId) }));
    for (const m of listProjects()) {
      if (!m.folderId || !goneIds.has(m.folderId)) continue;
      const target = climb(m.folderId);
      updateProjectMeta(m.id, (x) => {
        if (target) x.folderId = target;
        else delete x.folderId;
      });
    }
  }
  writeFolderList(keptFolders);

  // Designs.
  const allDesignFiles = files.filter((f) => f.appProperties?.kind === "design");
  const newestFor = new Map<string, DriveFile>();
  const duplicates: DriveFile[] = [];
  for (const d of allDesignFiles) {
    const localId = d.appProperties?.localId;
    if (!localId) continue;
    const current = newestFor.get(localId);
    if (!current) {
      newestFor.set(localId, d);
    } else if ((d.modifiedTime ?? "") > (current.modifiedTime ?? "")) {
      newestFor.set(localId, d);
      duplicates.push(current);
    } else {
      duplicates.push(d);
    }
  }
  if (duplicates.length) {
    const waiting = new Set(readJson<string[]>(TRASH_KEY, []));
    for (const f of duplicates) waiting.add(f.id);
    writeJson(TRASH_KEY, [...waiting]);
  }
  const duplicateIds = new Set(duplicates.map((f) => f.id));
  const driveDesigns = allDesignFiles.filter((f) => !duplicateIds.has(f.id));
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
        if (m.driveModified && m.driveModified !== d.modifiedTime) {
          if (m.id !== openProjectId) m.remote = true;
          else staleOpen = m.id; // refreshed by refreshOpenDesign once it is safe
        }
      });
    }
  }

  // A design that Drive no longer lists was removed on another computer. One with nothing here to lose goes
  // away. One with contents follows the deletion too, through the Bin so it can still be brought back, as long
  // as nothing in it is waiting to be sent and it is not the one open right now. Otherwise it only loses its
  // link (and is sent again the next time it is saved), so this never throws away work that exists nowhere else.
  for (const m of metas) {
    if (!m.driveId || seen.has(m.id)) continue;
    if (!hasProjectContents(m.id) || m.remote) {
      deleteProjectStorage(m.id);
    } else if (!isDirty(m.id) && m.id !== openProjectId) {
      moveToBin(m.id);
      deleteProjectStorage(m.id);
    } else {
      updateProjectMeta(m.id, (x) => { delete x.driveId; });
    }
  }
  return staleOpen;
}

// ---- keeping the open design current ----

/** When the open design last changed on this computer, and whether the editor is being updated from Drive right now. */
let lastLocalEdit = 0;
let applyingRemote = false;
const QUIET_BEFORE_REFRESH_MS = 5000;

/**
 * The open design was changed on another computer. Replaces what is on screen with Drive's copy, but only when
 * that cannot lose work: nothing waiting to be sent and no typing in the last few seconds. Otherwise the next
 * sync tries again.
 */
async function refreshOpenDesign(id: string): Promise<void> {
  if (isDirty(id) || Date.now() - lastLocalEdit < QUIET_BEFORE_REFRESH_MS) return;
  if (useDoc.getState().currentProjectId !== id) return;
  if (!(await fetchProject(id))) return;
  // The person may have started editing while the file downloaded.
  if (isDirty(id) || Date.now() - lastLocalEdit < QUIET_BEFORE_REFRESH_MS) return;
  applyingRemote = true;
  try {
    useDoc.getState().openProject(id);
  } finally {
    applyingRemote = false;
  }
}

// ---- moves, renames and deletes ----

// ---- thumbnails ----
/* A design's preview picture is made on the computer that drew it, so each one is also kept as its own small
   file in a hidden Drive folder. A computer that has never opened a design fetches just the pictures it lacks. */

/** Sets one entry of a small list kept in storage, reading the list fresh so a stale copy never overwrites another job's entry. */
function setEntry(key: string, id: string, value: string | undefined): void {
  const map = readJson<Record<string, string>>(key, {});
  if (value === undefined) delete map[id];
  else map[id] = value;
  writeJson(key, map);
}

let thumbsJob: Promise<string> | null = null;
async function ensureThumbsFolder(): Promise<string> {
  const cached = readString(THUMBS_KEY);
  if (cached) return cached;
  if (!thumbsJob) {
    thumbsJob = (async () => {
      const { rootId } = await ensureRoot();
      const found = await driveApi().findVersionsFolder("thumbs");
      const id = found?.id ?? (await driveApi().createFolder("_thumbnails", rootId, "thumbs")).id;
      writeString(THUMBS_KEY, id);
      return id;
    })().finally(() => {
      thumbsJob = null;
    });
  }
  return thumbsJob;
}

async function refreshThumbMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const f of await driveApi().listAuxByKind("thumb")) {
    const localId = f.appProperties?.localId;
    if (localId) map[localId] = f.id;
  }
  writeJson(THUMB_FILES_KEY, map);
  return map;
}

/** Sends a design's preview picture to Drive, unless Drive already has this very picture (same drawn-at time). */
export async function pushThumbnail(id: string, attempt = 0): Promise<void> {
  const thumb = loadThumbnail(id);
  if (!thumb) return;
  // A picture with no time (made before pictures were dated) is dated now: it is only sent when Drive has none.
  let at = thumbnailStamp(id);
  if (!at) {
    at = Date.now();
    stampThumbnail(id, at);
  }
  if (readJson<Record<string, string>>(THUMB_SIGS_KEY, {})[id] === String(at)) return;
  const parentId = await ensureThumbsFolder();
  let files = readJson<Record<string, string>>(THUMB_FILES_KEY, {});
  if (!files[id]) files = await refreshThumbMap();
  try {
    const file = await driveApi().upload({
      fileId: files[id],
      name: `${id}.thumbnail`,
      parentId,
      mimeType: "text/plain",
      body: thumb,
      kind: "thumb",
      properties: { localId: id, at: String(at) },
    });
    setEntry(THUMB_FILES_KEY, id, file.id);
    setEntry(THUMB_SIGS_KEY, id, String(at));
  } catch (error) {
    // The remembered file is gone from Drive: forget it and send a fresh one.
    if (error instanceof DriveError && error.status === 404 && attempt === 0) {
      setEntry(THUMB_FILES_KEY, id, undefined);
      return pushThumbnail(id, 1);
    }
    throw error;
  }
}

/**
 * Brings the preview pictures level with Drive's by one rule: the newest picture wins (see thumbnailAction).
 * Newer on Drive: fetched. Newer here, or Drive has none: sent.
 */
async function syncThumbnails(): Promise<void> {
  const remote = await driveApi().listAuxByKind("thumb");
  const files: Record<string, string> = {};
  for (const f of remote) if (f.appProperties?.localId) files[f.appProperties.localId] = f.id;
  writeJson(THUMB_FILES_KEY, files);

  const projects = listProjects();
  const remoteAt = new Map<string, number>();
  let fetched = 0;
  for (const f of remote) {
    const id = f.appProperties?.localId;
    if (!id || !projects.some((p) => p.id === id)) continue;
    const at = Number(f.appProperties?.at) || Date.parse(f.modifiedTime ?? "") || 0;
    remoteAt.set(id, at);
    const hasLocal = !!loadThumbnail(id);
    if (thumbnailAction({ has: hasLocal, at: hasLocal ? thumbnailStamp(id) : 0 }, { has: true, at }) !== "pull") continue;
    if (fetched++ >= 40) break;
    const text = await driveApi().downloadText(f.id);
    if (!text.startsWith("data:image")) continue;
    // Recorded as "already on Drive" before it is saved, so saving it does not send it straight back.
    setEntry(THUMB_SIGS_KEY, id, String(at));
    saveThumbnail(id, text, at);
  }

  // Pictures made here that are newer than Drive's, or that Drive has never had.
  let sent = 0;
  for (const p of projects) {
    if (p.location !== "drive" || p.remote || !loadThumbnail(p.id)) continue;
    const there = remoteAt.get(p.id);
    const action = thumbnailAction({ has: true, at: thumbnailStamp(p.id) }, { has: there !== undefined, at: there ?? 0 });
    if (action !== "push") continue;
    if (sent++ >= 25) break;
    await pushThumbnail(p.id);
  }
}

const thumbTimers = new Map<string, number>();
function queueThumbnailPush(id: string): void {
  window.clearTimeout(thumbTimers.get(id));
  thumbTimers.set(
    id,
    window.setTimeout(() => {
      thumbTimers.delete(id);
      void runSync(() => pushThumbnail(id));
    }, PUSH_DELAY_MS),
  );
}

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

let versionsJob: Promise<string> | null = null;
async function ensureVersionsFolder(): Promise<string> {
  const cached = readString(VERSIONS_KEY);
  if (cached) return cached;
  if (!versionsJob) {
    versionsJob = (async () => {
      const { rootId } = await ensureRoot();
      const found = await driveApi().findVersionsFolder();
      const id = found?.id ?? (await driveApi().createFolder("_versions", rootId, "versions")).id;
      writeString(VERSIONS_KEY, id);
      return id;
    })().finally(() => {
      versionsJob = null;
    });
  }
  return versionsJob;
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
  const folderJobs = readJson<PendingFolderTrash[]>(FOLDER_TRASH_KEY, []);
  if (folderJobs.length) {
    writeJson(FOLDER_TRASH_KEY, []);
    for (let i = 0; i < folderJobs.length; i++) {
      const job = folderJobs[i];
      try {
        for (const id of job.designIds) {
          const meta = listProjects().find((p) => p.id === id);
          if (meta?.driveId) await pushProject(id);
        }
        for (const id of job.subfolderIds) await moveFolderOnDrive(id);
        await trashOnDrive(job.driveId);
      } catch (error) {
        writeJson(FOLDER_TRASH_KEY, [...folderJobs.slice(i), ...readJson<PendingFolderTrash[]>(FOLDER_TRASH_KEY, [])]);
        throw error;
      }
    }
  }
  for (const id of dirtySet()) await pushProject(id);
}

// ---- checking that this computer and Drive agree ----

export type SyncCheckState = "same" | "driveNewer" | "thisNewer" | "differs" | "driveOnly" | "notOnDrive";
export type SyncCheckRow = { id: string; name: string; state: SyncCheckState; note: string; open: boolean };

/** Two copies of a design are the same when only default values are spelled differently (a missing "hidden" is "hidden: false"). */
function withoutDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDefaults);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if ((key === "hidden" || key === "collapsed") && v === false) continue;
      out[key] = withoutDefaults(v);
    }
    return out;
  }
  return value;
}

/**
 * Compares every design here with its file on Drive and says which side is ahead. Reads only: nothing is
 * changed. A design is "newer here" when it has changes waiting to be sent, and "newer on Drive" when Drive's
 * file changed since this computer last sent or fetched it.
 */
export async function checkSync(): Promise<SyncCheckRow[]> {
  const files = await driveApi().listAll();
  const onDrive = new Map(files.map((f) => [f.id, f]));
  const openId = useDoc.getState().currentProjectId;
  const rows: SyncCheckRow[] = [];
  for (const p of listProjects()) {
    const open = p.id === openId;
    const row = (state: SyncCheckState, note: string): SyncCheckRow => ({ id: p.id, name: p.name, state, note, open });
    if (!p.driveId) {
      if (hasProjectContents(p.id)) rows.push(row("notOnDrive", "Only on this computer; not saved to Drive."));
      continue;
    }
    const file = onDrive.get(p.driveId);
    if (!file) {
      rows.push(row("notOnDrive", "Drive no longer has this design."));
      continue;
    }
    if (!hasProjectContents(p.id)) {
      rows.push(row("driveOnly", "On Drive only; it downloads when you open it."));
      continue;
    }
    if (p.remote) {
      // Drive changed since this computer last had it; the old copy here is kept until it is opened or updated.
      rows.push(row("driveNewer", "Changed on another computer; this copy is older and refreshes when opened."));
      continue;
    }
    const local = loadProject(p.id);
    const remote = parseProjectFile(await driveApi().downloadText(file.id), p.name);
    if (!local || !remote) {
      rows.push(row("differs", "Could not read one of the copies."));
      continue;
    }
    if (JSON.stringify(withoutDefaults(local.nodes)) === JSON.stringify(withoutDefaults(remote.nodes))) {
      rows.push(row("same", ""));
      continue;
    }
    const waiting = isDirty(p.id);
    const driveChanged = !!p.driveModified && file.modifiedTime !== p.driveModified;
    if (waiting && !driveChanged) rows.push(row("thisNewer", "This computer has changes that have not been sent yet."));
    else if (driveChanged && !waiting) rows.push(row("driveNewer", "Changed on another computer; this copy is older."));
    else if (waiting && driveChanged) rows.push(row("differs", "Changed in both places since they last matched."));
    else rows.push(row("differs", "The two copies differ."));
  }
  return rows;
}

/** The safe fix for one row of the check: bring in Drive's newer copy, or send this computer's newer one. */
export async function fixSyncRow(row: SyncCheckRow): Promise<void> {
  if (row.state === "driveNewer" && !row.open) await fetchProject(row.id);
  else if (row.state === "thisNewer") await pushProject(row.id);
}

/** Runs a Drive job, keeping the connection state and the last error up to date. */
const runOneAtATime = createSerialRunner();
let jobsWaiting = 0;

export async function runSync<T>(job: () => Promise<T>): Promise<T | undefined> {
  const drive = useDrive.getState();
  if (drive.status !== "signedIn" && !hasToken()) return undefined;
  jobsWaiting++;
  drive.setBusy(true);
  try {
    // One job at a time: see createSerialRunner for what overlapping jobs used to do.
    return await runOneAtATime(async (): Promise<T | undefined> => {
      try {
        const result = await job();
        useDrive.getState().markSynced();
        return result;
      } catch (error) {
        if (error instanceof DriveAuthError) {
          if (error instanceof DriveScopeError) signedOutByGoogle(error.message, true);
          else signedOutByGoogle();
          useDrive.getState().setStatus("signedOut");
        }
        useDrive.getState().setError(
          error instanceof Error && error.message ? error.message : "Couldn't reach Google Drive. Your changes will be sent next time.",
        );
        return undefined;
      }
    });
  } finally {
    jobsWaiting--;
    if (jobsWaiting === 0) useDrive.getState().setBusy(false);
  }
}

let fullSyncWaiting = false;

/** Reads Drive's current state, sends anything waiting, and refreshes what the Home page shows. */
export async function syncNow(): Promise<void> {
  // The minute check, a tab coming back into view and the button can all ask at nearly the same moment;
  // one full sync waiting its turn covers every one of them.
  if (fullSyncWaiting) return;
  fullSyncWaiting = true;
  await runSync(async () => {
    fullSyncWaiting = false;
    adoptAllIntoDrive();
    await flushPending();
    // Folders made before Drive was connected (or still empty) get their Drive twin too.
    for (const f of listFolders()) if (!f.driveId) await driveFolderFor(f.id);
    const staleOpen = await pullIndex(useDoc.getState().currentProjectId);
    if (staleOpen) await refreshOpenDesign(staleOpen);
    try {
      await syncThumbnails();
    } catch (error) {
      if (error instanceof DriveAuthError) throw error;
      /* preview pictures are a bonus: the designs themselves are already level */
    }
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

/** Notes and anything else that keeps itself level with Drive listens for this and checks again. */
export const AUTO_SYNC_EVENT = "shapeforge:autosync";

const AUTO_SYNC_EVERY_MS = 60_000;
// Switching tabs back and forth must not turn into a flood of requests.
const AUTO_SYNC_MIN_GAP_MS = 20_000;

/**
 * Keeps this computer up to date without being asked: when the tab comes back into view, when the window
 * is focused, and once a minute while ShapeForge is open, visible and connected. Returns a function that stops it.
 */
export function startAutoSync(): () => void {
  let last = 0;
  const check = () => {
    if (document.visibilityState !== "visible") return;
    const drive = useDrive.getState();
    if (drive.status !== "signedIn" || drive.busy) return;
    if (Date.now() - last < AUTO_SYNC_MIN_GAP_MS) return;
    last = Date.now();
    void syncNow();
    window.dispatchEvent(new Event(AUTO_SYNC_EVENT));
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
  const timer = window.setInterval(check, AUTO_SYNC_EVERY_MS);
  return () => {
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", check);
    window.clearInterval(timer);
  };
}

export function installDriveHooks(): void {
  thumbnailHooks.onSaved = (id) => {
    const meta = listProjects().find((p) => p.id === id);
    if (meta?.location === "drive" && useDrive.getState().status === "signedIn") queueThumbnailPush(id);
  };
  driveHooks.onProjectChanged = (id) => {
    adoptIntoDrive(id);
    const meta = listProjects().find((p) => p.id === id);
    if (meta?.location === "drive") queuePush(id);
  };
  driveHooks.onProjectDeleted = (meta: ProjectMeta) => {
    clearDirty(meta.id);
    if (!meta.driveId) return;
    const driveId = meta.driveId;
    // Its preview picture file goes with it.
    const thumbs = readJson<Record<string, string>>(THUMB_FILES_KEY, {});
    const sigs = readJson<Record<string, string>>(THUMB_SIGS_KEY, {});
    const thumbFile = thumbs[meta.id];
    delete thumbs[meta.id];
    delete sigs[meta.id];
    writeJson(THUMB_FILES_KEY, thumbs);
    writeJson(THUMB_SIGS_KEY, sigs);
    writeJson(TRASH_KEY, [...readJson<string[]>(TRASH_KEY, []), driveId, ...(thumbFile ? [thumbFile] : [])]);
    void runSync(flushPending);
  };
  driveHooks.onFolderRenamed = (folderId) => {
    const folder = listFolders().find((f) => f.id === folderId);
    if (folder) pushFolderToDrive(folderId, (driveId) => driveApi().updateMetadata(driveId, { name: folder.name }));
  };
  driveHooks.onFolderMoved = (folderId) => {
    void runSync(() => moveFolderOnDrive(folderId));
  };
  driveHooks.onFolderDeleted = ({ folder, designIds, subfolderIds }) => {
    if (!folder.driveId) return;
    writeJson(FOLDER_TRASH_KEY, [
      ...readJson<PendingFolderTrash[]>(FOLDER_TRASH_KEY, []),
      { driveId: folder.driveId, designIds, subfolderIds },
    ]);
    void runSync(flushPending);
  };

  // Every edit to a design that lives on Drive is sent a moment later. Opening a design changes
  // the open design's id too, so only a change within the same design counts.
  useDoc.subscribe((state, previous) => {
    if (state.nodes === previous.nodes || state.currentProjectId !== previous.currentProjectId) return;
    if (applyingRemote) return; // it came from Drive, so there is nothing to send back
    lastLocalEdit = Date.now();
    // The editor's own save lands a moment after the edit, so give it time before adopting.
    const id = state.currentProjectId;
    window.setTimeout(() => {
      adoptIntoDrive(id);
      if (listProjects().find((p) => p.id === id)?.location === "drive") queuePush(id);
    }, 600);
  });
}
