import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Shared by projects, folders and attachments: one menu, identical dismissal rules. */
export function HomeContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const id = useId();
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - (rect?.width ?? 200) - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - (rect?.height ?? 200) - 8)) });
  }, [x, y, children]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('shapeforge-home-menu-open', { detail: id }));
    const other = (e: Event) => { if ((e as CustomEvent).detail !== id) close.current(); };
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close.current(); };
    const dismiss = () => close.current();
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener('shapeforge-home-menu-open', other);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', keys);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('shapeforge-home-menu-open', other);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', keys);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [id]);
  return createPortal(<div ref={ref} className="home-menu" role="menu" style={position}>{children}</div>, document.body);
}
