import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  /** null hides the Cancel button, for a plain notice. */
  cancelLabel?: string | null;
  /** Paints the confirm button red and starts with Cancel focused, so Enter cannot delete by accident. */
  destructive?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

function ConfirmBox({ pending, onResult }: { pending: Pending; onResult: (ok: boolean) => void }) {
  const safeRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (pending.destructive ? safeRef.current ?? confirmRef.current : confirmRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onResult(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, onResult]);

  return (
    <div className="modal-backdrop" style={{ zIndex: 3000 }} onClick={() => onResult(false)}>
      <div className="save-dialog confirm-dialog" role="alertdialog" aria-label={pending.title} onClick={(e) => e.stopPropagation()}>
        <h2>{pending.title}</h2>
        <p className="confirm-message">{pending.message}</p>
        <div className="save-buttons">
          {pending.cancelLabel !== null && (
            <button ref={safeRef} className="modal-btn" onClick={() => onResult(false)}>
              {pending.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            ref={confirmRef}
            className={`modal-btn ${pending.destructive ? "destructive" : "primary"}`}
            onClick={() => onResult(true)}
          >
            {pending.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * An in-app replacement for window.confirm() and alert(). Await ask(...) for a yes/no, and
 * render `dialog` somewhere in the component. The browser's own boxes carry the page address,
 * cannot be styled, and in the desktop webview confirm() silently answers "no".
 */
export function useConfirm(): { ask: (options: ConfirmOptions) => Promise<boolean>; dialog: ReactElement | null } {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );

  const settle = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  return { ask, dialog: pending ? <ConfirmBox pending={pending} onResult={settle} /> : null };
}
