import { useState } from "react";
import { driveHooks, useDoc } from "../document/store";
import { BIN_DAYS, binDaysLeft, deleteFromBin, listBin, loadBinThumbnail, restoreFromBin } from "../document/persist";
import { TrashIcon } from "./icons";

type AskOptions = { title: string; message: string; confirmLabel?: string; cancelLabel?: string | null; destructive?: boolean };

type BinViewProps = {
  ask: (options: AskOptions) => Promise<boolean>;
};

/** Deleted designs, kept for a while so a slip can be undone. */
export function BinView({ ask }: BinViewProps) {
  const [, setTick] = useState(0);
  const entries = listBin();

  const refresh = () => {
    useDoc.getState().refreshProjectsList();
    setTick((n) => n + 1);
  };

  const restore = (id: string) => {
    if (!restoreFromBin(id)) return;
    // Back on the list, and sent to Drive again if it is connected.
    useDoc.getState().refreshProjectsList();
    driveHooks.onProjectChanged?.(id);
    setTick((n) => n + 1);
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
      message: `${entries.length} ${entries.length === 1 ? "design" : "designs"} will be gone for good. This cannot be undone.`,
      confirmLabel: "Empty Bin",
      destructive: true,
    });
    if (ok) {
      deleteFromBin(entries.map((e) => e.meta.id));
      refresh();
    }
  };

  return (
    <>
      <p className="home-bin-note">
        Deleted designs stay here for {BIN_DAYS} days, then are removed for good.
        {entries.length > 0 && (
          <button className="home-link home-bin-empty" onClick={() => void emptyAll()}>Empty Bin</button>
        )}
      </p>
      {entries.length === 0 ? (
        <div className="home-empty">The Bin is empty.</div>
      ) : (
        <div className="home-grid">
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
