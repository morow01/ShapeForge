import { missingImportFiles } from "../document/persist";
import type { SceneNode } from "../document/types";
import type { ConfirmOptions } from "./ConfirmDialog";

/**
 * Asks before a backup file is written if some imported files are not on this computer, because the file
 * cannot contain what is not here: anyone who opens it would find those objects missing, and so would you
 * when you come back to it. Resolves true when the export should go ahead (nothing missing, or the person
 * chose to export anyway).
 */
export async function confirmExportWithMissingFiles(
  ask: (options: ConfirmOptions) => Promise<boolean>,
  nodes: SceneNode[],
): Promise<boolean> {
  let lost: { blobId: string; fileName: string }[] = [];
  try {
    lost = await missingImportFiles(nodes);
  } catch {
    return true; // could not check: do not get in the way of a backup
  }
  if (!lost.length) return true;
  const names = [...new Set(lost.map((f) => f.fileName))];
  const shown = names.slice(0, 6).join(", ") + (names.length > 6 ? ` and ${names.length - 6} more` : "");
  return ask({
    title: "Some imported files are missing",
    message:
      `${names.length === 1 ? "This file is" : "These files are"} not on this computer, so the backup file will not contain ${names.length === 1 ? "it" : "them"}: ${shown}. ` +
      `Anyone who opens the backup (you included) will find the objects that use ${names.length === 1 ? "it" : "them"} missing. ` +
      `Restore the files first with "Locate files…", or export anyway.`,
    confirmLabel: "Export anyway",
    cancelLabel: "Cancel",
  });
}
