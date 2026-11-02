import { attachmentBytes, forgetAttachment, listAttachments, mutateAttachment, saveAttachment } from '../document/attachments';
import { listFolders } from '../document/persist';
import { DriveApi, DriveError } from './api';

/** Metadata is synced first. Original files are fetched only on Download. */
export async function syncAttachments(api: DriveApi, parentFor: (folderId: string | null) => Promise<string>): Promise<void> {
  const remote = (await api.listAll()).filter(f => f.appProperties?.kind === 'attachment');
  const byId = new Map(remote.map(f => [f.appProperties?.attachmentId, f]));
  const local = await listAttachments();
  for (const item of local) {
    const there = byId.get(item.id);
    const driveId = there?.id ?? item.driveId;
    if (item.deleted) {
      if (driveId) {
        try { await api.trash(driveId); }
        catch (e) { if (!(e instanceof DriveError && e.status === 404)) throw e; }
      }
      await forgetAttachment(item.id);
      byId.delete(item.id);
      continue;
    }
    if (!item.dirty) {
      if (item.driveId && !there) await forgetAttachment(item.id);
      continue;
    }
    const parent = await parentFor(item.folderId);
    let file;
    if (there) {
      file = await api.updateMetadata(there.id, { name: item.name,
        ...(there.parents?.[0] !== parent ? { addParent: parent, removeParent: there.parents?.[0] } : {}) });
    } else {
      const bytes = await attachmentBytes(item.id);
      if (!bytes) throw new Error(`Original file is missing: ${item.name}`);
      file = await api.upload({ name: item.name, parentId: parent, mimeType: item.mimeType, body: bytes, kind: 'attachment',
        properties: { attachmentId: item.id, size: String(item.size) } });
    }
    await mutateAttachment(item.id, current => ({ ...current, driveId: file.id, dirty: current.revision !== item.revision }));
    byId.delete(item.id);
  }
  const folders = listFolders();
  for (const [id, file] of byId) {
    if (!id) continue;
    const current = local.find(x => x.id === id);
    if (current?.dirty || current?.deleted) continue;
    await saveAttachment({ id, driveId: file.id, name: file.name, mimeType: file.mimeType,
      folderId: folders.find(f => f.driveId && file.parents?.includes(f.driveId))?.id ?? null,
      size: Number(file.appProperties?.size) || 0, updatedAt: Date.parse(file.modifiedTime ?? '') || Date.now(),
      revision: current?.revision ?? id, dirty: false });
  }
}
