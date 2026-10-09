import { useRef, useState } from "react";
import { useDoc } from "../document/store";
import { exportProjectFile, loadProject, loadThumbnail, locationOf } from "../document/persist";
import type { FolderMeta, ProjectMeta } from "../document/types";
import { APP_NAME } from "../version";
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
type View = { kind: "folder"; id: string | null } | { kind: "recent" } | { kind: "draft" } | { kind: "browser" };

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

type NameDialogState = { mode: "new" | "rename"; folderId?: string; parentId: string | null } | null;

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
  const moveProjectToFolder = useDoc((s) => s.moveProjectToFolder);

  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>({ kind: "folder", id: null });
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [moving, setMoving] = useState<ProjectMeta | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | "none">("none");
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  // A folder that no longer exists falls back to the top level.
  const viewFolderId = view.kind === "folder" && view.id && folders.some((f) => f.id === view.id) ? view.id : null;
  const needle = search.toLowerCase().trim();
  const searching = needle.length > 0;

  const drafts = projects.filter((p) => locationOf(p) === "draft");
  const kept = projects.filter((p) => locationOf(p) === "browser");
  const empties = projects.filter((p) => p.objectCount === 0 && p.id !== currentProjectId);

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
  } else {
    designs = projects.filter((p) => (p.folderId ?? null) === viewFolderId);
    subfolders = folders.filter((f) => f.parentId === viewFolderId).sort((a, b) => a.name.localeCompare(b.name));
  }

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
          : null;

  const handleOpen = (p: ProjectMeta) => {
    if (p.id === currentProjectId) {
      onClose();
      return;
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

  const handleDelete = (p: ProjectMeta) => {
    if (confirm(`Delete "${p.name}"? This cannot be undone.`)) deleteProject(p.id);
  };

  const handleClean = () => {
    if (confirm(`Delete ${empties.length} empty ${empties.length === 1 ? "design" : "designs"} with no shapes in them?`)) {
      for (const p of empties) deleteProject(p.id);
    }
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
    alert("That file could not be opened. Choose a ShapeForge (.shapeforge) or CAD JSON file.");
  };

  const startNewFolder = () => {
    setNameDraft("");
    setNameDialog({ mode: "new", parentId: viewFolderId });
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
    } else if (nameDialog.folderId) {
      renameFolder(nameDialog.folderId, name);
    }
    setNameDialog(null);
  };

  const handleDeleteFolder = (f: FolderMeta) => {
    const inside = countIn(f.id) + folders.filter((x) => x.parentId === f.id).length;
    const note = inside ? ` Its ${inside} ${inside === 1 ? "item moves" : "items move"} up one level.` : "";
    if (!confirm(`Delete the folder "${f.name}"?${note}`)) return;
    deleteFolder(f.id);
    if (viewFolderId === f.id) setView({ kind: "folder", id: f.parentId });
  };

  const startMove = (p: ProjectMeta) => {
    setMoving(p);
    setMoveTarget(p.folderId ?? null);
  };

  const submitMove = () => {
    if (moving) moveProjectToFolder(moving.id, moveTarget);
    setMoving(null);
  };

  const dragProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("text/x-shapeforge-design")) return;
      e.preventDefault();
      setDropTarget(folderId);
    },
    onDragLeave: () => setDropTarget("none"),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData("text/x-shapeforge-design");
      setDropTarget("none");
      if (id) {
        e.preventDefault();
        moveProjectToFolder(id, folderId);
      }
    },
  });

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
    <div className="home-page" role="dialog" aria-label="My designs" data-previews={thumbVersion}>
      <header className="home-top">
        <div className="home-brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">{APP_NAME}</span>
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
        <button className="modal-btn" onClick={startNewFolder} title="Make a folder here">
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
            {...dragProps(null)}
          >
            <span>My designs</span>
            <span className="home-count">{projects.filter((p) => !p.folderId).length}</span>
          </button>
          <button className={navClass(!searching && view.kind === "recent")} onClick={() => { setSearch(""); setView({ kind: "recent" }); }}>
            <span>Recent</span>
          </button>

          {folders.length > 0 && <div className="home-side-label">Folders</div>}
          {folderTree(folders).map(({ folder, depth }) => (
            <button
              key={folder.id}
              className={navClass(!searching && view.kind === "folder" && viewFolderId === folder.id, dropTarget === folder.id)}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => { setSearch(""); setView({ kind: "folder", id: folder.id }); }}
              {...dragProps(folder.id)}
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
          <button className="home-nav disabled" disabled title="Saving to your own Google Drive is coming">
            <span>Google Drive</span>
            <span className="home-soon">Soon</span>
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
              <button className="home-crumb" onClick={() => setView({ kind: "folder", id: null })} {...dragProps(null)}>
                My designs
              </button>
              {trail.map((f) => (
                <span key={f.id} className="home-crumb-wrap">
                  <span className="home-crumb-sep" aria-hidden="true">›</span>
                  <button className="home-crumb" onClick={() => setView({ kind: "folder", id: f.id })} {...dragProps(f.id)}>
                    {f.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          {subfolders.length > 0 && (
            <div className="home-folders">
              {subfolders.map((f) => (
                <div key={f.id} className={`home-folder${dropTarget === f.id ? " drop" : ""}`} {...dragProps(f.id)}>
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

          {designs.length === 0 && subfolders.length === 0 && <div className="home-empty">{emptyText}</div>}

          {designs.length > 0 && (
            <div className="home-grid">
              {designs.map((p) => {
                const where = locationOf(p);
                const thumb = loadThumbnail(p.id);
                const folderName = p.folderId ? folders.find((f) => f.id === p.folderId)?.name : null;
                return (
                  <div
                    key={p.id}
                    className={`home-card${p.id === currentProjectId ? " current" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/x-shapeforge-design", p.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDropTarget("none")}
                  >
                    <button className="home-thumb" onClick={() => handleOpen(p)} title={`Open ${p.name}`}>
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
                        {p.objectCount} {p.objectCount === 1 ? "shape" : "shapes"} · {timeAgo(p.updatedAt)}
                        {p.id === currentProjectId ? " · open" : ""}
                      </span>
                      {(searching || view.kind !== "folder") && folderName && <span className="home-meta">In {folderName}</span>}
                      <span className={`home-tag ${where}`}>{where === "draft" ? "Not saved yet" : "This browser"}</span>
                      <div className="home-actions">
                        <button className="home-act" onClick={() => duplicateProject(p.id)} title="Duplicate" aria-label={`Duplicate ${p.name}`}>
                          <DuplicateIcon className="home-act-icon" />
                        </button>
                        <button className="home-act" onClick={() => startMove(p)} title="Move to folder" aria-label={`Move ${p.name} to a folder`}>
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
          <div className="save-dialog" role="dialog" aria-label={nameDialog.mode === "new" ? "New folder" : "Rename folder"} onClick={(e) => e.stopPropagation()}>
            <h2>{nameDialog.mode === "new" ? "New folder" : "Rename folder"}</h2>
            <input
              className="save-name"
              value={nameDraft}
              placeholder="Folder name"
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

      {moving && (
        <div className="modal-backdrop" onClick={() => setMoving(null)}>
          <div className="save-dialog" role="dialog" aria-label="Move to folder" onClick={(e) => e.stopPropagation()}>
            <h2>Move "{moving.name}"</h2>
            <div className="move-list">
              <label className={`move-row${moveTarget === null ? " on" : ""}`}>
                <input type="radio" name="move-to" checked={moveTarget === null} onChange={() => setMoveTarget(null)} />
                <span>My designs (top level)</span>
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
