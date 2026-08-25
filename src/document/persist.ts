import { PRIMITIVES } from "./types";
import type { BooleanOp, PrimitiveKind, SceneNode, Vec3 } from "./types";

const KEY = "cad.document";
/** Bump when the node shape changes incompatibly; older saves are then ignored
 *  rather than being fed to the kernel as garbage. */
const VERSION = 1;

interface Stored {
  version: number;
  nodes: unknown;
}

const OPS: BooleanOp[] = ["union", "subtract", "intersect"];

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * Saved JSON is untrusted — it may be from an older build, hand-edited, or
 * truncated. Anything that does not match is dropped rather than crashing the
 * kernel later with a half-formed node.
 */
function parseNode(raw: unknown): SceneNode | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;

  if (typeof n.id !== "string" || typeof n.name !== "string") return null;
  if (!isVec3(n.position) || !isVec3(n.rotation)) return null;
  const base = {
    id: n.id,
    name: n.name,
    position: n.position,
    rotation: n.rotation,
    isHole: n.isHole === true,
  };

  if (n.type === "group") {
    if (!Array.isArray(n.children)) return null;
    const op = OPS.includes(n.op as BooleanOp) ? (n.op as BooleanOp) : "union";
    const children = n.children.map(parseNode).filter((c): c is SceneNode => c !== null);
    return { ...base, type: "group", op, children, collapsed: n.collapsed === true };
  }

  if (n.type === "object") {
    const kind = n.kind as PrimitiveKind;
    if (!kind || !(kind in PRIMITIVES)) return null;
    if (!n.params || typeof n.params !== "object") return null;

    // Fill in any parameter added since the save was written.
    const params: Record<string, number> = { ...PRIMITIVES[kind].defaults };
    for (const [k, v] of Object.entries(n.params as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
    }
    return { ...base, type: "object", kind, params };
  }

  if (n.type === "import") {
    if (typeof n.blobId !== "string" || typeof n.fileName !== "string") return null;
    if (typeof n.byteSize !== "number") return null;
    return { ...base, type: "import", blobId: n.blobId, fileName: n.fileName, byteSize: n.byteSize };
  }

  return null;
}

export function loadDocument(): SceneNode[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Stored;
    if (parsed?.version !== VERSION || !Array.isArray(parsed.nodes)) return [];
    return parsed.nodes.map(parseNode).filter((n): n is SceneNode => n !== null);
  } catch {
    return [];
  }
}

export function saveDocument(nodes: SceneNode[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, nodes }));
    return true;
  } catch {
    // Quota exceeded, or storage blocked (private mode / disabled cookies).
    return false;
  }
}

export function clearDocument() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing useful to do */
  }
}

/** Largest numeric id suffix in the tree, so restored ids are never reissued. */
export function highestIdSuffix(nodes: SceneNode[]): number {
  let max = 0;
  const walk = (list: SceneNode[]) => {
    for (const n of list) {
      const m = /^n-(\d+)$/.exec(n.id);
      if (m) max = Math.max(max, Number(m[1]));
      if (n.type === "group") walk(n.children);
    }
  };
  walk(nodes);
  return max;
}
