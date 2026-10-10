import { useState } from "react";
import { driveHooks, useDoc } from "../document/store";
import {
  BIN_DAYS,
  binDaysLeft,
  binFolderDesignCount,
  deleteBinFolder,
  deleteFromBin,
  listBin,
  listBinFolders,
  loadBinThumbnail,
  restoreBinFolder,
  restoreFromBin,
} from "../document/persist";
import type { BinFolderEntry } from "../document/persist";
import { TrashIcon } from "./icons";

type AskOptions = { title: string; message: string; confirmLabel?: string; cancelLabel?: string | null; destructive?: boolean };

type BinViewProps = {
  ask: (options: AskOptions) => Promise<boolean>;
};

/** Deleted designs, kept for a while so a slip can be undone. */
export function BinView({ ask }: BinViewProps) {
  const [, setTick] = useState(0);
  // Which deleted folder is open, and which folder inside it. Nothing here can be edited, only looked at.
  const [openRoot, setOpenRoot] = useState<string | null>(null);
  const [innerId, setInnerId] = useState<string | null>(null);
  // A design that went in with a folder is shown with that folder, not on its own.
  const entries = listBin().filter((e) => !e.viaFolder);
  const folderEntries = listBinFolders();
  const total = entries.length + folderEntries.length;

  const refresh = () => {
    useDoc.getState().refreshProjectsList();
    useDoc.getState().refreshFolders();
    setTick((n) => n + 1);
  };

  const restore = (id: string) => {
    if (!restoreFromBin(id)) return;
    // Back on the list, and sent to Drive again if it is connected.
    useDoc.getState().refreshProjectsList();
    driveHooks.onProjectChanged?.(id);
    setTick((n) => n + 1);
  };

  const restoreFolder = (id: string) => {
    const back = restoreBinFolder(id);
    if (!back) return;
    refresh();
    for (const designId of back) driveHooks.onProjectChanged?.(designId);
  };

  const removeFolder = async (entry: BinFolderEntry) => {
    const name = entry.folders.find((f) => f.id === entry.id)?.name ?? "This folder";
    const ok = await ask({
      title: "Delete forever?",
      message: `"${name}" and the designs in it will be gone for good. This cannot be undone.`,
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (ok) {
      deleteBinFolder(entry.id);
      refresh();
    }
  };

  const removeOne = async (id: string, name: string) => {
    const ok = await ask({
      title: "Delete forever?",
      message: `"${name}" will be gone for good. This cannot be undone.`,
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (ok) {
      deleteFromBin([id]);
      refresh();
    }
  };

  const emptyAll = async () => {
    const ok = await ask({
      title: "Empty the Bin?",
      message: `${total} ${total === 1 ? "item" : "items"} will be gone for good. This cannot be undone.`,
      confirmLabel: "Empty Bin",
      destructive: true,
    });
    if (ok) {
      deleteFromBin(listBin().map((e) => e.meta.id));
      for (const f of folderEntries) deleteBinFolder(f.id);
      refresh();
    }
  };

  const openEntry = openRoot ? folderEntries.find((e) => e.id === openRoot) : undefined;
  if (openRoot && !openEntry) {
    setOpenRoot(null);
    setInnerId(null);
  }
  if (openEntry) {
    const current = innerId ?? openEntry.id;
    const subfolders = openEntry.folders.filter((f) => f.parentId === current);
    const designs = listBin().filter((e) => e.viaFolder === openEntry.id && (e.meta.folderId ?? null) === current);
    const trail: { id: string; name: string }[] = [];
    for (let at: string | null = current; at; ) {
      const f = openEntry.folders.find((x) => x.id === at);
      if (!f) break;
      trail.unshift({ id: f.id, name: f.name });
      at = f.id === openEntry.id ? null : f.parentId;
    }
    return (
      <>
        <p className="home-bin-note">
          This folder is in the Bin, so you can look but not change anything. Restore it to work on it again.
        </p>
        <div className="home-bin-crumbs">
          <button className="home-link" onClick={() => { setOpenRoot(null); setInnerId(null); }}>Bin</button>
          {trail.map((t, i) => (
            <span key={t.id}>
              <span aria-hidden="true">› </span>
              {i === trail.length - 1 ? <strong>{t.name}</strong> : <button className="home-link" onClick={() => setInnerId(t.id === openEntry.id ? null : t.id)}>{t.name}</button>}
            </span>
          ))}
          <button className="modal-btn" onClick={() => { restoreFolder(openEntry.id); setOpenRoot(null); setInnerId(null); }}>Restore folder</button>
        </div>
        {subfolders.length + designs.length === 0 ? (
          <div className="home-empty">This folder is empty.</div>
        ) : (
          <div className="home-grid">
            {subfolders.map((f) => (
              <div key={f.id} className="home-card bin-folder">
                <div className="home-thumb home-bin-thumb" onClick={() => setInnerId(f.id)}>
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </div>
                <div className="home-cap">
                  <span className="home-name" title={f.name} onClick={() => setInnerId(f.id)}>{f.name}</span>
                  <span className="home-meta">Folder</span>
                </div>
              </div>
            ))}
            {designs.map((entry) => {
              const p = entry.meta;
              const thumb = loadBinThumbnail(p.id);
              return (
                <div key={p.id} className="home-card">
                  <div className="home-thumb home-bin-thumb" aria-hidden="true">
                    {thumb ? (
                      <img src={thumb} alt="" draggable={false} />
                    ) : (
                      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                        <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
                        <path d="M4 7.5 12 12l8-4.5M12 12v9" />
                      </svg>
                    )}
                  </div>
                  <div className="home-cap">
                    <span className="home-name" title={p.name}>{p.name}</span>
                    <span className="home-meta">Design</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <p className="home-bin-note">
        Deleted designs stay here for {BIN_DAYS} days, then are removed for good.
        {total > 0 && (
          <button className="home-link home-bin-empty" onClick={() => void emptyAll()}>Empty Bin</button>
        )}
      </p>
      {total === 0 ? (
        <div className="home-empty">The Bin is empty.</div>
      ) : (
        <div className="home-grid">
          {folderEntries.map((entry) => {
            const root = entry.folders.find((f) => f.id === entry.id);
            const count = binFolderDesignCount(entry.id);
            const left = binDaysLeft(entry);
            return (
              <div key={entry.id} className="home-card bin-folder">
                <div className="home-thumb home-bin-thumb" onClick={() => { setOpenRoot(entry.id); setInnerId(null); }} title="Open to look inside">
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </div>
                <div className="home-cap">
                  <span className="home-name" title={root?.name} onClick={() => { setOpenRoot(entry.id); setInnerId(null); }}>{root?.name ?? "Folder"}</span>
                  <span className="home-meta">
                    Folder · {count} {count === 1 ? "design" : "designs"} · {left} {left === 1 ? "day" : "days"} left
                  </span>
                  <div className="home-actions home-bin-actions">
                    <button className="modal-btn" onClick={() => restoreFolder(entry.id)}>Restore</button>
                    <button className="home-act delete" onClick={() => void removeFolder(entry)} title="Delete forever" aria-label={`Delete ${root?.name ?? "folder"} forever`}>
                      <TrashIcon className="home-act-icon" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {entries.map((entry) => {
            const p = entry.meta;
            const thumb = loadBinThumbnail(p.id);
            const left = binDaysLeft(entry);
            return (
              <div key={p.id} className="home-card">
                <div className="home-thumb home-bin-thumb" aria-hidden="true">
                  {thumb ? (
                    <img src={thumb} alt="" draggable={false} />
                  ) : (
                    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
                      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
                    </svg>
                  )}
                </div>
                <div className="home-cap">
                  <span className="home-name" title={p.name}>{p.name}</span>
                  <span className="home-meta">{left} {left === 1 ? "day" : "days"} left</span>
                  <div className="home-actions home-bin-actions">
                    <button className="modal-btn" onClick={() => restore(p.id)}>Restore</button>
                    <button className="home-act delete" onClick={() => void removeOne(p.id, p.name)} title="Delete forever" aria-label={`Delete ${p.name} forever`}>
                      <TrashIcon className="home-act-icon" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
