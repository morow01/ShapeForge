import { useEffect, useRef, useState } from "react";
import { useDoc } from "../document/store";
import { binCount as countBin, collectFolderTree, exportProjectFile, hasProjectContents, loadProject, loadThumbnail, locationOf } from "../document/persist";
import { BinView } from "./BinView";
import { VersionHistoryDialog } from "./VersionHistoryDialog";
import type { FolderMeta, ProjectMeta } from "../document/types";
import { APP_NAME, APP_VERSION } from "../version";
import { useConfirm } from "./ConfirmDialog";
import { DriveSetupDialog } from "./DriveSetupDialog";
import { connectDrive } from "../drive/actions";
import { signOut, wasConnected } from "../drive/auth";
import { fetchProject, runSync, syncNow } from "../drive/sync";
import { useDrive } from "../drive/state";
import { DuplicateIcon, ExportIcon, FolderOpenIcon, PlusIcon, TrashIcon } from "./icons";

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** What the main area is showing: a folder (null = the top level) or a flat list. */
type View = { kind: "folder"; id: string | null } | { kind: "recent" } | { kind: "draft" } | { kind: "browser" } | { kind: "drive" } | { kind: "bin" };

type HomePageProps = {
  open: boolean;
  /** Close Home and go to the editor, which is showing whichever design is open. */
  onClose: () => void;
  /** Start a design; folderId is the folder being viewed, if any. */
  onNewDesign: (folderId: string | null) => void;
  /** Changes when a new preview picture has been saved, so the cards redraw. */
  thumbVersion?: number;
  onProjectLoadStart?: (name: string) => void;
  onProjectLoadApplied?: () => void;
  onProjectLoadFailed?: () => void;
};

/** Folders from the top level down to (and including) the given one. */
function folderPath(folders: FolderMeta[], id: string | null): FolderMeta[] {
  const path: FolderMeta[] = [];
  let cursor = id;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const f = folders.find((x) => x.id === cursor);
    if (!f) break;
    path.unshift(f);
    cursor = f.parentId;
  }
  return path;
}

/** Every folder as a flat list in tree order, with how deep each one sits. */
function folderTree(folders: FolderMeta[]): { folder: FolderMeta; depth: number }[] {
  const out: { folder: FolderMeta; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      });
  };
  walk(null, 0);
  return out;
}

type NameDialogState = {
  mode: "new" | "rename" | "renameDesign";
  folderId?: string;
  projectId?: string;
  parentId: string | null;
} | null;

type MenuState = {
  x: number;
  y: number;
  target: { kind: "design"; project: ProjectMeta } | { kind: "folder"; folder: FolderMeta };
} | null;

/** A design being dragged to a folder: follows the pointer until it is let go. */
type DragState = { ids: string[]; name: string; thumb: string | null; x: number; y: number } | null;

const DRAG_START_DISTANCE = 6;

/**
 * The start page: folders and designs, with where each design is kept. It sits over
 * the editor rather than replacing it, so the editor stays loaded behind it and
 * "back to the editor" is instant.
 */
