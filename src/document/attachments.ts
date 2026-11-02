/** Folder attachments keep original bytes outside project documents and the geometry worker. */
export interface Attachment {
  id: string;
  name: string;
  folderId: string | null;
  size: number;
  mimeType: string;
  updatedAt: number;
  revision: string;
  driveId?: string;
  dirty: boolean;
  deleted?: boolean;
}
const DB = 'shapeforge-attachments';
export const ATTACHMENTS_CHANGED = 'shapeforge-attachments-changed';
function changed() { window.dispatchEvent(new Event(ATTACHMENTS_CHANGED)); }
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('meta')) req.result.createObjectStore('meta', { keyPath: 'id' });
      if (!req.result.objectStoreNames.contains('bytes')) req.result.createObjectStore('bytes');
      if (!req.result.objectStoreNames.contains('previews')) req.result.createObjectStore('previews');
    };
    req.onblocked = () => reject(new Error('Close other ShapeForge windows and reopen to finish the file preview update.'));

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function read<T>(store: string, key?: string): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
export async function listAttachments(): Promise<Attachment[]> { return read<Attachment[]>('meta'); }
export async function attachmentBytes(id: string): Promise<ArrayBuffer | undefined> { return read('bytes', id); }
export async function saveAttachment(meta: Attachment, bytes?: ArrayBuffer): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'bytes', 'previews'], 'readwrite');
      tx.objectStore('meta').put(meta);
      if (bytes !== undefined) tx.objectStore('bytes').put(bytes, meta.id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Could not save this file. Storage may be full.'));
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
  changed();
}
export async function addAttachment(file: File, folderId: string | null): Promise<void> {
  const bytes = await file.arrayBuffer();
  await saveAttachment({ id: crypto.randomUUID(), name: file.name, folderId, size: file.size,
    mimeType: file.type || 'application/octet-stream', updatedAt: Date.now(), revision: crypto.randomUUID(), dirty: true }, bytes);
}
/** Changes metadata atomically so an upload completing cannot overwrite a newer rename or move. */
export async function editAttachment(id: string, change: Partial<Pick<Attachment, 'name' | 'folderId' | 'deleted'>>): Promise<void> {
  await mutateAttachment(id, current => ({ ...current, ...change, dirty: true, updatedAt: Date.now(), revision: crypto.randomUUID() }));
}
export async function mutateAttachment(id: string, update: (current: Attachment) => Attachment): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'bytes', 'previews'], 'readwrite'), store = tx.objectStore('meta');
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) {
          const next = update(req.result); store.put(next);
          if (next.deleted) { tx.objectStore('bytes').delete(id); tx.objectStore('previews').delete(id); }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
  changed();
}
export async function forgetAttachment(id: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'bytes', 'previews'], 'readwrite');
      tx.objectStore('meta').delete(id); tx.objectStore('bytes').delete(id); tx.objectStore('previews').delete(id);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
  changed();
}
/** Cache a lazy download without overwriting a simultaneous metadata change. */
export async function cacheAttachmentBytes(id: string, bytes: ArrayBuffer): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'bytes', 'previews'], 'readwrite');
      const req = tx.objectStore('meta').get(id);
      req.onsuccess = () => { if (req.result && !req.result.deleted) tx.objectStore('bytes').put(bytes, id); };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** Thumbnails are small cached images; the original file is never changed. */
export async function attachmentPreview(id: string): Promise<string | undefined> { return read('previews', id); }
export async function saveAttachmentPreview(id: string, dataUrl: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'previews'], 'readwrite');
      const req = tx.objectStore('meta').get(id);
      req.onsuccess = () => { if (req.result && !req.result.deleted) tx.objectStore('previews').put(dataUrl, id); };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
