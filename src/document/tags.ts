/* Tags and the star. A design carries a few short labels and a star flag. They travel to Drive as
   two small file properties, which Drive limits to about 120 bytes each, so tags are kept short. */

export const MAX_TAG_LENGTH = 24;
const MAX_ENCODED_BYTES = 100;

/** A tag as typed, tidied: no commas, single spaces, not too long. */
export function cleanTag(raw: string): string {
  return raw.replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
}

/** The same tags without repeats, ignoring capital letters. The first spelling wins. */
export function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether a set of tags is small enough to be kept on Drive. */
export function tagsFitDrive(tags: string[]): boolean {
  return new TextEncoder().encode(encodeTags(tags)).length <= MAX_ENCODED_BYTES;
}

// The "t:" prefix means "no tags" is a real value, so clearing the tags on one computer clears them everywhere.
export function encodeTags(tags: string[] | undefined): string {
  return `t:${(tags ?? []).join(",")}`;
}

export function decodeTags(value: string | undefined): string[] {
  if (!value || !value.startsWith("t:")) return [];
  return value.slice(2).split(",").map((t) => t.trim()).filter(Boolean);
}

/** Offered from the start, so there is something to click straight away. They can be deleted like any other. */
export const SAMPLE_TAGS = ["Idea", "Prototype", "Final", "Printed", "Client", "Needs fixing", "Archive"];

const REGISTRY_KEY = "cad.tagList";

/** Every tag the person has made or been offered, whether or not a design uses it now. */
export function loadTagRegistry(): string[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (raw === null) return [...SAMPLE_TAGS];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [...SAMPLE_TAGS];
  } catch {
    return [...SAMPLE_TAGS];
  }
}

function writeTagRegistry(list: string[]): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(list));
  } catch {
    /* tags used by designs still show; only the unused ones are forgotten */
  }
}

export function addToTagRegistry(tags: string[]): void {
  if (tags.length) writeTagRegistry(uniqueTags([...loadTagRegistry(), ...tags]));
}

export function removeFromTagRegistry(tag: string): void {
  writeTagRegistry(loadTagRegistry().filter((t) => !sameTag(t, tag)));
}
