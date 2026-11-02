import { canImportSavedFile } from '../import/savedFiles';
import { ImportIcon } from './icons';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { addAttachment, attachmentBytes, cacheAttachmentBytes, ATTACHMENTS_CHANGED, editAttachment, listAttachments } from '../document/attachments';
import type { Attachment } from '../document/attachments';
import type { FolderMeta } from '../document/types';
import { driveApi, syncNow } from '../drive/sync';
import { useDrive } from '../drive/state';
import { useConfirm } from './ConfirmDialog';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { HomeContextMenu } from './HomeContextMenu';
import { BinIcon, DownloadIcon, GridIcon, ListIcon, MoveFolderIcon, PencilIcon } from './NavIcons';
import './FolderFiles.css';

export type FileDragStart = (event: ReactPointerEvent, files: Attachment[], onDrop: (folderId: string | null) => void) => void;
function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function folderLabel(folder: FolderMeta, folders: FolderMeta[]): string {
  const names = [folder.name], seen = new Set([folder.id]);
  let id = folder.parentId;
  while (id && !seen.has(id)) {
    seen.add(id); const parent = folders.find(f => f.id === id); if (!parent) break;
    names.unshift(parent.name); id = parent.parentId;
  }
  return names.join(' › ');
}
export function FolderFiles({ folderId, folders, search, storage, canAdd = true, onImportFile, onBeginDrag, draggedIds }: {
  folderId: string | null; folders: FolderMeta[]; search: string; storage?: 'browser' | 'drive'; canAdd?: boolean;
  onBeginDrag: FileDragStart; draggedIds: string[]; onImportFile: (id: string) => void;
}) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      // Carry over the old shared preference once; future choices are independent.
      return (localStorage.getItem('cad.fileViewMode') ?? localStorage.getItem('cad.homeViewMode')) === 'list' ? 'list' : 'grid';
    } catch { return 'grid'; }
  });
  useEffect(() => {
    try { localStorage.setItem('cad.fileViewMode', viewMode); } catch { /* layout still works */ }
  }, [viewMode]);
  const [compact, setCompact] = useState(() => localStorage.getItem('cad.filesCompact') === '1');
  const setCompactView = (value: boolean) => {
    setCompact(value);
    try { localStorage.setItem('cad.filesCompact', value ? '1' : '0'); } catch { /* view still works */ }
  };
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Attachment | null>(null);
  const [name, setName] = useState('');
  const [moving, setMoving] = useState<Attachment[] | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const status = useDrive(s => s.status);
  const { ask, dialog } = useConfirm();
  useEffect(() => {
    let alive = true;
    const refresh = () => { void listAttachments().then(rows => { if (alive) setFiles(rows); }).catch(e => { if (alive) setError(String(e)); }); };
    refresh(); window.addEventListener(ATTACHMENTS_CHANGED, refresh);
    return () => { alive = false; window.removeEventListener(ATTACHMENTS_CHANGED, refresh); };
  }, []);
  useEffect(() => { setSelected(new Set()); setMenu(null); setMoving(null); setRenaming(null); }, [folderId, search, storage]);
  useEffect(() => {
    if (draggedIds.length) setMenu(null);
  }, [draggedIds.length]);
  useEffect(() => {
    if (!moving && !renaming) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMoving(null); setRenaming(null); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [moving, renaming]);
  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await job(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the file.'); }
    finally { setBusy(false); }
  };
  const sync = () => { if (status === 'signedIn') void syncNow(); };
  const needle = search.trim().toLocaleLowerCase();
  const acrossFolders = !!needle || !!storage;
  const looseFiles = !acrossFolders && folderId === null;
  const visible = files.filter(f => !f.deleted
    && (acrossFolders || f.folderId === folderId
      || (folderId === null && !!f.folderId && !folders.some(folder => folder.id === f.folderId)))
    && (!needle || f.name.toLocaleLowerCase().includes(needle))
    && (!storage || (storage === 'drive' ? !!f.driveId : !f.driveId)))
    .sort((a,b) => a.name.localeCompare(b.name));
  const picked = visible.filter(f => selected.has(f.id));
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const groupFor = (file: Attachment) => selected.has(file.id) && picked.length > 1 ? picked : [file];
  const menuFile = menu ? visible.find(f => f.id === menu.id) : undefined;
  const menuGroup = menuFile ? groupFor(menuFile) : [];
  const moveFiles = (group: Attachment[], target: string | null) => run(async () => {
    for (const file of group) await editAttachment(file.id, { folderId: target });
    setSelected(new Set()); setMoving(null); sync();
  });
  const startMove = (group: Attachment[]) => { setMenu(null); setMoveTarget(group[0]?.folderId ?? null); setMoving(group); };
  const deleteFiles = (group: Attachment[]) => run(async () => {
    const label = group.length === 1 ? `“${group[0].name}”` : `${group.length} files`;
    if (!await ask({ title: group.length === 1 ? 'Delete file?' : 'Delete files?', message: `Delete ${label}? This removes the saved attachments, including their Drive copies if synced. Your original files on your computer are unchanged.`, confirmLabel: 'Delete', destructive: true })) return;
    for (const file of group) await editAttachment(file.id, { deleted: true });
    setSelected(new Set()); sync();
  });
  const loadBytes = async (file: Attachment): Promise<ArrayBuffer> => {
    let bytes = await attachmentBytes(file.id);
    if (!bytes && file.driveId) {
      if (status !== 'signedIn') throw new Error('Connect Google Drive to download this file.');
      bytes = await driveApi().downloadBytes(file.driveId);
      await cacheAttachmentBytes(file.id, bytes);
    }
    if (!bytes) throw new Error('The original file is not available on this computer.');
    return bytes;
  };
  const download = (file: Attachment) => run(async () => {
    const bytes = await loadBytes(file);
    const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
    const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  const beginPress = (e: ReactPointerEvent, file: Attachment) => {
    if (busy || e.button !== 0 || e.pointerType === 'touch' || (e.target as Element).closest('button,input,select,textarea,a')) return;
    e.preventDefault();
    onBeginDrag(e, groupFor(file), target => { void moveFiles(groupFor(file), target); });
  };
  return <section className={`folder-files files-${compact ? 'compact' : viewMode}`} aria-label="Files">
    <div className="folder-files-heading"><h2>{looseFiles ? 'Loose files' : 'Files'} {visible.length ? `(${visible.length})` : ''}</h2>
      <div className="folder-files-heading-actions">
        <div className="home-viewtoggle" role="group" aria-label="File layout">
          <button aria-label="Show files as thumbnails" aria-pressed={!compact && viewMode === 'grid'} className={!compact && viewMode === 'grid' ? 'on' : ''} onClick={() => { setCompactView(false); setViewMode('grid'); }} title="Thumbnails"><GridIcon size={15} /></button>
          <button aria-label="Show files as a list" aria-pressed={!compact && viewMode === 'list'} className={!compact && viewMode === 'list' ? 'on' : ''} onClick={() => { setCompactView(false); setViewMode('list'); }} title="List"><ListIcon size={15} /></button>
          <button aria-label="Show compact file panel" aria-pressed={compact} className={compact ? 'on' : ''} onClick={() => setCompactView(true)} title="Compact panel">▤</button>
        </div>
        {canAdd && <button className="modal-btn" disabled={busy} onClick={() => input.current?.click()}>Add files</button>}
      </div>
    </div>
    <p className="folder-files-note">{looseFiles ? 'Files stored inside folders stay in their folders. Search finds files everywhere.' : 'Keep templates and supporting files here without adding them to your design. Any file type is welcome.'}</p>
    <input ref={input} type="file" multiple hidden aria-label="Add files to folder" onChange={e => {
      const chosen = Array.from(e.target.files ?? []); e.target.value = '';
      if (chosen.length) void run(async () => {
        let saved = 0;
        try { for (const file of chosen) { await addAttachment(file, folderId); saved++; } }
        catch (e) { throw new Error(`${saved} of ${chosen.length} files saved. ${e instanceof Error ? e.message : 'Storage may be full.'}`); }
        finally { sync(); }
      });
    }} />
    {busy && <p role="status">Working…</p>}
    {error && <p className="folder-files-error" role="alert">{error}</p>}
    {picked.length > 0 && <div className="home-selbar" role="toolbar" aria-label="Selected files">
      <b>{picked.length} {picked.length === 1 ? 'file' : 'files'} selected</b>
      <button className="modal-btn" disabled={busy} onClick={() => startMove(picked)}>Move to folder…</button>
      <button className="modal-btn home-danger" disabled={busy} onClick={() => void deleteFiles(picked)}>Delete</button>
      {picked.length < visible.length && <button className="modal-btn" onClick={() => setSelected(new Set(visible.map(f => f.id)))}>Select all {visible.length}</button>}
      <button className="modal-btn" onClick={() => setSelected(new Set())}>Clear</button>
    </div>}
    {!visible.length && <p className="folder-files-note">{needle ? 'No files match your search.' : looseFiles ? 'No loose files. Open a folder to see the files saved inside it.' : 'No files saved in this folder yet.'}</p>}
    {!compact && viewMode === 'list' && <div className="folder-files-columns" aria-hidden="true"><span /><span /><span>Name</span><span>Size / Location</span><span>Actions</span></div>}
    <ul className={`folder-files-list ${!compact && viewMode === 'grid' ? 'home-grid' : ''}`}>{visible.map(file => <li key={file.id}
      className={`${!compact && viewMode === 'grid' ? 'home-card attachment-card' : ''}${selected.has(file.id) ? ' selected' : ''}${draggedIds.includes(file.id) ? ' lifted' : ''}`}
      onPointerDown={e => beginPress(e, file)} onDragStart={e => e.preventDefault()}
      onContextMenu={e => { e.preventDefault(); if (!busy) setMenu({ id: file.id, x: e.clientX, y: e.clientY }); }}>
      <button type="button" className={`home-check attachment-check${selected.has(file.id) ? ' on' : ''}`} role="checkbox" aria-checked={selected.has(file.id)} aria-label={`Select file ${file.name}`} disabled={busy} onClick={() => toggle(file.id)}>{selected.has(file.id) ? '✓' : ''}</button>
      <div className="attachment-visual">
      {!compact && <AttachmentThumbnail file={file} loadRemote={() => loadBytes(file)} />}
      <span className="folder-file-type" aria-hidden="true">{file.name.includes('.') ? file.name.split('.').pop()?.toUpperCase().slice(0,8) : 'FILE'}</span>
      </div>
      <div className="folder-file-info">
        <strong title={file.name}>{file.name}</strong>
        <small>{fileSize(file.size)} · {file.driveId ? file.dirty ? 'Drive update pending' : 'Google Drive' : status === 'signedIn' ? 'Waiting for Drive sync' : 'On this computer'}
          {file.folderId && ` · ${folders.find(f => f.id === file.folderId)?.name ?? 'Folder removed — kept in All designs'}`}</small>
      </div>
      <button className="home-act attachment-more" aria-label={`Actions for ${file.name}`} aria-haspopup="menu" aria-expanded={menu?.id === file.id} title="More" disabled={busy} onClick={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMenu(menu?.id === file.id ? null : { id: file.id, x: rect.right - 200, y: rect.bottom + 4 });
      }}>•••</button>
    </li>)}</ul>
    {menu && menuFile && <HomeContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      {menuGroup.length === 1 && canImportSavedFile(menuFile.name) && <button role="menuitem" onClick={() => { setMenu(null); onImportFile(menuFile.id); }}><ImportIcon className="menu-icon" />Import into project…</button>}
      {menuGroup.length === 1 && <button role="menuitem" onClick={() => { setMenu(null); setName(menuFile.name); setRenaming(menuFile); }}><PencilIcon className="menu-icon" />Rename…</button>}
      <button role="menuitem" onClick={() => startMove(menuGroup)}><MoveFolderIcon className="menu-icon" />{menuGroup.length > 1 ? `Move ${menuGroup.length} files…` : 'Move to folder…'}</button>
      {menuGroup.length === 1 && <button role="menuitem" onClick={() => { setMenu(null); void download(menuFile); }}><DownloadIcon className="menu-icon" />Download</button>}
      <hr />
      <button role="menuitem" className="danger-item" onClick={() => { setMenu(null); void deleteFiles(menuGroup); }}><BinIcon className="menu-icon" />{menuGroup.length > 1 ? `Delete ${menuGroup.length} files` : 'Delete'}</button>
    </HomeContextMenu>}
    {renaming && <div className="modal-backdrop" onClick={() => { if (!busy) setRenaming(null); }}><form className="save-dialog" role="dialog" aria-label="Rename file" onClick={e => e.stopPropagation()} onSubmit={e => {
      e.preventDefault(); if (!name.trim() || busy) return;
      void run(async () => { await editAttachment(renaming.id, { name: name.trim() }); setRenaming(null); sync(); });
    }}><h2>Rename file</h2><input autoFocus value={name} aria-label="File name" onChange={e => setName(e.target.value)} /><div className="save-buttons"><button type="button" className="modal-btn" disabled={busy} onClick={() => setRenaming(null)}>Cancel</button><button className="modal-btn primary" disabled={busy || !name.trim()}>Save</button></div></form></div>}
    {moving && <div className="modal-backdrop" onClick={() => { if (!busy) setMoving(null); }}><div className="save-dialog" role="dialog" aria-label="Move files to folder" onClick={e => e.stopPropagation()}>
      <h2>Move {moving.length === 1 ? `“${moving[0].name}”` : `${moving.length} files`}</h2>
      <div className="move-list"><label className={`move-row${moveTarget === null ? ' on' : ''}`}><input type="radio" name="move-files" checked={moveTarget === null} onChange={() => setMoveTarget(null)} /><span>All designs (top level)</span></label>
        {[...folders].sort((a,b) => folderLabel(a,folders).localeCompare(folderLabel(b,folders))).map(f => <label key={f.id} className={`move-row${moveTarget === f.id ? ' on' : ''}`}><input type="radio" name="move-files" checked={moveTarget === f.id} onChange={() => setMoveTarget(f.id)} /><span>{folderLabel(f,folders)}</span></label>)}
      </div><div className="save-buttons"><button className="modal-btn" disabled={busy} onClick={() => setMoving(null)}>Cancel</button><button className="modal-btn primary" disabled={busy || moving.every(f => f.folderId === moveTarget)} onClick={() => void moveFiles(moving, moveTarget)}>Move</button></div>
    </div></div>}
    {dialog}
  </section>;
}
