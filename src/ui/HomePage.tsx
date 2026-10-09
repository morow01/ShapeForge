import { useEffect, useRef, useState } from "react";
import { useDoc } from "../document/store";
import { binCount as countBin, collectFolderTree, exportProjectFile, hasProjectContents, loadProject, loadThumbnail, locationOf } from "../document/persist";
import { BinView } from "./BinView";
import { VersionHistoryDialog } from "./VersionHistoryDialog";
import { EditDialog } from "./EditDialog";
import { ListIcon, BinIcon, ClockIcon, CloudIcon, CopyIcon, DownloadIcon, DraftIcon, EyeIcon, FolderIcon, GridIcon, HistoryIcon, MonitorIcon, MoveFolderIcon, OpenIcon, PencilIcon, StarIcon, TagIcon } from "./NavIcons";
import { collectFolderTree as folderSubtree } from "../document/persist";
import { addToTagRegistry, cleanTag, loadTagRegistry, removeFromTagRegistry, sameTag, uniqueTags } from "../document/tags";
import { TagManager } from "./TagManager";
import type { FolderMeta, ProjectMeta } from "../document/types";
import { APP_NAME, APP_VERSION } from "../version";
import { useConfirm } from "./ConfirmDialog";
import { DriveSetupDialog } from "./DriveSetupDialog";
import { connectDrive } from "../drive/actions";
import { lastSignOut, signOut, wasConnected } from "../drive/auth";
import { fetchProject, runSync, syncNow } from "../drive/sync";
import { useDrive } from "../drive/state";
import { FolderOpenIcon, PlusIcon } from "./icons";

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
type View = { kind: "folder"; id: string | null } | { kind: "recent" } | { kind: "draft" } | { kind: "browser" } | { kind: "drive" } | { kind: "bin" } | { kind: "starred" } | { kind: "tags"; tags: string[] };

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
/** `last` is whether it is the final child of its parent; `more[k]` is whether the ancestor at depth k has
 *  siblings still to come, which decides if a vertical connector line runs down past this row. */
function folderTree(folders: FolderMeta[]): { folder: FolderMeta; depth: number; last: boolean; more: boolean[] }[] {
  const out: { folder: FolderMeta; depth: number; last: boolean; more: boolean[] }[] = [];
  const walk = (parentId: string | null, depth: number, more: boolean[]) => {
    const kids = folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
    kids.forEach((f, i) => {
      const last = i === kids.length - 1;
      out.push({ folder: f, depth, last, more });
      walk(f.id, depth + 1, [...more, !last]);
    });
  };
  walk(null, 0, []);
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
  target: { kind: "design"; project: ProjectMeta } | { kind: "folder"; folder: FolderMeta } | { kind: "tag"; tag: string };
} | null;

/** A design being dragged to a folder: follows the pointer until it is let go. */
type DragState = { ids: string[]; name: string; thumb: string | null; x: number; y: number; /** Set when a tag, not designs, is being dragged. */ tag?: string; /** Set when a folder is being dragged. */ folderId?: string } | null;

const DRAG_START_DISTANCE = 6;

type SortKey = "updated" | "name" | "created";
type SortState = { key: SortKey; dir: "asc" | "desc" };
const SORT_KEY = "cad.homeSort";
const VIEW_MODE_KEY = "cad.homeViewMode";
type ViewMode = "grid" | "list";
function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}
const SORT_LABELS: Record<SortKey, string> = { updated: "Last changed", name: "Name", created: "Date created" };
/** Names read A to Z, dates newest first, until the person flips them. */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = { updated: "desc", name: "asc", created: "desc" };

function readSort(): SortState {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as SortState | null;
    if (saved && saved.key in SORT_LABELS && (saved.dir === "asc" || saved.dir === "desc")) return saved;
  } catch {
    /* fall back to the default */
  }
  return { key: "updated", dir: "desc" };
}

