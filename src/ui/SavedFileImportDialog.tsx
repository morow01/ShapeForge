import { useEffect, useState } from 'react';
import { ATTACHMENTS_CHANGED, listAttachments } from '../document/attachments';
import type { Attachment } from '../document/attachments';
import type { FolderMeta } from '../document/types';
import { canImportSavedFile } from '../import/savedFiles';
import './SavedFileImportDialog.css';

export function SavedFileImportDialog({ open, initialId, projectName, folders, onClose, onImport }: {
  open: boolean; initialId: string | null; projectName: string; folders: FolderMeta[];
  onClose: () => void; onImport: (file: Attachment) => Promise<void>;
}) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState('all');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSelected(initialId); setSearch(''); setFolder('all'); setError(''); setLoading(true);
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
  const visible = files.filter(f => f.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    && (folder === 'all' || (folder === 'root' ? !f.folderId || !folders.some(x => x.id === f.folderId) : f.folderId === folder)));
  const chosen = visible.find(f => f.id === selected);
  return <div className="modal-backdrop" style={{ zIndex: 2600 }} onClick={() => { if (!busy) onClose(); }}>
    <form className="save-dialog saved-import-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-import-title" onClick={e => e.stopPropagation()} onSubmit={e => {
      e.preventDefault(); if (!chosen || busy) return;
      setBusy(true); setError('');
      void onImport(chosen).catch(e => setError(e instanceof Error ? e.message : 'Could not import this file.')).finally(() => setBusy(false));
    }}>
      <h2 id="saved-import-title">Import from saved files</h2>
      <p>Add a model to <strong>{projectName}</strong>. The saved original stays in its folder.</p>
      <div className="saved-import-filters">
        <input type="search" aria-label="Search saved models" placeholder="Search STL, 3MF or SVG files" autoFocus value={search} disabled={busy} onChange={e => setSearch(e.target.value)} />
        <select aria-label="Saved file folder" value={folder} disabled={busy} onChange={e => setFolder(e.target.value)}>
          <option value="all">All folders</option><option value="root">Top level</option>
          {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      <div className="saved-import-files" role="radiogroup" aria-label="Saved models">
        {visible.map(file => <label key={file.id} className={`saved-import-row${selected === file.id ? ' selected' : ''}`}>
          <input type="radio" name="saved-model" value={file.id} checked={selected === file.id} disabled={busy} onChange={() => setSelected(file.id)} />
          <span><strong>{file.name}</strong><small>{file.folderId ? folders.find(f => f.id === file.folderId)?.name ?? 'Top level' : 'Top level'} · {(file.size/(1024*1024)).toFixed(1)} MB · {file.driveId ? 'Google Drive' : 'On this computer'}</small></span>
        </label>)}
        {!visible.length && <p>{loading ? 'Loading files…' : files.length ? 'No models match these filters.' : 'No saved STL, 3MF or SVG files yet. Use Add files in a folder to store one.'}</p>}
      </div>
      {error && <p className="saved-import-error" role="alert">{error}</p>}
      {busy && <p role="status">Preparing {chosen?.name}…</p>}
      <div className="save-buttons"><button type="button" className="modal-btn" disabled={busy} onClick={onClose}>Cancel</button><button className="modal-btn primary" disabled={!chosen || busy || loading}>{busy ? 'Importing…' : 'Import into project'}</button></div>
    </form>
  </div>;
}
