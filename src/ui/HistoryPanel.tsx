import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { historyTimeline, jumpToHistory, labelStep, useDoc, useTemporal } from "../document/store";
import { loadSnapshots, saveSnapshots, type DesignSnapshot } from "../document/snapshotStore";

const iconProps = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const PencilIcon = () => <svg {...iconProps}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>;
const TrashIcon = () => <svg {...iconProps}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;

/** A name field with its own Save and Cancel, on a line of its own so nothing is squeezed. */
function NameForm({
  value,
  placeholder,
  saveLabel,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  placeholder: string;
  saveLabel: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="history-snapshot-form">
      <input
        autoFocus
        value={value}
        maxLength={60}
        placeholder={placeholder}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onSave();
          else if (e.key === "Escape") onCancel();
        }}
      />
      <div className="history-snapshot-form-actions">
        <button type="button" className="cancel" onClick={onCancel}>Cancel</button>
        <button type="button" className="save" onClick={onSave}>{saveLabel}</button>
      </div>
    </div>
  );
}

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
        <NameForm
          value={name}
          placeholder="Name this snapshot (optional)"
          saveLabel="Save"
          onChange={setName}
          onSave={addSnapshot}
          onCancel={() => { setNaming(false); setName(""); }}
        />
      )}
      {snapshots.length > 0 && (
        <ul className="history-snapshots" aria-label="Snapshots">
          {snapshots.map((snap) => (
            <li key={snap.id}>
              {renamingId === snap.id ? (
                <NameForm
                  value={renameText}
                  placeholder="Snapshot name"
                  saveLabel="Rename"
                  onChange={setRenameText}
                  onSave={commitRename}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <div className="history-snapshot-row">
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
                    className="history-snapshot-tool"
                    title="Rename this snapshot"
                    aria-label={`Rename snapshot ${snap.name}`}
                    onClick={() => { setRenamingId(snap.id); setRenameText(snap.name); }}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    className="history-snapshot-tool danger"
                    title="Delete this snapshot"
                    aria-label={`Delete snapshot ${snap.name}`}
                    onClick={() => store(snapshots.filter((x) => x.id !== snap.id))}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
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
