/**
 * The clearance a new Subtract group starts with, in mm: how much the shape
 * being cut out is grown so a printed part fits into the hole. A printer
 * cannot make a gap of zero, and 0.2 mm is a typical fit for FDM. Kept in the
 * browser, not the document — it is a property of the printer, not the design.
 */
const KEY = "shapeforge.defaultClearance";
export const FALLBACK_CLEARANCE_MM = 0.2;

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
