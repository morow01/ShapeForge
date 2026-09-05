import { useRef, useState } from "react";
import { useDoc } from "../document/store";
import { exportProjectFile, loadProject } from "../document/persist";
import type { ProjectMeta } from "../document/types";
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

type ProjectsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onProjectLoadStart?: (name: string) => void;
  onProjectLoadApplied?: () => void;
  onProjectLoadFailed?: () => void;
};

export function ProjectsModal({
  isOpen,
  onClose,
  onProjectLoadStart,
  onProjectLoadApplied,
  onProjectLoadFailed,
}: ProjectsModalProps) {
  const currentProjectId = useDoc((s) => s.currentProjectId);
  const projects = useDoc((s) => s.projects);
  const newProject = useDoc((s) => s.newProject);
  const openProject = useDoc((s) => s.openProject);
  const duplicateProject = useDoc((s) => s.duplicateProject);
  const deleteProject = useDoc((s) => s.deleteProject);
  const importProjectFile = useDoc((s) => s.importProjectFile);

  const [search, setSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase().trim()),
  );

  const handleNew = () => {
    const name = prompt("Enter project name:", "Untitled Project");
    if (name === null) return;
    newProject(name);
    onClose();
  };

  const handleOpen = (id: string) => {
    const project = projects.find((p) => p.id === id);
    onProjectLoadStart?.(project?.name ?? "project");
    openProject(id);
    onProjectLoadApplied?.();
    onClose();
  };

  const handleExport = (p: ProjectMeta) => {
    const full = loadProject(p.id);
    if (full) {
      exportProjectFile(full);
    }
  };

  const handleDelete = (p: ProjectMeta) => {
    if (confirm(`Are you sure you want to delete "${p.name}"? This cannot be undone.`)) {
      deleteProject(p.id);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) {
      onProjectLoadStart?.(file.name);
      try {
        const ok = await importProjectFile(file);
        if (ok) {
          onProjectLoadApplied?.();
          onClose();
        } else {
          onProjectLoadFailed?.();
          alert("Failed to load project file. Please ensure it is a valid ShapeForge (.shapeforge) or CAD JSON file.");
        }
      } catch {
        onProjectLoadFailed?.();
        alert("Failed to load project file. Please ensure it is a valid ShapeForge (.shapeforge) or CAD JSON file.");
      }
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="projects-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            <h2>Projects Library</h2>
            <span className="modal-subtitle">{projects.length} saved {projects.length === 1 ? "project" : "projects"}</span>
          </div>
          <button className="modal-close-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="modal-toolbar">
          <input
            type="text"
            className="project-search-input"
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="modal-actions">
            <button className="modal-btn" onClick={() => fileInputRef.current?.click()} title="Open a .shapeforge or .json file from your computer">
              <FolderOpenIcon className="modal-btn-icon" />
              <span>Open File</span>
            </button>
            <button className="modal-btn primary" onClick={handleNew} title="Create a new design">
              <PlusIcon className="modal-btn-icon" />
              <span>New Project</span>
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".shapeforge,.json"
          hidden
          onChange={handleFileChange}
        />

        <div className="projects-list">
          {filteredProjects.length === 0 ? (
            <div className="empty-projects-state">
              {search ? "No matching projects found." : "No projects saved yet."}
            </div>
          ) : (
            filteredProjects.map((p) => {
              const isCurrent = p.id === currentProjectId;
              return (
                <div key={p.id} className={`project-card ${isCurrent ? "active-card" : ""}`}>
                  <div className="project-info">
                    <div className="project-card-header">
                      <span className="project-name" title={p.name}>
                        {p.name}
                      </span>
                      {isCurrent && <span className="current-badge">Current</span>}
                    </div>
                    <span className="project-meta">
                      {p.objectCount} {p.objectCount === 1 ? "shape" : "shapes"} · Modified {timeAgo(p.updatedAt)}
                    </span>
                  </div>

                  <div className="project-card-actions">
                    {!isCurrent ? (
                      <button
                        className="card-btn primary-subtle"
                        onClick={() => handleOpen(p.id)}
                        title="Open this project"
                      >
                        Open
                      </button>
                    ) : (
                      <button className="card-btn" disabled>
                        Active
                      </button>
                    )}
                    <button
                      className="card-btn icon"
                      onClick={() => duplicateProject(p.id)}
                      title="Duplicate project"
                    >
                      <DuplicateIcon className="card-btn-icon" />
                      <span>Duplicate</span>
                    </button>
                    <button
                      className="card-btn icon"
                      onClick={() => handleExport(p)}
                      title="Export .shapeforge file"
                    >
                      <ExportIcon className="card-btn-icon" />
                      <span>Export</span>
                    </button>
                    <button
                      className="card-btn danger icon"
                      onClick={() => handleDelete(p)}
                      title="Delete project"
                    >
                      <TrashIcon className="card-btn-icon" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
