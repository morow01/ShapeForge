import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../document/attachments';
import { fileExtension, previewAttachment, supportsPreview } from './attachmentPreviews';

export function AttachmentThumbnail({ file, loadRemote }: { file: Attachment; loadRemote: () => Promise<ArrayBuffer> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<string | null>(null);
  const [state, setState] = useState<'waiting' | 'loading' | 'missing' | 'failed'>('waiting');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      observer.disconnect(); setState('loading');
      void previewAttachment(file).then(url => {
        if (alive) { setImage(url); setState(url ? 'waiting' : 'missing'); }
      }).catch(e => { if (alive) { setState('failed'); setError(e instanceof Error ? e.message : 'Preview unavailable'); } });
    }, { rootMargin: '100px' });
    observer.observe(el);
    return () => { alive = false; observer.disconnect(); };
  }, [file.id, file.name]);
  return <div ref={ref} className="attachment-thumbnail" title={error || undefined}>
    {image ? <img src={image} alt={`Preview of ${file.name}`} loading="lazy" /> : <>
      <svg width="38" height="44" viewBox="0 0 32 38" fill="none" aria-hidden="true"><path d="M5 1h14l8 8v28H5z" fill="#fff" stroke="#91aaa9" strokeWidth="1.5"/><path d="M19 1v9h8M10 18h12M10 23h12M10 28h9" stroke="#91aaa9" strokeWidth="1.5"/></svg>
      <span className="attachment-extension">{fileExtension(file.name).toUpperCase() || 'FILE'}</span>
      {state === 'loading' && <small>Making preview…</small>}
      {state === 'failed' && <small>Preview unavailable</small>}
      {state === 'missing' && supportsPreview(file.name) && file.driveId && <button className="modal-btn" onClick={() => {
        setState('loading'); setError('');
        void previewAttachment(file, loadRemote).then(url => { setImage(url); setState(url ? 'waiting' : 'missing'); })
          .catch(e => { setState('failed'); setError(e instanceof Error ? e.message : 'Preview unavailable'); });
      }}>Load preview</button>}
    </>}
  </div>;
}
