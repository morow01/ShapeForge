import { useEffect, useState } from 'react';
import { ATTACHMENTS_CHANGED, listAttachments } from '../document/attachments';
import type { Attachment } from '../document/attachments';
import type { FolderMeta, ProjectMeta } from '../document/types';
import { canImportSavedFile } from '../import/savedFiles';
import './SavedFileImportDialog.css';

type Tab = 'computer' | 'models' | 'designs';
const TAB_KEY = 'shapeforge.importSource';
function rememberedTab(): Tab {
  try { const tab = localStorage.getItem(TAB_KEY); return tab === 'models' || tab === 'designs' ? tab : 'computer'; }
  catch { return 'computer'; }
}

export function SavedFileImportDialog({ open, initialId, projectName, currentProjectId, folders, projects, onClose, onImport, onImportDesign, onBrowse }: {
  open: boolean; initialId: string | null; projectName: string; currentProjectId: string; folders: FolderMeta[]; projects: ProjectMeta[];
  onClose: () => void; onImport: (file: Attachment) => Promise<void>; onImportDesign: (id: string) => Promise<void>;
  /** Opens the computer's own file picker (the dialog closes first). */
  onBrowse: () => void;
}) {
  const [tab, setTab] = useState<Tab>(rememberedTab);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedDesign, setSelectedDesign] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState('all');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTab(initialId ? 'models' : rememberedTab()); setSelected(initialId); setSelectedDesign(null); setSearch(''); setFolder('all'); setError(''); setLoading(true);
    const refresh = () => { void listAttachments().then(rows => {
      if (alive) setFiles(rows.filter(f => !f.deleted && canImportSavedFile(f.name)).sort((a,b) => a.name.localeCompare(b.name)));
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Could not read saved files.'); })
      .finally(() => { if (alive) setLoading(false); }); };
    refresh(); window.addEventListener(ATTACHMENTS_CHANGED, refresh);
    return () => { alive = false; window.removeEventListener(ATTACHMENTS_CHANGED, refresh); };
  }, [open, initialId]);
  useEffect(() => {
    if (!open || busy) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open, busy, onClose]);
  if (!open) return null;
  const needle = search.trim().toLocaleLowerCase();
  const inFolder = (folderId: string | null | undefined) =>
    folder === 'all' || (folder === 'root' ? !folderId || !folders.some(x => x.id === folderId) : folderId === folder);
  const visible = files.filter(f => f.name.toLocaleLowerCase().includes(needle) && inFolder(f.folderId));
  const chosen = visible.find(f => f.id === selected);
  const designs = projects
    .filter(p => p.id !== currentProjectId && p.name.toLocaleLowerCase().includes(needle) && inFolder(p.folderId))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const chosenDesign = designs.find(p => p.id === selectedDesign);
  const folderName = (id: string | null | undefined) => (id ? folders.find(f => f.id === id)?.name : undefined) ?? 'Top level';
  const onDesigns = tab === 'designs';
  const onComputer = tab === 'computer';
  const ready = !onComputer && (onDesigns ? !!chosenDesign : !!chosen && !loading);
  const switchTab = (next: Tab) => { if (!busy) {
    setTab(next); setError(''); setSearch(''); setFolder('all');
    try { localStorage.setItem(TAB_KEY, next); } catch { /* Import still works without storage. */ }
  } };
  return <div className="modal-backdrop" style={{ zIndex: 2600 }} onClick={() => { if (!busy) onClose(); }}>
    <form className="save-dialog saved-import-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-import-title" onClick={e => e.stopPropagation()} onSubmit={e => {
      e.preventDefault(); if (!ready || busy) return;
      setBusy(true); setError('');
      const run = onDesigns ? onImportDesign(chosenDesign!.id) : onImport(chosen!);
      void run.catch(e => setError(e instanceof Error ? e.message : 'Could not import this.')).finally(() => setBusy(false));
    }}>
      <h2 id="saved-import-title">Import</h2>
      <p className="saved-import-subtitle">Into <strong>{projectName}</strong></p>
      <div className="saved-import-tabs" role="tablist" aria-label="Import source">
        <button id="saved-import-tab-computer" type="button" role="tab" aria-controls="saved-import-panel" aria-selected={onComputer} disabled={busy} onClick={() => switchTab('computer')}>From computer</button>
        <button id="saved-import-tab-library" type="button" role="tab" aria-controls="saved-import-panel" aria-selected={!onComputer} disabled={busy} onClick={() => switchTab(tab === 'computer' ? 'models' : tab)}>From library</button>
      </div>
      <div id="saved-import-panel" className="saved-import-panel" role="tabpanel" aria-labelledby={`saved-import-tab-${onComputer ? 'computer' : 'library'}`}>
      {onComputer ? <>
        <div className="saved-import-computer">
          <span className="saved-import-upload" aria-hidden="true">↑</span>
          <h3>Choose a file on your computer</h3>
          <p>STL, 3MF, SVG or a ShapeForge project (.shapeforge)</p>
          <button type="button" className="modal-btn primary saved-import-browse" onClick={onBrowse}>Browse files…</button>
        </div>
        <p className="saved-import-note">Model parts will be added to your current project.</p>
      </> : <>
      <p className="saved-import-library-description">Files and projects already in your ShapeForge folders.</p>
      <div className="saved-import-kinds" role="group" aria-label="Library item type">
        <button type="button" aria-pressed={!onDesigns} disabled={busy} onClick={() => switchTab('models')}>Models</button>
        <button type="button" aria-pressed={onDesigns} disabled={busy} onClick={() => switchTab('designs')}>Projects</button>
      </div>
      <div className="saved-import-filters">
        <input type="search" aria-label={onDesigns ? 'Search library projects' : 'Search library models'} placeholder={onDesigns ? 'Search projects…' : 'Search models…'} value={search} disabled={busy} onChange={e => setSearch(e.target.value)} />
        <select aria-label="Folder" value={folder} disabled={busy} onChange={e => setFolder(e.target.value)}>
          <option value="all">All folders</option><option value="root">Top level</option>
          {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      {onDesigns ? <div className="saved-import-files" role="radiogroup" aria-label="Library projects">
        {designs.map(p => <label key={p.id} className={`saved-import-row${selectedDesign === p.id ? ' selected' : ''}`}>
          <input type="radio" name="saved-design" value={p.id} checked={selectedDesign === p.id} disabled={busy} onChange={() => setSelectedDesign(p.id)} />
          <span><strong>{p.name}</strong><small>{folderName(p.folderId)} · {p.objectCount} {p.objectCount === 1 ? 'object' : 'objects'} · {p.remote ? 'Google Drive (open it once first)' : p.driveId ? 'Google Drive' : 'On this computer'}</small></span>
        </label>)}
        {!designs.length && <p>{projects.some(p => p.id !== currentProjectId) ? 'No projects match these filters.' : 'You have no other projects in your library yet.'}</p>}
      </div> : <div className="saved-import-files" role="radiogroup" aria-label="Library models">
        {visible.map(file => <label key={file.id} className={`saved-import-row${selected === file.id ? ' selected' : ''}`}>
          <input type="radio" name="saved-model" value={file.id} checked={selected === file.id} disabled={busy} onChange={() => setSelected(file.id)} />
          <span><strong>{file.name}</strong><small>{folderName(file.folderId)} · {(file.size/(1024*1024)).toFixed(1)} MB · {file.driveId ? 'Google Drive' : 'On this computer'}</small></span>
        </label>)}
        {!visible.length && <p>{loading ? 'Loading files…' : files.length ? 'No models match these filters.' : 'No importable files in your ShapeForge folders yet.'}</p>}
      </div>}
      <p className="saved-import-note">{onDesigns ? 'Copies project objects into this project. The original stays unchanged.' : 'Adds a copy. Your original stays unchanged.'}</p>
      </>}
      </div>
      {error && <p className="saved-import-error" role="alert">{error}</p>}
      {busy && <p role="status">Preparing {onDesigns ? chosenDesign?.name : chosen?.name}…</p>}
      <div className="save-buttons saved-import-footer"><span aria-live="polite">{onComputer ? '' : (onDesigns ? chosenDesign?.name : chosen?.name) ?? (onDesigns ? 'No project selected' : 'No model selected')}</span><button type="button" className="modal-btn" disabled={busy} onClick={onClose}>Cancel</button>{!onComputer && <button className="modal-btn primary" disabled={!ready || busy}>{busy ? 'Importing…' : 'Import'}</button>}</div>
    </form>
  </div>;
}
