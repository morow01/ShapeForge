import { attachmentBytes, cacheAttachmentBytes, listAttachments } from '../document/attachments';
import type { Attachment } from '../document/attachments';
import { driveApi } from '../drive/sync';
import { useDrive } from '../drive/state';

export const MAX_SAVED_IMPORT_BYTES = 200 * 1024 * 1024;
export function canImportSavedFile(name: string): boolean { return /\.(stl|3mf|svg)$/i.test(name); }
/** Hand original bytes to the existing computer-file importer; never edit the attachment. */
export async function savedFileForImport(chosen: Attachment): Promise<File> {
  const file = (await listAttachments()).find(f => f.id === chosen.id && !f.deleted);
  if (!file) throw new Error('This saved file was removed. Choose another file.');
  if (!canImportSavedFile(file.name)) throw new Error('Choose an STL, 3MF or SVG file.');
  if (file.size > MAX_SAVED_IMPORT_BYTES) throw new Error(`${file.name} is too large to import (maximum 200 MB).`);
  let bytes = await attachmentBytes(file.id);
  if (!bytes && file.driveId) {
    if (useDrive.getState().status !== 'signedIn') throw new Error('Connect Google Drive to import this file.');
    bytes = await driveApi().downloadBytes(file.driveId);
    await cacheAttachmentBytes(file.id, bytes);
  }
  if (!bytes) throw new Error('The original file is not available on this computer.');
  if (bytes.byteLength > MAX_SAVED_IMPORT_BYTES) throw new Error(`${file.name} is too large to import (maximum 200 MB).`);
  return new File([bytes], file.name, { type: file.mimeType, lastModified: file.updatedAt });
}
