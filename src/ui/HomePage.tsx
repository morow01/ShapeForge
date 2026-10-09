import { useRef, useState } from "react";
import { useDoc } from "../document/store";
import { exportProjectFile, loadProject, loadThumbnail, locationOf } from "../document/persist";
import type { ProjectMeta } from "../document/types";
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

type Filter = "all" | "draft" | "browser";

type HomePageProps = {
  open: boolean;
  /** Close Home and go to the editor, which is showing whichever design is open. */
  onClose: () => void;
  onNewDesign: () => void;
  /** Changes when a new preview picture has been saved, so the cards redraw. */
  thumbVersion?: number;
  onProjectLoadStart?: (name: string) => void;
  onProjectLoadApplied?: () => void;
  onProjectLoadFailed?: () => void;
};

/**
 * The start page: every design, newest first, with where each one is kept. It sits
 * over the editor rather than replacing it, so the editor stays loaded behind it and
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
  const openProject = useDoc((s) => s.openProject);
  const duplicateProject = useDoc((s) => s.duplicateProject);
  const deleteProject = useDoc((s) => s.deleteProject);
  const importProjectFile = useDoc((s) => s.importProjectFile);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const empties = projects.filter((p) => p.objectCount === 0 && p.id !== currentProjectId);
  const drafts = projects.filter((p) => locationOf(p) === "draft");
  const kept = projects.filter((p) => locationOf(p) === "browser");
  const needle = search.toLowerCase().trim();
  const shown = projects
    .filter((p) => filter === "all" || locationOf(p) === filter)
    .filter((p) => !needle || p.name.toLowerCase().includes(needle));

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

  const emptyText = needle
    ? "No designs match your search."
    : filter === "draft"
      ? "Nothing waiting to be saved."
      : "No designs yet. Create one to get started.";

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
        <button className="modal-btn" onClick={() => fileInputRef.current?.click()} title="Open a .shapeforge or .json file from your computer">
          <FolderOpenIcon className="modal-btn-icon" />
          <span>Open file</span>
        </button>
        <button className="modal-btn primary" onClick={onNewDesign}>
          <PlusIcon className="modal-btn-icon" />
          <span>New design</span>
        </button>
        <input ref={fileInputRef} type="file" accept=".shapeforge,.json" hidden onChange={handleFile} />
      </header>

      <div className="home-body">
        <nav className="home-side" aria-label="Locations">
          <button className={`home-nav${filter === "all" ? " on" : ""}`} onClick={() => setFilter("all")}>
            <span>All designs</span>
            <span className="home-count">{projects.length}</span>
          </button>
          <div className="home-side-label">Where they are</div>
          <button className={`home-nav${filter === "draft" ? " on" : ""}`} onClick={() => setFilter("draft")}>
            <span>Not saved yet</span>
            <span className="home-count">{drafts.length}</span>
          </button>
          <button className={`home-nav${filter === "browser" ? " on" : ""}`} onClick={() => setFilter("browser")}>
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
          <h1 className="home-title">
            {filter === "draft" ? "Not saved yet" : filter === "browser" ? "This browser" : "All designs"}
          </h1>
          {shown.length === 0 ? (
            <div className="home-empty">{emptyText}</div>
          ) : (
            <div className="home-grid">
              {shown.map((p) => {
                const where = locationOf(p);
                const thumb = loadThumbnail(p.id);
                return (
                  <div key={p.id} className={`home-card${p.id === currentProjectId ? " current" : ""}`}>
                    <button className="home-thumb" onClick={() => handleOpen(p)} title={`Open ${p.name}`}>
                      {thumb ? (
                        <img src={thumb} alt="" />
                      ) : (
                        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
                          <path d="M4 7.5 12 12l8-4.5M12 12v9" />
                        </svg>
                      )}
                      <span className={`home-tag ${where}`}>{where === "draft" ? "Not saved yet" : "This browser"}</span>
                    </button>
                    <div className="home-cap">
                      <button className="home-name" onClick={() => handleOpen(p)} title={p.name}>{p.name}</button>
                      <span className="home-meta">
                        {p.objectCount} {p.objectCount === 1 ? "shape" : "shapes"} · {timeAgo(p.updatedAt)}
                        {p.id === currentProjectId ? " · open" : ""}
                      </span>
                      <div className="home-actions">
                        <button className="home-act" onClick={() => duplicateProject(p.id)} title="Duplicate" aria-label={`Duplicate ${p.name}`}>
                          <DuplicateIcon className="home-act-icon" />
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
    </div>
  );
}