export function HomePage({
  open,
  onClose,
  onNewDesign,
  thumbVersion = 0,
  onProjectLoadStart,
  onProjectLoadApplied,
  onProjectLoadFailed,
}: HomePageProps) {
  const currentProjectId = useDoc((s) => s.currentProjectId);
  const projects = useDoc((s) => s.projects);
  const folders = useDoc((s) => s.folders);
  const openProject = useDoc((s) => s.openProject);
  const duplicateProject = useDoc((s) => s.duplicateProject);
  const deleteProject = useDoc((s) => s.deleteProject);
  const importProjectFile = useDoc((s) => s.importProjectFile);
  const createFolder = useDoc((s) => s.createFolder);
  const renameFolder = useDoc((s) => s.renameFolder);
  const deleteFolder = useDoc((s) => s.deleteFolder);
  const moveProjectToFolder = useDoc((s) => s.moveProjectToFolder);  const renameProjectById = useDoc((s) => s.renameProjectById);

  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>({ kind: "folder", id: null });
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [moving, setMoving] = useState<ProjectMeta[] | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | "none">("none");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  dragRef.current = drag;
  const pressRef = useRef<{ ids: string[]; name: string; thumb: string | null; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const { ask, dialog: confirmDialog } = useConfirm();
  const driveConfigured = useDrive((s) => s.configured);
  const driveStatus = useDrive((s) => s.status);
  const driveEmail = useDrive((s) => s.email);
  const driveBusy = useDrive((s) => s.busy);
  const driveError = useDrive((s) => s.lastError);
  const [setupOpen, setSetupOpen] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  // The click that ends a drag must not also open the design under the pointer.
  const suppressClickRef = useRef(false);

  // Dragging is done with pointer events rather than the browser's own drag and drop:
  // that shows only a faint ghost, shows a "not allowed" cursor over anything that is
  // not a target, and does nothing at all with a pen or finger.
  useEffect(() => {
    if (!open) return;
    const dropAt = (x: number, y: number): string | null | "none" => {
      const el = document.elementFromPoint(x, y)?.closest("[data-drop]") as HTMLElement | null;
      if (!el) return "none";
      const value = el.dataset.drop;
      return value === "root" ? null : value ?? "none";
    };
    const onMove = (e: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (!dragRef.current && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_START_DISTANCE) return;
      setMenu(null);
      setDrag({ ids: press.ids, name: press.name, thumb: press.thumb, x: e.clientX, y: e.clientY });
      setDropTarget(dropAt(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const press = pressRef.current;
      pressRef.current = null;
      if (!press || !dragRef.current) return;
      const target = dropAt(e.clientX, e.clientY);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 80);
      setDrag(null);
      setDropTarget("none");
      if (e.type === "pointerup" && target !== "none") {
        for (const id of press.ids) useDoc.getState().moveProjectToFolder(id, target);
        // They have moved, so they are no longer "picked".
        setSelected(new Set());
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [open]);

  // A selection belongs to the folder or search it was made in.
  useEffect(() => {
    setSelected(new Set());
  }, [view, search]);

  // The right-click menu closes on any click elsewhere, Escape, scrolling or resizing.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest(".home-menu")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  if (!open) return null;

  // A folder that no longer exists falls back to the top level.
  const viewFolderId = view.kind === "folder" && view.id && folders.some((f) => f.id === view.id) ? view.id : null;
  const needle = search.toLowerCase().trim();
  const searching = needle.length > 0;

  const drafts = projects.filter((p) => locationOf(p) === "draft");
  const kept = projects.filter((p) => locationOf(p) === "browser");
  const onDrive = projects.filter((p) => locationOf(p) === "drive");
  // A design known only from Drive's listing shows 0 shapes because it has not been fetched yet, not because it is empty.
  const binCount = countBin();
  const empties = projects.filter((p) => p.objectCount === 0 && !p.remote && p.id !== currentProjectId);

  let designs: ProjectMeta[];
  let subfolders: FolderMeta[] = [];
  if (searching) {
    designs = projects.filter((p) => p.name.toLowerCase().includes(needle));
  } else if (view.kind === "recent") {
    designs = projects.slice(0, 24);
  } else if (view.kind === "draft") {
    designs = drafts;
  } else if (view.kind === "browser") {
    designs = kept;
  } else if (view.kind === "drive") {
    designs = onDrive;
  } else if (view.kind === "bin") {
    designs = [];
  } else {
    designs = viewFolderId === null ? projects : projects.filter((p) => p.folderId === viewFolderId);
    subfolders = folders.filter((f) => f.parentId === viewFolderId).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Only designs that are on screen count as selected, so a bulk action can never touch
  // something in a folder you have since left.
  const selectedDesigns = designs.filter((p) => selected.has(p.id));
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const countIn = (folderId: string) => projects.filter((p) => p.folderId === folderId).length;
  const trail = folderPath(folders, viewFolderId);

  const title = searching
    ? `Results for "${search.trim()}"`
    : view.kind === "recent"
      ? "Recent"
      : view.kind === "draft"
        ? "Not saved yet"
        : view.kind === "browser"
          ? "This browser"
          : view.kind === "drive"
            ? "Google Drive"
            : view.kind === "bin"
              ? "Bin"
              : null;

  const handleOpen = async (p: ProjectMeta) => {
    if (suppressClickRef.current) return;
    if (p.id === currentProjectId) {
      onClose();
      return;
    }
    // A design that lives on Drive and is not on this computer yet is downloaded first.
    if (p.remote || (locationOf(p) === "drive" && !hasProjectContents(p.id))) {
      if (useDrive.getState().status !== "signedIn") {
        void ask({
          title: "Connect to Google Drive",
          message: "This design is stored in your Google Drive. Connect Google Drive to open it here.",
          confirmLabel: "OK",
          cancelLabel: null,
        });
        return;
      }
      setOpeningId(p.id);
      const ok = await runSync(() => fetchProject(p.id));
      setOpeningId(null);
      if (!ok) {
        void ask({
          title: "Couldn't open that design",
          message: useDrive.getState().lastError ?? "It could not be downloaded from Google Drive. Try again in a moment.",
          confirmLabel: "OK",
          cancelLabel: null,
        });
        return;
      }
    }
    onProjectLoadStart?.(p.name);
    if (openProject(p.id)) {
      onProjectLoadApplied?.();
      onClose();
    } else {
      onProjectLoadFailed?.();
    }
  };

  const handleDownload = async (p: ProjectMeta) => {
    const full = loadProject(p.id);
    if (full) await exportProjectFile(full);
  };

  const handleDelete = async (p: ProjectMeta) => {
    const ok = await ask({
      title: "Delete design?",
      message: `"${p.name}" moves to the Bin and is kept for 30 days.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) deleteProject(p.id);
  };

  const handleClean = async () => {
    const count = empties.length;
    const ok = await ask({
      title: `Clear ${count} empty ${count === 1 ? "design" : "designs"}?`,
      message: `${count === 1 ? "It has" : "They have"} no shapes in ${count === 1 ? "it" : "them"}. This cannot be undone.`,
      confirmLabel: "Clear",
      destructive: true,
    });
    if (ok) for (const p of empties) deleteProject(p.id);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    onProjectLoadStart?.(file.name);
    try {
      if (await importProjectFile(file)) {
        onProjectLoadApplied?.();
        onClose();
        return;
      }
    } catch {
      /* falls through to the message below */
    }
    onProjectLoadFailed?.();
    void ask({
      title: "Couldn't open that file",
      message: "Choose a ShapeForge (.shapeforge) or CAD JSON file.",
      confirmLabel: "OK",
      cancelLabel: null,
    });
  };

  const startNewFolder = (parentId: string | null) => {
    setNameDraft("");
    setNameDialog({ mode: "new", parentId });
  };

  const startRenameDesign = (p: ProjectMeta) => {
    setNameDraft(p.name);
    setNameDialog({ mode: "renameDesign", projectId: p.id, parentId: null });
  };

  const startRename = (f: FolderMeta) => {
    setNameDraft(f.name);
    setNameDialog({ mode: "rename", folderId: f.id, parentId: f.parentId });
  };

  const submitName = () => {
    const name = nameDraft.trim();
    if (!name || !nameDialog) return;
    if (nameDialog.mode === "new") {
      const id = createFolder(name, nameDialog.parentId);
      setSearch("");
      setView({ kind: "folder", id });
    } else if (nameDialog.mode === "renameDesign" && nameDialog.projectId) {
      renameProjectById(nameDialog.projectId, name);
    } else if (nameDialog.folderId) {
      renameFolder(nameDialog.folderId, name);
    }
    setNameDialog(null);
  };

  const handleDeleteFolder = async (f: FolderMeta) => {
    const tree = collectFolderTree(f.id);
    const designCount = projects.filter((p) => p.folderId && tree.includes(p.folderId)).length;
    const note = designCount
      ? `The ${designCount} ${designCount === 1 ? "design" : "designs"} inside go with it.`
      : "It is empty.";
    const ok = await ask({
      title: "Delete folder?",
      message: `"${f.name}" moves to the Bin and is kept for 30 days. ${note}`,
      confirmLabel: "Delete folder",
      destructive: true,
    });
    if (!ok) return;
    deleteFolder(f.id);
    if (viewFolderId === f.id) setView({ kind: "folder", id: f.parentId });
  };

  const startMove = (group: ProjectMeta[]) => {
    setMoving(group);
    const first = group[0]?.folderId ?? null;
    setMoveTarget(group.every((p) => (p.folderId ?? null) === first) ? first : null);
  };

  const submitMove = () => {
    if (moving) for (const p of moving) moveProjectToFolder(p.id, moveTarget);
    setMoving(null);
    setSelected(new Set());
  };

  const handleDeleteMany = async (group: ProjectMeta[]) => {
    if (group.length === 1) {
      await handleDelete(group[0]);
      return;
    }
    const ok = await ask({
      title: `Delete ${group.length} designs?`,
      message: "They move to the Bin and are kept for 30 days.",
      confirmLabel: `Delete ${group.length} designs`,
      destructive: true,
    });
    if (!ok) return;
    for (const p of group) deleteProject(p.id);
    setSelected(new Set());
  };

  /** Marks an element as somewhere a design can be dropped (null = the top level). While
   *  dragging, a place every dragged design is already in is left unmarked: dropping there
   *  would change nothing, so it should not look like a target. */
  const dropProps = (folderId: string | null): { "data-drop"?: string } => {
    if (drag && drag.ids.every((id) => (projects.find((p) => p.id === id)?.folderId ?? null) === folderId)) return {};
    return { "data-drop": folderId ?? "root" };
  };

  const beginPress = (e: React.PointerEvent, p: ProjectMeta, thumb: string | null) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    if ((e.target as Element).closest(".home-actions, .home-check")) return;
    // Dragging one of several selected designs takes all of them.
    const group = selected.has(p.id) && selectedDesigns.length > 1 ? selectedDesigns.map((d) => d.id) : [p.id];
    const label = group.length > 1 ? `${group.length} designs` : p.name;
    pressRef.current = { ids: group, name: label, thumb, x: e.clientX, y: e.clientY };
  };

  const openMenu = (e: React.MouseEvent, target: NonNullable<MenuState>["target"]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const emptyText = searching
    ? "No designs match your search."
    : view.kind === "draft"
      ? "Nothing waiting to be saved."
      : view.kind === "folder" && viewFolderId
        ? "This folder is empty. Create a design here, or drag one in."
        : "No designs yet. Create one to get started.";

  const navClass = (active: boolean, drop?: boolean) => `home-nav${active ? " on" : ""}${drop ? " drop" : ""}`;
  const atRoot = !searching && view.kind === "folder" && viewFolderId === null;

  return (
    <div className={`home-page${drag ? " is-dragging" : ""}`} role="dialog" aria-label="All designs" data-previews={thumbVersion}>
      <header className="home-top">
        <div className="home-brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">{APP_NAME}</span>
          <span className="brand-version">v{APP_VERSION}</span>
        </div>
        <input
          type="search"
          className="home-search"
          placeholder="Search designs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search designs"
        />
        <span className="home-spacer" />
        <button className="modal-btn" onClick={() => startNewFolder(viewFolderId)} title="Make a folder here">
          <PlusIcon className="modal-btn-icon" />
          <span>New folder</span>
        </button>
        <button className="modal-btn" onClick={() => fileInputRef.current?.click()} title="Open a .shapeforge or .json file from your computer">
          <FolderOpenIcon className="modal-btn-icon" />
          <span>Open file</span>
        </button>
        <button className="modal-btn primary" onClick={() => onNewDesign(view.kind === "folder" ? viewFolderId : null)}>
          <PlusIcon className="modal-btn-icon" />
          <span>New design</span>
        </button>
        <input ref={fileInputRef} type="file" accept=".shapeforge,.json" hidden onChange={handleFile} />
      </header>

      <div className="home-body">
        <nav className="home-side" aria-label="Locations">
          <button
            className={navClass(atRoot, dropTarget === null)}
            onClick={() => { setSearch(""); setView({ kind: "folder", id: null }); }}
            {...dropProps(null)}
          >
            <span>All designs</span>
            <span className="home-count">{projects.length}</span>
          </button>
          <button className={navClass(!searching && view.kind === "recent")} onClick={() => { setSearch(""); setView({ kind: "recent" }); }}>
            <span>Recent</span>
          </button>

          <div className="home-side-head">
            <span>Folders</span>
            <button className="home-side-add" onClick={() => startNewFolder(null)} title="New folder" aria-label="New folder">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M7 1.5v11M1.5 7h11" />
              </svg>
            </button>
          </div>
          {folders.length === 0 && <p className="home-side-empty">No folders yet</p>}
          {folderTree(folders).map(({ folder, depth }) => (
            <button
              key={folder.id}
              className={navClass(!searching && view.kind === "folder" && viewFolderId === folder.id, dropTarget === folder.id)}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => { setSearch(""); setView({ kind: "folder", id: folder.id }); }}
              {...dropProps(folder.id)}
            >
              <span className="home-nav-name">{folder.name}</span>
              <span className="home-count">{countIn(folder.id)}</span>
            </button>
          ))}

          <div className="home-side-label">Where they are</div>
          <button className={navClass(!searching && view.kind === "draft")} onClick={() => { setSearch(""); setView({ kind: "draft" }); }}>
            <span>Not saved yet</span>
            <span className="home-count">{drafts.length}</span>
          </button>
          <button className={navClass(!searching && view.kind === "browser")} onClick={() => { setSearch(""); setView({ kind: "browser" }); }}>
            <span>This browser</span>
            <span className="home-count">{kept.length}</span>
          </button>
          {driveStatus === "signedIn" ? (
            <>
              <button className={navClass(!searching && view.kind === "drive")} onClick={() => { setSearch(""); setView({ kind: "drive" }); }}>
                <span>Google Drive</span>
                <span className="home-count">{onDrive.length}</span>
              </button>
              <div className="home-drive-box">
                <span className="home-drive-email" title={driveEmail ?? ""}>{driveEmail ?? "Connected"}</span>
                <span className={`home-drive-state${driveError ? " bad" : ""}`}>
                  {driveBusy ? "Syncing…" : driveError ? "Not synced" : "Up to date"}
                </span>
                {driveError && <span className="home-drive-error">{driveError}</span>}
                <div className="home-drive-actions">
                  <button className="home-link" onClick={() => void syncNow()} disabled={driveBusy}>Sync now</button>
                  <button className="home-link" onClick={() => signOut()}>Sign out</button>
                </div>
              </div>
            </>
          ) : !driveConfigured ? (
            <button className="home-nav" onClick={() => setSetupOpen(true)} title="Save your designs to your own Google Drive">
              <span>Set up Google Drive</span>
            </button>
          ) : (
            <div className="home-drive-box">
              <button className="modal-btn primary home-drive-connect" disabled={driveStatus === "connecting"} onClick={() => void connectDrive()}>
                {driveStatus === "connecting" ? "Connecting…" : wasConnected() ? "Reconnect Google Drive" : "Connect Google Drive"}
              </button>
              {driveError && <span className="home-drive-error">{driveError}</span>}
              <button className="home-link" onClick={() => setSetupOpen(true)}>Change client ID</button>
            </div>
          )}
          <button className={navClass(!searching && view.kind === "bin")} onClick={() => { setSearch(""); setView({ kind: "bin" }); }}>
            <span>Bin</span>
            <span className="home-count">{binCount}</span>
          </button>
          {empties.length > 0 && (
            <button className="home-clean" onClick={handleClean} title="Removes designs that have no shapes in them">
              Clear {empties.length} empty {empties.length === 1 ? "design" : "designs"}
            </button>
          )}
          <p className="home-side-note">
            Designs in this browser live only on this computer. Download a backup file to keep a copy elsewhere.
          </p>
        </nav>

        <main className="home-main">
          {title ? (
            <h1 className="home-title">{title}</h1>
          ) : (
            <div className="home-crumbs" aria-label="Folder path">
              <button className="home-crumb" onClick={() => setView({ kind: "folder", id: null })} {...dropProps(null)}>
                All designs
              </button>
              {trail.map((f) => (
                <span key={f.id} className="home-crumb-wrap">
                  <span className="home-crumb-sep" aria-hidden="true">›</span>
                  <button className="home-crumb" onClick={() => setView({ kind: "folder", id: f.id })} {...dropProps(f.id)}>
                    {f.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          {subfolders.length > 0 && (
            <div className="home-folders">
              {subfolders.map((f) => (
                <div
                  key={f.id}
                  className={`home-folder${dropTarget === f.id ? " drop" : ""}`}
                  {...dropProps(f.id)}
                  onContextMenu={(e) => openMenu(e, { kind: "folder", folder: f })}
                >
                  <button className="home-folder-open" onClick={() => setView({ kind: "folder", id: f.id })} title={`Open ${f.name}`}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    </svg>
                    <span className="home-folder-text">
                      <b>{f.name}</b>
                      <span>{countIn(f.id)} {countIn(f.id) === 1 ? "design" : "designs"}</span>
                    </span>
                  </button>
                  <div className="home-folder-actions">
                    <button className="home-act" onClick={() => startRename(f)} title="Rename folder" aria-label={`Rename ${f.name}`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 20h4L19 9l-4-4L4 16z" />
                      </svg>
                    </button>
                    <button className="home-act delete" onClick={() => handleDeleteFolder(f)} title="Delete folder" aria-label={`Delete ${f.name}`}>
                      <TrashIcon className="home-act-icon" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!searching && view.kind === "bin" && <BinView ask={ask} />}
          {!(view.kind === "bin" && !searching) && designs.length === 0 && subfolders.length === 0 && <div className="home-empty">{emptyText}</div>}

          {selectedDesigns.length > 0 && (
            <div className="home-selbar" role="toolbar" aria-label="Selected designs">
              <b>{selectedDesigns.length} selected</b>
              <button className="modal-btn" onClick={() => startMove(selectedDesigns)}>Move to folder…</button>
              <button className="modal-btn home-danger" onClick={() => handleDeleteMany(selectedDesigns)}>Delete</button>
              {selectedDesigns.length < designs.length && (
                <button className="modal-btn" onClick={() => setSelected(new Set(designs.map((d) => d.id)))}>Select all {designs.length}</button>
              )}
              <button className="modal-btn" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}

          {designs.length > 0 && (
            <div className="home-grid">
              {designs.map((p) => {
                const where = locationOf(p);
                const thumb = loadThumbnail(p.id);
                const folderName = p.folderId ? folders.find((f) => f.id === p.folderId)?.name : null;
                return (
                  <div
                    key={p.id}
                    className={`home-card${p.id === currentProjectId ? " current" : ""}${drag?.ids.includes(p.id) ? " lifted" : ""}${selected.has(p.id) ? " selected" : ""}`}
                    onPointerDown={(e) => beginPress(e, p, thumb)}
                    onContextMenu={(e) => openMenu(e, { kind: "design", project: p })}
                  >
                    <button
                      className={`home-check${selected.has(p.id) ? " on" : ""}`}
                      role="checkbox"
                      aria-checked={selected.has(p.id)}
                      aria-label={`Select ${p.name}`}
                      onClick={() => toggleSelected(p.id)}
                    >
                      {selected.has(p.id) ? "✓" : ""}
                    </button>
                    <button
                      className="home-thumb"
                      onClick={(e) => (e.ctrlKey || e.metaKey ? toggleSelected(p.id) : handleOpen(p))}
                      title={`Open ${p.name}`}
                    >
                      {thumb ? (
                        <img src={thumb} alt="" draggable={false} />
                      ) : (
                        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
                          <path d="M4 7.5 12 12l8-4.5M12 12v9" />
                        </svg>
                      )}
                    </button>
                    <div className="home-cap">
                      <button className="home-name" onClick={() => handleOpen(p)} title={p.name}>{p.name}</button>
                      <span className="home-meta">
                        {openingId === p.id
                          ? "Downloading from Drive…"
                          : p.remote
                            ? `On Google Drive · ${timeAgo(p.updatedAt)}`
                            : `${p.objectCount} ${p.objectCount === 1 ? "shape" : "shapes"} · ${timeAgo(p.updatedAt)}`}
                        {p.id === currentProjectId ? " · open" : ""}
                      </span>
                      {(searching || view.kind !== "folder" || viewFolderId === null) && folderName && <span className="home-meta">In {folderName}</span>}
                      <span className={`home-tag ${where}`}>{where === "draft" ? "Not saved yet" : where === "drive" ? "Google Drive" : "This browser"}</span>
                      <div className="home-actions">
                        <button className="home-act" onClick={() => startRenameDesign(p)} title="Rename" aria-label={`Rename ${p.name}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M4 20h4L19 9l-4-4L4 16z" />
                          </svg>
                        </button>
                        <button className="home-act" onClick={() => duplicateProject(p.id)} title="Duplicate" aria-label={`Duplicate ${p.name}`}>
                          <DuplicateIcon className="home-act-icon" />
                        </button>
                        <button className="home-act" onClick={() => startMove([p])} title="Move to folder" aria-label={`Move ${p.name} to a folder`}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                            <path d="M9 13h6m-2.5-2.5L15 13l-2.5 2.5" />
                          </svg>
                        </button>
                        <button className="home-act" onClick={() => handleDownload(p)} title="Download backup file" aria-label={`Download ${p.name}`}>
                          <ExportIcon className="home-act-icon" />
                        </button>
                        <button className="home-act delete" onClick={() => handleDelete(p)} title="Delete" aria-label={`Delete ${p.name}`}>
                          <TrashIcon className="home-act-icon" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      {nameDialog && (
        <div className="modal-backdrop" onClick={() => setNameDialog(null)}>
          <div className="save-dialog" role="dialog" aria-label={nameDialog.mode === "new" ? "New folder" : "Rename"} onClick={(e) => e.stopPropagation()}>
            <h2>{nameDialog.mode === "new" ? "New folder" : nameDialog.mode === "renameDesign" ? "Rename design" : "Rename folder"}</h2>
            {nameDialog.mode === "new" && (
              <p className="save-label" style={{ margin: 0 }}>
                In: {["All designs", ...folderPath(folders, nameDialog.parentId).map((f) => f.name)].join(" › ")}
              </p>
            )}
            <input
              className="save-name"
              value={nameDraft}
              placeholder={nameDialog.mode === "renameDesign" ? "Design name" : "Folder name"}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitName();
                if (e.key === "Escape") setNameDialog(null);
              }}
              autoFocus
            />
            <div className="save-buttons">
              <button className="modal-btn" onClick={() => setNameDialog(null)}>Cancel</button>
              <button className="modal-btn primary" onClick={submitName}>{nameDialog.mode === "new" ? "Create" : "Rename"}</button>
            </div>
          </div>
        </div>
      )}

      {drag && (
        <>
          <div className="home-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
            {drag.thumb ? <img src={drag.thumb} alt="" /> : <div className="home-ghost-ph" />}
            {drag.ids.length > 1 && <span className="home-ghost-count">{drag.ids.length}</span>}
            <b>{drag.name}</b>
          </div>
          <div className="home-drag-hint" role="status">
            {folders.length
              ? `Drop ${drag.ids.length > 1 ? drag.name : `"${drag.name}"`} on a folder to move ${drag.ids.length > 1 ? "them" : "it"}. Drop on All designs to take ${drag.ids.length > 1 ? "them" : "it"} out of a folder.`
              : "Make a folder with New folder, then drag designs into it."}
          </div>
        </>
      )}

      {menu && (
        <div
          className="home-menu"
          role="menu"
          style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 210)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 280)) }}
        >
          {menu.target.kind === "design" ? (
            (() => {
              const p = menu.target.project;
              const group = selected.has(p.id) && selectedDesigns.length > 1 ? selectedDesigns : [p];
              const many = group.length > 1;
              return (
                <>
                  {!many && <button role="menuitem" onClick={() => { setMenu(null); handleOpen(p); }}>Open</button>}
                  {!many && <button role="menuitem" onClick={() => { setMenu(null); startRenameDesign(p); }}>Rename…</button>}
                  <button role="menuitem" onClick={() => { setMenu(null); startMove(group); }}>{many ? `Move ${group.length} designs…` : "Move to folder…"}</button>
                  {!many && driveStatus === "signedIn" && locationOf(p) === "drive" && (
                    <button role="menuitem" onClick={() => { setMenu(null); setHistoryFor(p.id); }}>Version history…</button>
                  )}
                  {!many && <button role="menuitem" onClick={() => { setMenu(null); duplicateProject(p.id); }}>Duplicate</button>}
                  {!many && <button role="menuitem" onClick={() => { setMenu(null); handleDownload(p); }}>Download backup file</button>}
                  <hr />
                  <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); handleDeleteMany(group); }}>{many ? `Delete ${group.length} designs` : "Delete"}</button>
                </>
              );
            })()
          ) : (
            (() => {
              const f = menu.target.folder;
              return (
                <>
                  <button role="menuitem" onClick={() => { setMenu(null); setSearch(""); setView({ kind: "folder", id: f.id }); }}>Open</button>
                  <button role="menuitem" onClick={() => { setMenu(null); startRename(f); }}>Rename…</button>
                  <hr />
                  <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); handleDeleteFolder(f); }}>Delete folder</button>
                </>
              );
            })()
          )}
        </div>
      )}

      <VersionHistoryDialog open={historyFor !== null} projectId={historyFor ?? ""} onClose={() => setHistoryFor(null)} />
      {confirmDialog}
      <DriveSetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />

      {moving && (
        <div className="modal-backdrop" onClick={() => setMoving(null)}>
          <div className="save-dialog" role="dialog" aria-label="Move to folder" onClick={(e) => e.stopPropagation()}>
            <h2>{moving.length > 1 ? `Move ${moving.length} designs` : `Move "${moving[0]?.name}"`}</h2>
            <div className="move-list">
              <label className={`move-row${moveTarget === null ? " on" : ""}`}>
                <input type="radio" name="move-to" checked={moveTarget === null} onChange={() => setMoveTarget(null)} />
                <span>All designs (no folder)</span>
              </label>
              {folderTree(folders).map(({ folder, depth }) => (
                <label key={folder.id} className={`move-row${moveTarget === folder.id ? " on" : ""}`} style={{ paddingLeft: 10 + depth * 16 }}>
                  <input type="radio" name="move-to" checked={moveTarget === folder.id} onChange={() => setMoveTarget(folder.id)} />
                  <span>{folder.name}</span>
                </label>
              ))}
            </div>
            {folders.length === 0 && <p className="home-side-note" style={{ padding: 0 }}>No folders yet. Use New folder first.</p>}
            <div className="save-buttons">
              <button className="modal-btn" onClick={() => setMoving(null)}>Cancel</button>
              <button className="modal-btn primary" onClick={submitMove}>Move</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
