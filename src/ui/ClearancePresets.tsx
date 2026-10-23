import { CLEARANCE_PRESETS } from "../document/clearance";

/** How close a typed value has to be to a named fit to count as that fit.
 *  Half the smallest gap between two presets, so at most one can ever match. */
const MATCH_TOLERANCE_MM = 0.02;

export function matchedPreset(mm: number): number | null {
  const hit = CLEARANCE_PRESETS.find((p) => Math.abs(p.mm - mm) < MATCH_TOLERANCE_MM);
  return hit ? hit.mm : null;
}

/**
 * The named fits, above whatever number field the clearance is typed into.
 * Picking one fills that field in; typing anything else simply leaves none of
 * them lit, which is what "custom" looks like here — no mode to switch into.
 */
export function ClearancePresets({
  value,
  onPick,
}: {
  value: number;
  onPick: (mm: number) => void;
}) {
  const active = matchedPreset(value);
  return (
    <div className="clearance-presets" role="group" aria-label="Fit presets">
      {CLEARANCE_PRESETS.map((p) => (
        <button
          key={p.mm}
          type="button"
          className={`clearance-preset ${active === p.mm ? "active" : ""}`}
          aria-pressed={active === p.mm}
          onClick={() => onPick(p.mm)}
          title={`${p.hint} (${p.mm} mm each side)`}
        >
          <span className="clearance-preset-name">{p.label}</span>
          <span className="clearance-preset-mm">{p.mm}</span>
        </button>
      ))}
    </div>
  );
}
