import { useEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { lookupPreview, PREVIEWS, type Preview } from "./toolPreviewDemos";

/*
 * Hover previews for toolbar buttons: rest the pointer on a tool for a moment
 * and a card shows a short looping animation of what the tool does.
 *
 * Buttons opt in simply by having an aria-label listed in the registry in
 * toolPreviewDemos.tsx — nothing on the button itself changes, and disabled
 * buttons still preview, which is when an explanation helps most.
 */

// --------------------------------------------------------------------- layer

const SHOW_DELAY = 650;  // first hover: long enough not to flash while passing over
const WARM_DELAY = 120;  // while one is open (or just closed), neighbours swap in fast
const WARM_FOR = 600;
const CARD_W = 264;

const sideList = (el: HTMLElement) => el.closest<HTMLElement>(".tool-rail, .adaptive-tools, .adaptive-context-menu");

type Open = { preview: Preview; el: HTMLElement; left: number; top: number };

/** Mount once. Watches the whole document so buttons need no wiring. */
export function ToolPreviewLayer() {
  const [open, setOpen] = useState<Open | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const warmUntil = useRef(0);
  const current = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const isOpen = useRef(false);
  isOpen.current = open !== null;

  useEffect(() => {
    // The native title tooltip would pop up on top of the card, so it is
    // parked in a data attribute while the card is showing.
    const restoreTitle = (el: HTMLElement | null) => {
      if (el?.dataset.toolPreviewTitle !== undefined) {
        el.setAttribute("title", el.dataset.toolPreviewTitle);
        delete el.dataset.toolPreviewTitle;
      }
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      if (current.current) warmUntil.current = performance.now() + WARM_FOR;
      restoreTitle(current.current);
      current.current = null;
      setOpen(null);
    };
    const place = (el: HTMLElement, preview: Preview) => {
      const r = el.getBoundingClientRect();
      // Vertical tool lists (toolbar, suggestions, right-click menu) get the
      // card beside the whole list, so it never covers the list itself.
      const side = sideList(el);
      const cardH = cardRef.current?.offsetHeight || 250;
      let left: number, top: number;
      if (side) {
        left = side.getBoundingClientRect().right + 10;
        top = r.top + r.height / 2 - cardH / 2;
      } else {
        left = r.left + r.width / 2 - CARD_W / 2;
        top = r.bottom + 8;
      }
      left = Math.max(8, Math.min(left, window.innerWidth - CARD_W - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - cardH - 8));
      const title = el.getAttribute("title");
      if (title !== null) {
        el.dataset.toolPreviewTitle = title;
        el.removeAttribute("title");
      }
      setOpen({ preview, el, left, top });
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as Element | null)?.closest?.("button[aria-label]") as HTMLElement | null;
      const preview = lookupPreview(el?.getAttribute("aria-label") ?? "");
      if (!el || !preview) return;
      if (el === current.current) return;
      restoreTitle(current.current);
      current.current = el;
      window.clearTimeout(timer.current);
      const warm = isOpen.current || performance.now() < warmUntil.current;
      timer.current = window.setTimeout(() => { if (current.current === el) place(el, preview); }, warm ? WARM_DELAY : SHOW_DELAY);
    };
    const onOut = (e: PointerEvent) => {
      const el = current.current;
      if (!el) return;
      const to = e.relatedTarget as Node | null;
      if (to && el.contains(to)) return;
      if (el.contains(e.target as Node)) hide();
    };
    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.clearTimeout(timer.current);
      restoreTitle(current.current);
    };
  }, []);

  // Re-centre once the card's real height is known.
  useEffect(() => {
    if (!open || !cardRef.current || !sideList(open.el)) return;
    const r = open.el.getBoundingClientRect();
    const h = cardRef.current.offsetHeight;
    const top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8));
    if (Math.abs(top - open.top) > 1) setOpen({ ...open, top });
  }, [open]);

  const gallery = useGalleryHash();
  if (gallery) return createPortal(<ToolPreviewGallery />, document.body);
  if (!open) return null;
  return createPortal(
    <PreviewCard ref={cardRef} preview={open.preview} style={{ position: "fixed", left: open.left, top: open.top }} />,
    document.body,
  );
}

function PreviewCard({ preview: p, style, ref }: { preview: Preview; style?: CSSProperties; ref?: Ref<HTMLDivElement> }) {
  const Demo = p.demo;
  return (
    <div ref={ref} className="tool-preview" role="tooltip" style={{ width: CARD_W, ...style }}>
      <div className="tool-preview-head">
        <strong>{p.title}</strong>
        {p.keys && <kbd>{p.keys}</kbd>}
      </div>
      <svg className="tool-preview-demo" viewBox="0 0 240 152" aria-hidden="true" key={p.title}>
        <Demo />
      </svg>
      <p className="tool-preview-what">{p.what}</p>
      <p className="tool-preview-how">{p.how}</p>
    </div>
  );
}

/** Dev only: open the app at #tool-previews to review every card at once. */
function useGalleryHash() {
  const [on, setOn] = useState(() => import.meta.env.DEV && location.hash === "#tool-previews");
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const sync = () => setOn(location.hash === "#tool-previews");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return on;
}

function ToolPreviewGallery() {
  return (
    <div className="tool-preview-gallery">
      {Object.entries(PREVIEWS).map(([label, preview]) => (
        <PreviewCard key={label} preview={preview} style={{ position: "static", animation: "none" }} />
      ))}
    </div>
  );
}
