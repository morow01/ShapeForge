/**
 * The clearance a new Subtract group starts with, in mm: how much the shape
 * being cut out is grown so a printed part fits into the hole. A printer
 * cannot make a gap of zero, and 0.2 mm is a typical fit for FDM. Kept in the
 * browser, not the document — it is a property of the printer, not the design.
 */
const KEY = "shapeforge.defaultClearance";
export const FALLBACK_CLEARANCE_MM = 0.2;

/**
 * The fits worth naming, in mm of gap per side — which is what this clearance
 * is, since the cutter grows by it in every direction. Two mating parts end up
 * this far apart all round, so a hole comes out twice this much wider than the
 * peg that goes into it.
 *
 * The numbers are the usual FDM ones and assume a well-tuned printer: a badly
 * squashed first layer or over-extrusion eats a fit before any of this
 * applies. Big flat faces sliding on each other want the looser end, a short
 * round peg the tighter.
 */
export const CLEARANCE_PRESETS: { mm: number; label: string; hint: string }[] = [
  { mm: 0.05, label: "Press", hint: "Press fit: needs force to assemble and is not meant to come apart again" },
  { mm: 0.1, label: "Snug", hint: "Friction fit: goes together by hand and stays put — pegs, dowels, lids" },
  { mm: 0.2, label: "Standard", hint: "The general-purpose fit: assembles easily, barely any play" },
  { mm: 0.3, label: "Loose", hint: "Free fit: slides and turns freely — moving parts, or large flat faces" },
];

export function getDefaultClearance(): number {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null) {
      const value = Number(stored);
      if (Number.isFinite(value) && value >= 0 && value <= 5) return value;
    }
  } catch {
    // Storage can be blocked; the fallback is a sensible fit.
  }
  return FALLBACK_CLEARANCE_MM;
}

export function setDefaultClearance(mm: number) {
  try {
    localStorage.setItem(KEY, String(Math.max(0, Math.min(5, mm))));
  } catch {
    // Not being able to remember it is not worth failing over.
  }
}
