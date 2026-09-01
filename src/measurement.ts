export type DisplayUnit = "mm" | "cm" | "in";
export type AppearancePreference = "light" | "dark" | "system";

export interface MeasurementPreferences {
  unit: DisplayUnit;
  decimals: number;
  appearance: AppearancePreference;
}

export const UNIT_LABEL: Record<DisplayUnit, string> = {
  mm: "mm",
  cm: "cm",
  in: "in",
};

export function fromMillimetres(mm: number, unit: DisplayUnit): number {
  return unit === "cm" ? mm / 10 : unit === "in" ? mm / 25.4 : mm;
}

export function toMillimetres(value: number, unit: DisplayUnit): number {
  return unit === "cm" ? value * 10 : unit === "in" ? value * 25.4 : value;
}

export function formatLength(mm: number, unit: DisplayUnit, decimals: number): string {
  return fromMillimetres(mm, unit).toFixed(decimals);
}

export function displayStep(unit: DisplayUnit, decimals: number): number {
  const displayed = 10 ** -decimals;
  return unit === "in" ? Math.max(displayed, 0.001) : displayed;
}
