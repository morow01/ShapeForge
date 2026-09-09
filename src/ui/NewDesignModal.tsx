/**
 * Asked before a new design replaces what is on screen.
 *
 * This is an in-app dialog rather than window.confirm() because the app's
 * webview does not support the native ones: prompt() throws outright and
 * confirm() silently returns false, so anything gated on them either died or
 * quietly did nothing.
 *
 * The honest framing matters here. Starting a new design does NOT destroy the
 * current one — it is written to the Projects Library first and can be
 * reopened from File > Open. So this asks rather than warns, and offers the
 * one thing the library does not give you: a copy saved out to your own disk.
 */
export function NewDesignModal({
  open,
  projectName,
  objectCount,
  onSaveFirst,
  onContinue,
  onClose,
}: {
  open: boolean;
  projectName: string;
  objectCount: number;
  onSaveFirst: () => void;
  onContinue: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-design-title"
      >
        <header className="modal-header">
          <div className="modal-title-group">
            <h2 id="new-design-title">Start a new design?</h2>
            <p className="modal-subtitle">
              {objectCount} object{objectCount === 1 ? "" : "s"} in “{projectName}”
            </p>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Cancel">
            ×
          </button>
        </header>

        <div className="export-modal-body">
          <p className="field-hint">
            “{projectName}” is kept in your Projects Library either way — you can
            reopen it from File &gt; Open. Save a copy if you also want it as a
            file on disk.
          </p>
        </div>

        <footer className="export-modal-footer">
          <button className="export-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="export-modal-cancel" onClick={onSaveFirst}>
            Save a copy first
          </button>
          <button className="export-btn export-modal-confirm" onClick={onContinue}>
            <span>Start new</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