function sortDesigns(list: ProjectMeta[], sort: SortState): ProjectMeta[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const diff =
      sort.key === "name"
        ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        : sort.key === "created"
          ? (a.createdAt ?? 0) - (b.createdAt ?? 0)
          : (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
    // Designs that tie keep a steady order, newest changes first.
    return diff !== 0 ? diff * sign : (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

const SIDE_WIDTH_KEY = "cad.homeSideWidth";
const DEFAULT_SIDE_WIDTH = 240;
const clampSideWidth = (w: number) => Math.max(190, Math.min(460, Math.round(w)));
function readSideWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    return saved ? clampSideWidth(saved) : DEFAULT_SIDE_WIDTH;
  } catch {
    return DEFAULT_SIDE_WIDTH;
  }
}

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
  const pressRef = useRef<{ ids: string[]; name: string; thumb: string | null; x: number; y: number; tag?: string; folderId?: string } | null>(null);
  const moveFolder = useDoc((s) => s.moveFolder);
  const [movingFolder, setMovingFolder] = useState<FolderMeta | null>(null);
  const [folderMoveTarget, setFolderMoveTarget] = useState<string | null>(null);
  const selectedIdsRef = useRef<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [tagging, setTagging] = useState<ProjectMeta[] | null>(null);
  const [, setTagTick] = useState(0);
  // The full list of tags, floating over a design while the pointer is on it (nothing moves around it).
  const [peek, setPeek] = useState<{ id: string; left: number; top: number; width: number } | null>(null);
  useEffect(() => {
    if (!peek) return;
    const close = () => setPeek(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [peek]);
  // Designs whose full list of tags is showing (the rest show the first three and a "+N").
  const [tagsOpen, setTagsOpen] = useState<Set<string>>(new Set());
  const toggleTagsOpen = (id: string) =>
    setTagsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [managingTags, setManagingTags] = useState(false);
  const [tagsCollapsed, setTagsCollapsed] = useState(() => {
    try {
      return localStorage.getItem("cad.tagsCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleTagsCollapsed = () =>
    setTagsCollapsed((v) => {
      try {
        localStorage.setItem("cad.tagsCollapsed", v ? "0" : "1");
      } catch {
        /* the choice is simply not remembered */
      }
      return !v;
    });
  const [sideWidth, setSideWidth] = useState(readSideWidth);
  const [sort, setSortState] = useState<SortState>(readSort);
  const [viewMode, setViewModeState] = useState<ViewMode>(readViewMode);
  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* the choice is simply not remembered */
    }
  };
  const setSort = (next: SortState) => {
    setSortState(next);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      /* the choice is simply not remembered */
    }
  };
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSideWidth(clampSideWidth(ev.clientX));
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.releasePointerCapture(ev.pointerId);
      try {
        localStorage.setItem(SIDE_WIDTH_KEY, String(clampSideWidth(ev.clientX)));
      } catch {
        /* the width simply is not remembered */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  const resetSideWidth = () => {
    setSideWidth(DEFAULT_SIDE_WIDTH);
    try {
      localStorage.removeItem(SIDE_WIDTH_KEY);
    } catch {
      /* nothing stored to clear */
    }
  };
  const toggleStar = useDoc((s) => s.toggleStar);
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
    const dropAt = (x: number, y: number, tagDrag: boolean): string | null | "none" => {
      if (tagDrag) {
        const card = document.elementFromPoint(x, y)?.closest("[data-drop-design]") as HTMLElement | null;
        return card?.dataset.dropDesign ? `design:${card.dataset.dropDesign}` : "none";
      }
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
      setDrag({ ids: press.ids, name: press.name, thumb: press.thumb, x: e.clientX, y: e.clientY, tag: press.tag, folderId: press.folderId });
      setDropTarget(dropAt(e.clientX, e.clientY, !!press.tag));
    };
    const onUp = (e: PointerEvent) => {
      const press = pressRef.current;
      pressRef.current = null;
      if (!press || !dragRef.current) return;
      const target = dropAt(e.clientX, e.clientY, !!press.tag);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 80);
      setDrag(null);
      setDropTarget("none");
      if (press.folderId) {
        // A folder dropped on another folder (or on All designs) moves inside it.
        if (e.type === "pointerup" && target !== "none" && !(typeof target === "string" && target.startsWith("design:"))) {
          if (!useDoc.getState().moveFolder(press.folderId, target)) showToast("A folder can't go inside itself or one of its own folders.");
        }
        return;
      }
      if (press.tag) {
        // A tag dropped on a design gives it that tag; on one of several picked designs, gives it to all of them.
        if (e.type === "pointerup" && typeof target === "string" && target.startsWith("design:")) {
          const id = target.slice("design:".length);
          const picked = selectedIdsRef.current;
          const ids = picked.length > 1 && picked.includes(id) ? picked : [id];
          const ok = useDoc.getState().editTags(ids, [press.tag], []);
          const names = useDoc.getState().projects.filter((p) => ids.includes(p.id)).map((p) => p.name);
          showToast(
            ok
              ? `Added "${press.tag}" to ${ids.length > 1 ? `${ids.length} designs` : `"${names[0] ?? "the design"}"`}`
              : `Couldn't add "${press.tag}": tags are kept short so they fit in Google Drive, and that design has too many.`,
          );
        }
        return;
      }
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
  const starredList = projects.filter((p) => p.starred);
  // Tags in use plus the ones kept for later, so an unused tag is still there to pick.
  const allTags = uniqueTags([...loadTagRegistry(), ...projects.flatMap((p) => p.tags ?? [])]).sort((a, b) => a.localeCompare(b));
  const tagCount = (tag: string) => projects.filter((p) => (p.tags ?? []).some((t) => sameTag(t, tag))).length;
  const empties = projects.filter((p) => p.objectCount === 0 && !p.remote && p.id !== currentProjectId);

  let designs: ProjectMeta[];
  let subfolders: FolderMeta[] = [];
  if (searching) {
    designs = projects.filter((p) => p.name.toLowerCase().includes(needle) || (p.tags ?? []).some((t) => t.toLowerCase().includes(needle)));
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
  } else if (view.kind === "starred") {
    designs = starredList;
  } else if (view.kind === "tags") {
    designs = projects.filter((p) => (p.tags ?? []).some((t) => view.tags.some((v) => sameTag(v, t))));
  } else {
    designs = viewFolderId === null ? projects : projects.filter((p) => p.folderId === viewFolderId);
    subfolders = folders.filter((f) => f.parentId === viewFolderId).sort((a, b) => a.name.localeCompare(b.name));
  }

  if (view.kind !== "recent" || searching) designs = sortDesigns(designs, sort);

  // Only designs that are on screen count as selected, so a bulk action can never touch
  // something in a folder you have since left.
  const selectedDesigns = designs.filter((p) => selected.has(p.id));
  selectedIdsRef.current = selectedDesigns.map((p) => p.id);
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
              : view.kind === "starred"
                ? "Starred"
                : view.kind === "tags"
                  ? `${view.tags.length === 1 ? "Tag" : "Tags"}: ${view.tags.join(", ")}`
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
    if (drag?.tag) return {};
    if (drag?.folderId) {
      // Not onto itself, its own subfolders, or where it already is.
      if (folderId !== null && folderSubtree(drag.folderId).includes(folderId)) return {};
      if ((folders.find((f) => f.id === drag.folderId)?.parentId ?? null) === folderId) return {};
      return { "data-drop": folderId ?? "root" };
    }
    if (drag && drag.ids.every((id) => (projects.find((p) => p.id === id)?.folderId ?? null) === folderId)) return {};
    return { "data-drop": folderId ?? "root" };
  };

  /** Pressing a tag in the sidebar and moving makes it draggable onto designs. A plain click still ticks it. */
  const beginTagPress = (e: React.PointerEvent, tag: string) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    pressRef.current = { ids: [], name: tag, thumb: null, tag, x: e.clientX, y: e.clientY };
  };

  /** Pressing a folder in the sidebar and moving makes it draggable onto another folder. A plain click still opens it. */
  const beginFolderPress = (e: React.PointerEvent, f: FolderMeta) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    pressRef.current = { ids: [], name: f.name, thumb: null, folderId: f.id, x: e.clientX, y: e.clientY };
  };

  const startMoveFolder = (f: FolderMeta) => {
    setMovingFolder(f);
    setFolderMoveTarget(f.parentId ?? null);
  };

  const beginPress = (e: React.PointerEvent, p: ProjectMeta, thumb: string | null) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    if ((e.target as Element).closest(".home-actions, .home-check, .home-star, .home-edit, .home-tagchip, .home-tagmore, .home-row-actions, .home-row-check")) return;
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
      : view.kind === "starred"
        ? "Star a design to find it here quickly."
        : view.kind === "tags"
          ? "No designs have this tag yet. Open a design's Edit to add it."
      : view.kind === "folder" && viewFolderId
        ? "This folder is empty. Create a design here, or drag one in."
        : "No designs yet. Create one to get started.";

  /** Ticks or unticks a tag in the sidebar. With none ticked, everything shows again. */
  const toggleTagFilter = (tag: string) => {
    setSearch("");
    setView((v) => {
      const current = v.kind === "tags" ? v.tags : [];
      const next = current.some((t) => sameTag(t, tag)) ? current.filter((t) => !sameTag(t, tag)) : [...current, tag];
      return next.length ? { kind: "tags", tags: next } : { kind: "folder", id: null };
    });
  };

  const handleDeleteTag = async (tag: string) => {
    const users = projects.filter((p) => (p.tags ?? []).some((t) => sameTag(t, tag)));
    const ok = await ask({
      title: "Delete tag?",
      message: users.length
        ? `"${tag}" is taken off ${users.length} ${users.length === 1 ? "design" : "designs"}. The designs themselves are not touched.`
        : `"${tag}" is removed from your list of tags.`,
      confirmLabel: "Delete tag",
      destructive: true,
    });
    if (!ok) return;
    if (users.length) useDoc.getState().editTags(users.map((p) => p.id), [], [tag]);
    removeFromTagRegistry(tag);
    if (view.kind === "tags" && view.tags.some((t) => sameTag(t, tag))) toggleTagFilter(tag);
    setTagTick((n) => n + 1);
  };

  const peekTags = (e: React.MouseEvent<HTMLElement>, p: ProjectMeta, anchorSelector: string) => {
    if ((p.tags ?? []).length <= 3 || tagsOpen.has(p.id)) return;
    const anchor = e.currentTarget.querySelector(anchorSelector) as HTMLElement | null;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setPeek({ id: p.id, left: r.left, top: r.top, width: r.width });
  };

  const tagPeek = (p: ProjectMeta, minWidth: number) =>
    peek?.id === p.id ? (
      <div
        className="home-tagpeek"
        style={{ left: Math.max(8, peek.left - 6), top: Math.max(8, peek.top - 6), width: Math.max(peek.width + 12, minWidth) }}
      >
        {(p.tags ?? []).map((t) => (
          <button key={t} className="home-tagchip" onClick={() => { setPeek(null); setSearch(""); setView({ kind: "tags", tags: [t] }); }} title={`Show everything tagged ${t}`}>
            <TagIcon size={9} className="home-tagchip-icon" />{t}
          </button>
        ))}
      </div>
    ) : null;

  const addTag = (tag: string) => {
    addToTagRegistry([tag]);
    setTagTick((n) => n + 1);
  };

  /** Renames a tag on every design that has it and in the list. Returns a message if it could not be done. */
  const renameTag = (oldTag: string, raw: string): string | null => {
    const next = cleanTag(raw);
    if (!next) return "Type a name for the tag.";
    const users = projects.filter((p) => (p.tags ?? []).some((t) => sameTag(t, oldTag)));
    if (users.length && !useDoc.getState().editTags(users.map((p) => p.id), [next], [oldTag])) {
      return "Some designs can't hold that name. Tags are kept short so they fit in Google Drive.";
    }
    removeFromTagRegistry(oldTag);
    addToTagRegistry([next]);
    if (view.kind === "tags" && view.tags.some((t) => sameTag(t, oldTag))) {
      setView({ kind: "tags", tags: view.tags.map((t) => (sameTag(t, oldTag) ? next : t)) });
    }
    setTagTick((n) => n + 1);
    return null;
  };

  const navClass = (active: boolean, drop?: boolean) => `home-nav${active ? " on" : ""}${drop ? " drop" : ""}`;
  const atRoot = !searching && view.kind === "folder" && viewFolderId === null;

  return (
    <div className={`home-page${drag ? " is-dragging" : ""}`} role="dialog" aria-label="All designs" data-previews={thumbVersion}>
      <header className="home-top">
        <div className="home-brand">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={24} height={26} draggable={false} />
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

      <div className="home-body" style={{ gridTemplateColumns: `${sideWidth}px minmax(0, 1fr)` }}>
        <div
          className="home-resizer"
          style={{ left: sideWidth - 3 }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the sidebar"
          title="Drag to resize. Double-click to reset."
          onPointerDown={startResize}
          onDoubleClick={resetSideWidth}
        />
        <nav className="home-side" aria-label="Locations">
          <button className={navClass(!searching && view.kind === "recent")} onClick={() => { setSearch(""); setView({ kind: "recent" }); }}>
            <span className="home-nav-main"><ClockIcon className="home-nav-icon" /><span className="home-nav-name">Recent</span></span>
          </button>
          <button className={navClass(!searching && view.kind === "starred")} onClick={() => { setSearch(""); setView({ kind: "starred" }); }}>
            <span className="home-nav-main"><StarIcon className="home-nav-icon star" /><span className="home-nav-name">Starred</span></span>
            <span className="home-count">{starredList.length}</span>
          </button>

          <div className="home-side-head">
            <span>Folders</span>
            <button className="home-side-add" onClick={() => startNewFolder(null)} title="New folder" aria-label="New folder">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M7 1.5v11M1.5 7h11" />
              </svg>
            </button>
          </div>
          <button
            className={navClass(atRoot, dropTarget === null)}
            onClick={() => { setSearch(""); setView({ kind: "folder", id: null }); }}
            {...dropProps(null)}
          >
            <span className="home-nav-main"><GridIcon className="home-nav-icon" /><span className="home-nav-name">All designs</span></span>
            <span className="home-count">{projects.length}</span>
          </button>
          {folders.length === 0 && <p className="home-side-empty home-side-empty-tree">No folders yet</p>}
          {folderTree(folders).map(({ folder, depth, last, more }) => (
            <button
              key={folder.id}
              className={navClass(!searching && view.kind === "folder" && viewFolderId === folder.id, dropTarget === folder.id)}
              onPointerDown={(e) => beginFolderPress(e, folder)}
              onContextMenu={(e) => openMenu(e, { kind: "folder", folder })}
              onClick={() => { if (suppressClickRef.current) return; setSearch(""); setView({ kind: "folder", id: folder.id }); }}
              {...dropProps(folder.id)}
            >
              <span className="home-nav-main">
                <span className="tree-cells" aria-hidden="true">
                  {Array.from({ length: depth + 1 }, (_, i) => {
                    const k = i + 1;
                    // Slot k carries the line of the ancestor at that level; the last slot joins this folder.
                    const cell = k < depth + 1 ? (more[k - 1] ? "line" : "blank") : last ? "elbow" : "tee";
                    return <span key={k} className={`tree-cell ${cell}`} />;
                  })}
                </span>
                <FolderIcon className="home-nav-icon" /><span className="home-nav-name">{folder.name}</span>
              </span>
              <span className="home-count">{countIn(folder.id)}</span>
            </button>
          ))}

          <div className="home-side-head tags-head">
            <button
              className="home-side-toggle"
              aria-expanded={!tagsCollapsed}
              onClick={toggleTagsCollapsed}
              title={tagsCollapsed ? "Show tags" : "Hide tags"}
            >
              <svg className={`home-chevron${tagsCollapsed ? " closed" : ""}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 3.5 5 6.5 8 3.5" />
              </svg>
              <span>Tags</span>
              {tagsCollapsed && view.kind === "tags" && <span className="home-side-badge">{view.tags.length}</span>}
            </button>
            <button className="home-side-add subtle" onClick={() => setManagingTags(true)} title="Manage tags" aria-label="Manage tags">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
              </svg>
            </button>
          </div>
          <div className={`tags-body${tagsCollapsed ? " closed" : ""}`} aria-hidden={tagsCollapsed}>
          <div className="tags-body-inner">
          {allTags.length === 0 && <p className="home-side-empty">No tags yet. Use Manage tags to add some.</p>}
          {allTags.map((tag) => {
            const checked = !searching && view.kind === "tags" && view.tags.some((t) => sameTag(t, tag));
            const count = tagCount(tag);
            return (
              <button
                key={tag}
                role="checkbox"
                aria-checked={checked}
                className={`${navClass(checked)}${count === 0 ? " unused" : ""}`}
                onPointerDown={(e) => beginTagPress(e, tag)}
                onClick={() => { if (!suppressClickRef.current) toggleTagFilter(tag); }}
                onContextMenu={(e) => openMenu(e, { kind: "tag", tag })}
                title={checked ? "Click to untick" : count === 0 ? "No designs use this tag yet" : "Click to show designs with this tag"}
              >
                <span className="home-nav-main">
                  <span className={`tag-check${checked ? " on" : ""}`} aria-hidden="true">{checked ? "✓" : ""}</span>
                  <TagIcon size={13} className="home-nav-icon tag" />
                  <span className="home-nav-name">{tag}</span>
                </span>
                <span className="home-count">{count}</span>
              </button>
            );
          })}

          </div>
          </div>

          <div className="home-side-label">Stored in</div>
          {(drafts.length > 0 || view.kind === "draft") && (
            <button className={navClass(!searching && view.kind === "draft")} onClick={() => { setSearch(""); setView({ kind: "draft" }); }}>
              <span className="home-nav-main"><DraftIcon className="home-nav-icon" /><span className="home-nav-name">Not saved yet</span></span>
              <span className="home-count">{drafts.length}</span>
            </button>
          )}
          {(kept.length > 0 || driveStatus !== "signedIn" || view.kind === "browser") && (
            <button className={navClass(!searching && view.kind === "browser")} onClick={() => { setSearch(""); setView({ kind: "browser" }); }}>
              <span className="home-nav-main"><MonitorIcon className="home-nav-icon" /><span className="home-nav-name">This browser</span></span>
              <span className="home-count">{kept.length}</span>
            </button>
          )}
          {driveStatus === "signedIn" ? (
            <>
              <button className={navClass(!searching && view.kind === "drive")} onClick={() => { setSearch(""); setView({ kind: "drive" }); }}>
                <span className="home-nav-main"><CloudIcon className="home-nav-icon" /><span className="home-nav-name">Google Drive</span></span>
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
              <span className="home-nav-main"><CloudIcon className="home-nav-icon" /><span className="home-nav-name">Set up Google Drive</span></span>
            </button>
          ) : (
            <div className="home-drive-box">
              <button className="modal-btn primary home-drive-connect" disabled={driveStatus === "connecting"} onClick={() => void connectDrive()}>
                {driveStatus === "connecting" ? "Connecting…" : wasConnected() ? "Reconnect Google Drive" : "Connect Google Drive"}
              </button>
              {driveError && <span className="home-drive-error">{driveError}</span>}
              {(() => {
                const out = lastSignOut();
                return out ? (
                  <span className="home-drive-why" title={out.reason}>
                    Signed out at {new Date(out.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: {out.reason}
                  </span>
                ) : null;
              })()}
              <button className="home-link" onClick={() => setSetupOpen(true)}>Change client ID</button>
            </div>
          )}

          <div className="home-side-spacer" />
          <button className={navClass(!searching && view.kind === "bin")} onClick={() => { setSearch(""); setView({ kind: "bin" }); }}>
            <span className="home-nav-main"><BinIcon className="home-nav-icon" /><span className="home-nav-name">Bin</span></span>
            {binCount > 0 && <span className="home-count">{binCount}</span>}
          </button>
          {empties.length > 0 && (
            <button className="home-clean" onClick={handleClean} title="Removes designs that have no shapes in them">
              Clear {empties.length} empty {empties.length === 1 ? "design" : "designs"}
            </button>
          )}
          {(kept.length > 0 || driveStatus !== "signedIn") && (
            <p className="home-side-note">
              Designs kept in this browser live only on this computer. Download a backup file to keep a copy elsewhere.
            </p>
          )}
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
                  <button
                    className="home-folder-more"
                    aria-label={`More actions for ${f.name}`}
                    aria-haspopup="menu"
                    title="More"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenu({ x: Math.max(8, r.right - 200), y: r.bottom + 4, target: { kind: "folder", folder: f } });
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" /></svg>
                  </button>
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
              <button className="modal-btn" onClick={() => toggleStar(selectedDesigns.map((d) => d.id))}>
                {selectedDesigns.every((d) => d.starred) ? "Remove star" : "Star"}
              </button>
              <button className="modal-btn" onClick={() => setTagging(selectedDesigns)}>Tags…</button>
              <button className="modal-btn home-danger" onClick={() => handleDeleteMany(selectedDesigns)}>Delete</button>
              {selectedDesigns.length < designs.length && (
                <button className="modal-btn" onClick={() => setSelected(new Set(designs.map((d) => d.id)))}>Select all {designs.length}</button>
              )}
              <button className="modal-btn" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}

          {designs.length > 0 && (
            <div className="home-sortbar">
              {designs.length > 1 && (view.kind !== "recent" || searching) && (
              <>
              <label htmlFor="home-sort">Sort by</label>
              <select
                id="home-sort"
                className="home-sort-select"
                value={sort.key}
                onChange={(e) => {
                  const key = e.target.value as SortKey;
                  setSort({ key, dir: DEFAULT_DIR[key] });
                }}
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                  <option key={k} value={k}>{SORT_LABELS[k]}</option>
                ))}
              </select>
              <button
                className="home-sort-dir"
                onClick={() => setSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
                title={sort.dir === "asc" ? "Ascending. Click to reverse." : "Descending. Click to reverse."}
                aria-label={sort.dir === "asc" ? "Sorted ascending, click to reverse" : "Sorted descending, click to reverse"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: sort.dir === "asc" ? "rotate(180deg)" : undefined }}>
                  <path d="M12 5v14M6 13l6 6 6-6" />
                </svg>
              </button>
              </>
              )}
              <div className="home-viewtoggle" role="group" aria-label="Layout">
                <button className={viewMode === "grid" ? "on" : ""} aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")} title="Thumbnails" aria-label="Show thumbnails">
                  <GridIcon size={15} />
                </button>
                <button className={viewMode === "list" ? "on" : ""} aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")} title="List" aria-label="Show as a list">
                  <ListIcon size={15} />
                </button>
              </div>
            </div>
          )}

          {designs.length > 0 && viewMode === "list" && (
            <div className="home-list" role="table" aria-label="Designs">
              <div className="home-row home-row-head" role="row">
                <span />
                <span />
                <button className={`home-col${sort.key === "name" ? " on" : ""}`} onClick={() => setSort({ key: "name", dir: sort.key === "name" ? (sort.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR.name })}>
                  Name{sort.key === "name" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </button>
                <span className="home-col-static col-folder">Folder</span>
                <span className="home-col-static col-tags">Tags</span>
                <span className="home-col-static col-shapes">Shapes</span>
                <button className={`home-col col-changed${sort.key === "updated" ? " on" : ""}`} onClick={() => setSort({ key: "updated", dir: sort.key === "updated" ? (sort.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR.updated })}>
                  Last changed{sort.key === "updated" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </button>
                <button className={`home-col col-created${sort.key === "created" ? " on" : ""}`} onClick={() => setSort({ key: "created", dir: sort.key === "created" ? (sort.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR.created })}>
                  Created{sort.key === "created" ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </button>
                <span />
              </div>
              {designs.map((p) => {
                const where = locationOf(p);
                const thumb = loadThumbnail(p.id);
                const folderName = p.folderId ? folders.find((f) => f.id === p.folderId)?.name : null;
                return (
                  <div
                    key={p.id}
                    role="row"
                    className={`home-row${p.id === currentProjectId ? " current" : ""}${drag?.ids.includes(p.id) ? " lifted" : ""}${selected.has(p.id) ? " selected" : ""}${dropTarget === `design:${p.id}` ? " tag-drop" : ""}`}
                    {...(drag?.tag && !(p.tags ?? []).some((t) => sameTag(t, drag.tag!)) ? { "data-drop-design": p.id } : {})}
                    onPointerDown={(e) => beginPress(e, p, thumb)}
                    onContextMenu={(e) => openMenu(e, { kind: "design", project: p })}
                    onDoubleClick={(e) => { if (!(e.target as Element).closest("button")) handleOpen(p); }}
                    onMouseEnter={(e) => peekTags(e, p, ".home-row-tags")}
                    onMouseLeave={() => setPeek((cur) => (cur?.id === p.id ? null : cur))}
                  >
                    {tagPeek(p, 260)}
                    <button
                      className={`home-check home-row-check${selected.has(p.id) ? " on" : ""}`}
                      role="checkbox"
                      aria-checked={selected.has(p.id)}
                      aria-label={`Select ${p.name}`}
                      onClick={() => toggleSelected(p.id)}
                    >
                      {selected.has(p.id) ? "✓" : ""}
                    </button>
                    <button className="home-row-thumb" onClick={(e) => (e.ctrlKey || e.metaKey ? toggleSelected(p.id) : handleOpen(p))} title={`Open ${p.name}`}>
                      {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="home-row-thumb-empty" />}
                    </button>
                    <button className="home-row-name" onClick={() => handleOpen(p)} title={p.name}>
                      <span>{p.name}</span>
                      {where !== "drive" && <span className={`home-tag ${where} home-row-tag`}>{where === "draft" ? "Not saved yet" : "This browser"}</span>}
                    </button>
                    <span className="col-folder home-row-muted" title={folderName ?? ""}>{folderName ?? "—"}</span>
                    <span className={`col-tags home-row-tags${tagsOpen.has(p.id) ? " open" : ""}`}>
                      {(p.tags ?? []).slice(0, tagsOpen.has(p.id) ? undefined : 3).map((t) => (
                        <button key={t} className="home-tagchip" onClick={() => { setSearch(""); setView({ kind: "tags", tags: [t] }); }} title={`Show everything tagged ${t}`}>
                          <TagIcon size={9} className="home-tagchip-icon" />{t}
                        </button>
                      ))}
                      {(p.tags ?? []).length > 3 && (
                            <button
                              className="home-tagmore"
                              aria-expanded={tagsOpen.has(p.id)}
                              title={tagsOpen.has(p.id) ? "Show fewer tags" : `Also: ${(p.tags ?? []).slice(3).join(", ")}`}
                              onClick={() => toggleTagsOpen(p.id)}
                            >
                              {tagsOpen.has(p.id) ? "Show less" : `+${(p.tags ?? []).length - 3}`}
                            </button>
                          )}
                    </span>
                    <span className="col-shapes home-row-muted">{openingId === p.id ? "Downloading…" : p.remote ? "—" : p.objectCount}</span>
                    <span className="col-changed home-row-muted" title={new Date(p.updatedAt).toLocaleString()}>{timeAgo(p.updatedAt)}</span>
                    <span className="col-created home-row-muted" title={new Date(p.createdAt).toLocaleString()}>{new Date(p.createdAt).toLocaleDateString()}</span>
                    <span className="home-row-actions">
                      <button className={`home-row-btn home-row-star${p.starred ? " on" : ""}`} aria-pressed={!!p.starred} aria-label={p.starred ? `Remove the star from ${p.name}` : `Star ${p.name}`} title={p.starred ? "Remove star" : "Star"} onClick={() => toggleStar([p.id])}>
                        <StarIcon size={15} />
                      </button>
                      <button className="home-row-btn" aria-label={`Edit ${p.name}`} title="Edit name, tags and star" onClick={() => setTagging([p])}>
                        <PencilIcon size={14} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {designs.length > 0 && viewMode === "grid" && (
            <div className="home-grid">
              {designs.map((p) => {
                const where = locationOf(p);
                const thumb = loadThumbnail(p.id);
                const folderName = p.folderId ? folders.find((f) => f.id === p.folderId)?.name : null;
                return (
                  <div
                    key={p.id}
                    className={`home-card${p.id === currentProjectId ? " current" : ""}${drag?.ids.includes(p.id) ? " lifted" : ""}${selected.has(p.id) ? " selected" : ""}${dropTarget === `design:${p.id}` ? " tag-drop" : ""}`}
                    {...(drag?.tag && !(p.tags ?? []).some((t) => sameTag(t, drag.tag!)) ? { "data-drop-design": p.id } : {})}
                    onPointerDown={(e) => beginPress(e, p, thumb)}
                    onContextMenu={(e) => openMenu(e, { kind: "design", project: p })}
                    onMouseEnter={(e) => peekTags(e, p, ".home-tagrow")}
                    onMouseLeave={() => setPeek((cur) => (cur?.id === p.id ? null : cur))}
                  >
                    {tagPeek(p, 200)}
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
                      className="home-edit"
                      aria-label={`Edit ${p.name}`}
                      title="Edit name, tags and star"
                      onClick={() => setTagging([p])}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
                    </button>
                    <button
                      className={`home-star${p.starred ? " on" : ""}`}
                      aria-pressed={!!p.starred}
                      aria-label={p.starred ? `Remove the star from ${p.name}` : `Star ${p.name}`}
                      title={p.starred ? "Remove star" : "Star"}
                      onClick={() => toggleStar([p.id])}
                    >
                      <StarIcon size={17} />
                    </button>
                    <div className="home-thumbwrap">
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
                    </div>
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
                      {(p.tags ?? []).length > 0 && (
                        <span className="home-tagrow">
                          {(p.tags ?? []).slice(0, tagsOpen.has(p.id) ? undefined : 3).map((t) => (
                            <button key={t} className="home-tagchip" onClick={() => { setSearch(""); setView({ kind: "tags", tags: [t] }); }} title={`Show everything tagged ${t}`}>
                              <TagIcon size={9} className="home-tagchip-icon" />{t}
                            </button>
                          ))}
                          {(p.tags ?? []).length > 3 && (
                            <button
                              className="home-tagmore"
                              aria-expanded={tagsOpen.has(p.id)}
                              title={tagsOpen.has(p.id) ? "Show fewer tags" : `Also: ${(p.tags ?? []).slice(3).join(", ")}`}
                              onClick={() => toggleTagsOpen(p.id)}
                            >
                              {tagsOpen.has(p.id) ? "Show less" : `+${(p.tags ?? []).length - 3}`}
                            </button>
                          )}
                        </span>
                      )}
                      {/* Drive is where designs normally live, so only the exceptions are labelled. */}
                      {where !== "drive" && (
                        <span className={`home-tag ${where}`}>{where === "draft" ? "Not saved yet" : "This browser"}</span>
                      )}
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
          {drag.folderId ? (
            <div className="home-ghost tag-ghost folder-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
              <FolderIcon size={13} />
              <b>{drag.name}</b>
            </div>
          ) : drag.tag ? (
            <div className="home-ghost tag-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
              <TagIcon size={12} />
              <b>{drag.tag}</b>
            </div>
          ) : (
            <div className="home-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">
              {drag.thumb ? <img src={drag.thumb} alt="" /> : <div className="home-ghost-ph" />}
              {drag.ids.length > 1 && <span className="home-ghost-count">{drag.ids.length}</span>}
              <b>{drag.name}</b>
            </div>
          )}
          <div className="home-drag-hint" role="status">
            {drag.folderId
              ? `Drop "${drag.name}" on a folder to put it inside. Drop on All designs to make it a top-level folder.`
              : drag.tag
              ? `Drop on a design to add the tag "${drag.tag}". Picked designs all get it.`
              : folders.length
              ? `Drop ${drag.ids.length > 1 ? drag.name : `"${drag.name}"`} on a folder to move ${drag.ids.length > 1 ? "them" : "it"}. Drop on All designs to take ${drag.ids.length > 1 ? "them" : "it"} out of a folder.`
              : "Make a folder with New folder, then drag designs into it."}
          </div>
        </>
      )}

      {toast && <div className="home-toast" role="status">{toast}</div>}

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
                  {!many && <button role="menuitem" onClick={() => { setMenu(null); handleOpen(p); }}><OpenIcon className="menu-icon" />Open</button>}
                  <button role="menuitem" onClick={() => { setMenu(null); setTagging(group); }}><PencilIcon className="menu-icon" />{many ? `Edit ${group.length} designs…` : "Edit…"}</button>
                  <button role="menuitem" onClick={() => { setMenu(null); startMove(group); }}><MoveFolderIcon className="menu-icon" />{many ? `Move ${group.length} designs…` : "Move to folder…"}</button>
                  {!many && driveStatus === "signedIn" && locationOf(p) === "drive" && (
                    <button role="menuitem" onClick={() => { setMenu(null); setHistoryFor(p.id); }}><HistoryIcon className="menu-icon" />Version history…</button>
                  )}
                  {!many && <button role="menuitem" onClick={() => { setMenu(null); duplicateProject(p.id); }}><CopyIcon className="menu-icon" />Duplicate</button>}
                  {!many && <button role="menuitem" onClick={() => { setMenu(null); handleDownload(p); }}><DownloadIcon className="menu-icon" />Download backup file</button>}
                  <hr />
                  <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); handleDeleteMany(group); }}><BinIcon className="menu-icon" />{many ? `Delete ${group.length} designs` : "Delete"}</button>
                </>
              );
            })()
          ) : menu.target.kind === "tag" ? (
            (() => {
              const tag = menu.target.tag;
              return (
                <>
                  <button role="menuitem" onClick={() => { setMenu(null); toggleTagFilter(tag); }}><EyeIcon className="menu-icon" />Show or hide designs with this tag</button>
                  <hr />
                  <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); void handleDeleteTag(tag); }}><BinIcon className="menu-icon" />Delete tag…</button>
                </>
              );
            })()
          ) : (
            (() => {
              const f = menu.target.folder;
              return (
                <>
                  <button role="menuitem" onClick={() => { setMenu(null); setSearch(""); setView({ kind: "folder", id: f.id }); }}><OpenIcon className="menu-icon" />Open</button>
                  <button role="menuitem" onClick={() => { setMenu(null); startRename(f); }}><PencilIcon className="menu-icon" />Rename…</button>
                  <button role="menuitem" onClick={() => { setMenu(null); startNewFolder(f.id); }}>
                    <svg className="menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                    New subfolder…
                  </button>
                  <button role="menuitem" onClick={() => { setMenu(null); startMoveFolder(f); }}><MoveFolderIcon className="menu-icon" />Move to…</button>
                  <hr />
                  <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); handleDeleteFolder(f); }}><BinIcon className="menu-icon" />Delete folder</button>
                </>
              );
            })()
          )}
        </div>
      )}

      <EditDialog designs={tagging} known={allTags} onClose={() => setTagging(null)} />
      <TagManager
        open={managingTags}
        tags={allTags}
        count={tagCount}
        onAdd={addTag}
        onRename={renameTag}
        onDelete={(tag) => void handleDeleteTag(tag)}
        onClose={() => setManagingTags(false)}
      />
      <VersionHistoryDialog open={historyFor !== null} projectId={historyFor ?? ""} onClose={() => setHistoryFor(null)} />
      {confirmDialog}
      <DriveSetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />

      {movingFolder && (
        <div className="modal-backdrop" onClick={() => setMovingFolder(null)}>
          <div className="save-dialog" role="dialog" aria-label="Move folder" onClick={(e) => e.stopPropagation()}>
            <h2>Move "{movingFolder.name}"</h2>
            <div className="move-list">
              <label className={`move-row${folderMoveTarget === null ? " on" : ""}`}>
                <input type="radio" name="move-folder-to" checked={folderMoveTarget === null} onChange={() => setFolderMoveTarget(null)} />
                <span>All designs (top level)</span>
              </label>
              {folderTree(folders)
                .filter(({ folder }) => !folderSubtree(movingFolder.id).includes(folder.id))
                .map(({ folder, depth }) => (
                  <label key={folder.id} className={`move-row${folderMoveTarget === folder.id ? " on" : ""}`} style={{ paddingLeft: 10 + depth * 16 }}>
                    <input type="radio" name="move-folder-to" checked={folderMoveTarget === folder.id} onChange={() => setFolderMoveTarget(folder.id)} />
                    <span>{folder.name}</span>
                  </label>
                ))}
            </div>
            <div className="save-buttons">
              <button className="modal-btn" onClick={() => setMovingFolder(null)}>Cancel</button>
              <button
                className="modal-btn primary"
                onClick={() => {
                  if (!moveFolder(movingFolder.id, folderMoveTarget)) showToast("That folder is already there, or the move isn't allowed.");
                  setMovingFolder(null);
                }}
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}

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
