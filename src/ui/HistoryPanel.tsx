import { useEffect, useMemo, useRef } from "react";
import { historyTimeline, jumpToHistory, useDoc, useTemporal } from "../document/store";

/**
 * Photoshop's History palette over the document's own undo stack: the steps
 * taken in this design, oldest at the top, and a click puts the document back
 * to exactly that state. Steps past the one in use stay listed, greyed, until
 * the next edit from here replaces them — the same bargain Photoshop makes.
 *
 * This is a view, not a second history: everything it lists comes from the
 * one stack behind Undo/Redo, so the three can never disagree.
 */
export function HistoryPanel() {
  // Two selectors rather than one object, which would be a new value on every
  // read and never settle. zundo splices its stacks in place, so each of
  // these can come back unchanged while the other does not; between them,
  // every move shows up.
  const past = useTemporal((s) => s.pastStates);
  const future = useTemporal((s) => s.futureStates);
  const currentLabel = useDoc((s) => s.historyLabel);
  const steps = useMemo(() => historyTimeline(past, future, currentLabel), [past, future, currentLabel]);

  // The list grows downwards, so the step in use has to be brought back into
  // view after an edit scrolls it off the bottom.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".history-step.current")?.scrollIntoView({ block: "nearest" });
  }, [steps]);

  const done = steps.filter((step) => !step.undone).length - 1;

  return (
    <section className="history-panel" aria-label="History">
      <div className="panel-heading compact">
        <div>
          <h1>History</h1>
          <p>{done === 0 ? "No steps yet" : `${done} step${done === 1 ? "" : "s"}`}</p>
        </div>
      </div>
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
