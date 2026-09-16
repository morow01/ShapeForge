export type ViewportQuality = "draft" | "normal" | "high";
export const VIEWPORT_QUALITY_KEY = "cad.viewportQuality";

export function readViewportQuality(): ViewportQuality {
  try {
    const value = localStorage.getItem(VIEWPORT_QUALITY_KEY);
    return value === "draft" || value === "high" ? value : "normal";
  } catch { return "normal"; }
}

export function viewportQualitySettings(quality: ViewportQuality, deviceRatio: number) {
  return {
    pixelRatio: quality === "draft" ? Math.min(deviceRatio, 0.75) : Math.min(deviceRatio, quality === "normal" ? 1 : 2),
    frameInterval: quality === "draft" ? 1000 / 30 : quality === "normal" ? 1000 / 60 : 0,
  };
}
