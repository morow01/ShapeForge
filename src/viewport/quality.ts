export type ViewportQuality = "draft" | "normal" | "high";
export const VIEWPORT_QUALITY_KEY = "cad.viewportQuality";

/** Set once the old automatic "normal" default has been replaced by "high". */
const QUALITY_DEFAULT_HIGH_KEY = "cad.viewportQualityDefaultHigh";

export function readViewportQuality(): ViewportQuality {
  try {
    const value = localStorage.getItem(VIEWPORT_QUALITY_KEY);
    // The app used to save "normal" for everyone on first load, so a stored "normal" is usually just the old
    // default, not a choice. Upgrade it to "high" once; a deliberate "draft" or "high" is kept, and any
    // later choice of "normal" sticks (the flag is set, so it is not changed again).
    if (localStorage.getItem(QUALITY_DEFAULT_HIGH_KEY) !== "done") {
      localStorage.setItem(QUALITY_DEFAULT_HIGH_KEY, "done");
      if (value === null || value === "normal") {
        localStorage.setItem(VIEWPORT_QUALITY_KEY, "high");
        return "high";
      }
    }
    return value === "draft" || value === "normal" || value === "high" ? value : "high";
  } catch {
    return "high";
  }
}

export function viewportQualitySettings(quality: ViewportQuality, deviceRatio: number) {
  return {
    pixelRatio: quality === "draft" ? Math.min(deviceRatio, 0.75) : Math.min(deviceRatio, quality === "normal" ? 1 : 2),
    frameInterval: quality === "draft" ? 1000 / 30 : quality === "normal" ? 1000 / 60 : 0,
  };
}
