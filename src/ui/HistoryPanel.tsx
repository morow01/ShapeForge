import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { historyTimeline, jumpToHistory, labelStep, useDoc, useTemporal } from "../document/store";
import { loadSnapshots, saveSnapshots, type DesignSnapshot } from "../document/snapshotStore";

/**
 * Photoshop's History palette over the document's own undo stack: the steps
 * taken in this design, oldest at the top, and a click puts the document back
 * to exactly that state. Steps past the one in use stay listed, greyed, until
 * the next edit from here replaces them — the same bargain Photoshop makes.
 *
 * This is a view, not a second history: everything it lists comes from the
 * one stack behind Undo/Redo, so the three can never disagree.
 *
 * Snapshots sit above the steps, as in Photoshop: a named state of the design
 * that outlives the undo stack. Going back to one is an ordinary step, so it
 * can be undone like any other.
 */
export function HistoryPanel() {
  // Two selectors rather than one object, which would be a new value on every
  // read and never settle. zundo splices its stacks in place, so each of
  // these can come back unchanged while the other does not; between them,
  // every move shows up.
  const past = useTemporal((s) => s.pastStates);
  const future = useTemporal((s) => s.futureStates);
  const currentLabel = useDoc((s) => s.historyLabel);
  const projectId = useDoc((s) => s.currentProjectId);
  const steps = useMemo(() => historyTimeline(past, future, currentLabel), [past, future, currentLabel]);

  // The list grows downwards, so the step in use has to be brought back into
  // view after an edit scrolls it off the bottom.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".history-step.current")?.scrollIntoView({ block: "nearest" });
  }, [steps]);

  const [snapshots, setSnapshots] = useState<DesignSnapshot[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  // The design whose snapshots are on screen, so a slow read for a design
  // that has since been left cannot land on the one now open, and nothing is
  // written back over a design's snapshots before they have been read.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    shownFor.current = null;
    setSnapshots([]);
    let stale = false;
    loadSnapshots(projectId)
      .then((list) => {
        if (stale) return;
        shownFor.current = projectId;
        setSnapshots(list);
      })
      .catch(() => {
        if (stale) return;
        shownFor.current = projectId;
      });
    return () => {
      stale = true;
    };
  }, [projectId]);

  const store = useCallback(
    (next: DesignSnapshot[]) => {
      setSnapshots(next);
      if (shownFor.current === projectId) void saveSnapshots(projectId, next).catch(() => {});
    },
    [projectId],
  );

  const addSnapshot = () => {
    const nodes = useDoc.getState().nodes;
    const at = Date.now();
    const label = name.trim() || `Snapshot ${snapshots.length + 1}`;
    store([{ id: `snap-${at}`, name: label, at, nodes }, ...snapshots]);
    setName("");
    setNaming(false);
  };

  const commitRename = () => {
    const text = renameText.trim();
    if (renamingId && text) store(snapshots.map((s) => (s.id === renamingId ? { ...s, name: text } : s)));
    setRenamingId(null);
  };

  const goTo = (snap: DesignSnapshot) => {
    labelStep(`Go to snapshot: ${snap.name}`);
    useDoc.getState().restoreNodes(snap.nodes, []);
  };

  const done = steps.filter((step) => !step.undone).length - 1;

  return (
    <section className="history-panel" aria-label="History">
      <div className="panel-heading compact">
        <div>
          <h1>History</h1>
          <p>{done === 0 ? "No steps yet" : `${done} step${done === 1 ? "" : "s"}`}</p>
        </div>
        <button
          type="button"
          className="history-snapshot-btn"
          title="Save the design as it is now, so you can come back to it later"
          onClick={() => setNaming((v) => !v)}
        >
          Snapshot
        </button>
      </div>
      {naming && (
        <div className="history-snapshot-new">
          <input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Name this snapshot (optional)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") addSnapshot();
              else if (e.key === "Escape") { setNaming(false); setName(""); }
            }}
          />
          <button type="button" onClick={addSnapshot}>Save</button>
          <button type="button" className="cancel" onClick={() => { setNaming(false); setName(""); }}>Cancel</button>
        </div>
      )}
      {snapshots.length > 0 && (
        <ul className="history-snapshots" aria-label="Snapshots">
          {snapshots.map((snap) => (
            <li key={snap.id}>
              {renamingId === snap.id ? (
                <input
                  className="history-snapshot-rename"
                  autoFocus
                  value={renameText}
                  maxLength={60}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="history-step snapshot"
                    onClick={() => goTo(snap)}
                    onDoubleClick={() => { setRenamingId(snap.id); setRenameText(snap.name); }}
                    title={`Go back to this snapshot — ${new Date(snap.at).toLocaleString()} (double-click to rename)`}
                  >
                    <span className="history-snapshot-icon" aria-hidden="true" />
                    <span className="history-step-label">{snap.name}</span>
                  </button>
                  <button
                    type="button"
                    className="history-snapshot-delete"
                    title="Rename this snapshot"
                    aria-label={`Rename snapshot ${snap.name}`}
                    onClick={() => { setRenamingId(snap.id); setRenameText(snap.name); }}
                  >
                    ✎
                  </button>
                </>
              )}
              <button
                type="button"
                className="history-snapshot-delete"
                title="Delete this snapshot"
                aria-label={`Delete snapshot ${snap.name}`}
                onClick={() => store(snapshots.filter((s) => s.id !== snap.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <ol className="history-list" ref={listRef}>
        {steps.map((step) => (
          <li key={step.index}>
            <button
              type="button"
              className={`history-step${step.current ? " current" : ""}${step.undone ? " undone" : ""}`}
              onClick={() => jumpToHistory(step.index)}
              aria-current={step.current ? "step" : undefined}
              title={step.current ? `${step.label} — where the design is now` : `Go to: ${step.label}`}
            >
              <span className="history-step-dot" aria-hidden="true" />
              <span className="history-step-label">{step.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
