import { useEffect, useState } from "react";
import { checkSync, fixSyncRow, runSync } from "../drive/sync";
import type { SyncCheckRow } from "../drive/sync";

const LABEL: Record<SyncCheckRow["state"], string> = {
  same: "Matches Drive",
  driveNewer: "Newer on Drive",
  thisNewer: "Newer here",
  differs: "Differs",
  driveOnly: "On Drive only",
  notOnDrive: "Not on Drive",
};

/** Can the one-click fix deal with this row? */
const fixable = (r: SyncCheckRow) => (r.state === "driveNewer" && !r.open) || r.state === "thisNewer";

/**
 * Lays this computer's designs next to Drive's and says plainly which agree. It changes nothing by itself; the
 * buttons bring in a newer Drive copy or send a newer local one, one design at a time or all at once.
 */
export function SyncCheckDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<SyncCheckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const run = async () => {
    setRows(null);
    setError(null);
    try {
      const result = await runSync(checkSync);
      if (result) setRows(result);
      else setError("Not connected to Google Drive.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The check could not finish.");
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fix = async (list: SyncCheckRow[]) => {
    setWorking(true);
    try {
      await runSync(async () => {
        for (const r of list) await fixSyncRow(r);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not finish.");
    }
    setWorking(false);
    await run();
  };

  const matching = rows?.filter((r) => r.state === "same").length ?? 0;
  const others = rows?.filter((r) => r.state !== "same") ?? [];
  const fixes = others.filter(fixable);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="save-dialog sync-check" role="dialog" aria-label="Check sync" onClick={(e) => e.stopPropagation()}>
        <h2>Check sync</h2>
        {rows === null && !error && <p className="confirm-message">Comparing every design with Google Drive…</p>}
        {error && <p className="missing-files-note">{error}</p>}
        {rows && (
          <>
            <p className="confirm-message">
              <strong>{matching}</strong> of <strong>{rows.length}</strong> {rows.length === 1 ? "design matches" : "designs match"} Drive exactly.
              {others.length === 0 ? " Everything is in step." : ""}
            </p>
            {others.length > 0 && (
              <ul className="sync-check-list">
                {others.map((r) => (
                  <li key={r.id} className={r.state}>
                    <div className="sync-check-name">
                      <strong>{r.name}</strong>
                      <small>
                        <b>{LABEL[r.state]}.</b> {r.note}
                        {r.open && r.state === "driveNewer" ? " It is open now, so it refreshes by itself when it is safe." : ""}
                      </small>
                    </div>
                    {fixable(r) && (
                      <button className="modal-btn" disabled={working} onClick={() => void fix([r])}>
                        {r.state === "driveNewer" ? "Update from Drive" : "Send to Drive"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="save-buttons">
          {fixes.length > 1 && (
            <button className="modal-btn" disabled={working} onClick={() => void fix(fixes)}>
              Fix all {fixes.length}
            </button>
          )}
          <button className="modal-btn" disabled={working || (rows === null && !error)} onClick={() => void run()}>
            Check again
          </button>
          <button className="modal-btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
