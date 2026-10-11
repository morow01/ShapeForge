import { useRef, useState } from "react";
import { putBlob } from "../document/blobStore";

export type MissingFile = {
  blobId: string;
  fileName: string;
  /** Size of the file when it was imported, if the design recorded it. */
  byteSize?: number;
  /** How many objects in the design use it. */
  uses: number;
};

type Props = {
  files: MissingFile[];
  /** How many objects in the design need a missing file. */
  objectCount: number;
  /** Deletes those objects from the design. */
  onDeleteObjects: () => void;
  onClose: () => void;
  /** Called after a file has been stored, so the design can rebuild with it. */
  onRelinked: () => void;
};

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 1048576 ? 2 : 1)} MB`;
const stem = (name: string) => name.trim().toLowerCase();

/**
 * Lets someone point the design at the imported files it lost (an old export, cleared site data, a copy
 * that arrived through Drive without them). A chosen file is stored under the exact id the design already
 * uses, so every object that needs it reconnects in place and nothing has to be placed again.
 */
export function MissingFilesDialog({ files: filesNow, objectCount, onDeleteObjects, onClose, onRelinked }: Props) {
  // The list the dialog opened with. The design stops reporting a file the moment it is linked, so without
  // this the row would vanish instead of showing the tick.
  const [files] = useState(filesNow);
  const [linked, setLinked] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pickAll = useRef<HTMLInputElement>(null);

  const store = async (entry: MissingFile, file: File): Promise<boolean> => {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength < 84) {
      setMessage(`“${file.name}” is too small to be an STL file.`);
      return false;
    }
    await putBlob(entry.blobId, bytes);
    setLinked((prev) => ({ ...prev, [entry.blobId]: bytes.byteLength }));
    return true;
  };

  const chooseFor = async (entry: MissingFile, list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      if (await store(entry, file)) onRelinked();
    } catch {
      setMessage(`Couldn't store “${file.name}”. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  // Several files at once: each is matched to the design's file of the same name.
  const chooseMany = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setMessage(null);
    const unused: string[] = [];
    let stored = 0;
    try {
      for (const file of Array.from(list)) {
        const entry = files.find((f) => !linked[f.blobId] && stem(f.fileName) === stem(file.name));
        if (!entry) {
          unused.push(file.name);
          continue;
        }
        if (await store(entry, file)) stored++;
      }
      if (stored) onRelinked();
      if (unused.length) setMessage(`Not needed by this design (no object uses a file with that name): ${unused.join(", ")}`);
    } catch {
      setMessage("Couldn't store one of the files. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const left = files.filter((f) => !linked[f.blobId]).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="save-dialog missing-files" role="dialog" aria-label="Locate missing files" onClick={(e) => e.stopPropagation()}>
        <h2>Locate missing files</h2>
        <p className="confirm-message">
          This design uses imported files that are not on this computer, so the objects that need them are left out.
          Pick the files and those objects come back exactly where they were.
        </p>
        <ul className="missing-files-list">
          {files.map((f) => {
            const done = linked[f.blobId];
            const different = done !== undefined && f.byteSize && (done > f.byteSize * 2 || done < f.byteSize / 2);
            return (
              <li key={f.blobId} className={done !== undefined ? "done" : ""}>
                <div className="missing-files-name">
                  <strong>{f.fileName}</strong>
                  <small>
                    {f.uses} {f.uses === 1 ? "object uses" : "objects use"} it
                    {f.byteSize ? ` · was ${mb(f.byteSize)} when imported` : ""}
                  </small>
                  {done !== undefined && (
                    <small className={different ? "warn" : "ok"}>
                      ✓ Linked ({mb(done)}){different ? " — a very different size from the original, so check the result" : ""}
                    </small>
                  )}
                </div>
                {done === undefined && (
                  <label className="modal-btn primary missing-files-pick">
                    Choose file…
                    <input
                      type="file"
                      accept=".stl,model/stl,application/sla"
                      hidden
                      disabled={busy}
                      onChange={(e) => {
                        void chooseFor(f, e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
        {message && <p className="missing-files-note">{message}</p>}
        {left > 0 && !confirmDelete && (
          <button className="home-link missing-files-delete" onClick={() => setConfirmDelete(true)}>
            No longer need them? Delete the objects that use these files…
          </button>
        )}
        {left > 0 && confirmDelete && (
          <div className="missing-files-confirm" role="alert">
            <p>
              Delete the <strong>{objectCount}</strong> {objectCount === 1 ? "object" : "objects"} that need the missing{" "}
              {left === 1 ? "file" : "files"}? The rest of the design stays as it is. You can bring them back with Undo.
            </p>
            <div className="save-buttons">
              <button className="modal-btn" onClick={() => setConfirmDelete(false)}>Keep them</button>
              <button
                className="modal-btn destructive"
                onClick={() => {
                  onDeleteObjects();
                  onClose();
                }}
              >
                Delete {objectCount} {objectCount === 1 ? "object" : "objects"}
              </button>
            </div>
          </div>
        )}
        <div className="save-buttons">
          {left > 1 && (
            <>
              <button className="modal-btn" disabled={busy} onClick={() => pickAll.current?.click()}>
                Choose several files…
              </button>
              <input
                ref={pickAll}
                type="file"
                accept=".stl,model/stl,application/sla"
                multiple
                hidden
                onChange={(e) => {
                  void chooseMany(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
          <button className="modal-btn primary" onClick={onClose}>
            {left === 0 ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
