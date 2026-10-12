/**
 * Who wins when this computer and Drive both have a preview picture for a design.
 *
 * Every picture carries the time it was drawn. The newest one wins, everywhere, and nothing else counts. The
 * earlier rule compared fingerprints of the pictures against a note of what had last been sent, so it depended on
 * those notes being right: a stale or lost note (two sync jobs overlapping, a cleared record) made an old picture
 * win over a new one, and two computers holding different pictures could swap them back and forth.
 *
 * A picture with no recorded time (made before this rule) counts as time 0, so any dated picture beats it: the
 * first sync after the change settles every computer on Drive's current picture, then they stay level.
 */
export type ThumbnailAction = "pull" | "push" | "none";

export function thumbnailAction(
  local: { has: boolean; at: number },
  remote: { has: boolean; at: number },
): ThumbnailAction {
  if (!remote.has) return local.has ? "push" : "none";
  if (!local.has) return "pull";
  if (remote.at > local.at) return "pull";
  if (local.at > remote.at) return "push";
  return "none";
}
