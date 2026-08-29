import { useState, useEffect } from "react";

export interface SvgImportConfig {
  width: number;
  height: number;
  thickness: number;
}

interface Props {
  isOpen: boolean;
  fileName: string;
  initialWidth: number;
  initialHeight: number;
  rawWidth?: number;
  rawHeight?: number;
  detectedPreset?: "illustrator" | "web" | "physical";
  onClose: () => void;
  onImport: (config: SvgImportConfig) => void;
}

export function SvgImportModal({
  isOpen,
  fileName,
  initialWidth,
  initialHeight,
  rawWidth,
  rawHeight,
  detectedPreset = "physical",
  onClose,
  onImport,
}: Props) {
  const [widthStr, setWidthStr] = useState(initialWidth.toFixed(3));
  const [heightStr, setHeightStr] = useState(initialHeight.toFixed(3));
  const [thickness, setThickness] = useState(2.0);
  const [lockAspect, setLockAspect] = useState(true);
  const [activePreset, setActivePreset] = useState<string>(
    detectedPreset === "physical" ? "detected" : detectedPreset,
  );
  const [ratio, setRatio] = useState(initialHeight > 0 ? initialWidth / initialHeight : 1);

  const rawW = rawWidth ?? initialWidth;
  const rawH = rawHeight ?? initialHeight;
  const detectedLabel = detectedPreset === "illustrator"
    ? "Illustrator metadata · 72 DPI"
    : detectedPreset === "web"
      ? "Web/CSS units · 96 DPI"
      : "Physical size from file";

  useEffect(() => {
    setWidthStr(initialWidth.toFixed(3));
    setHeightStr(initialHeight.toFixed(3));
    setThickness(2.0);
    setLockAspect(true);
    setActivePreset(detectedPreset === "physical" ? "detected" : detectedPreset);
    if (initialHeight > 0) {
      setRatio(initialWidth / initialHeight);
    }
  }, [initialWidth, initialHeight, detectedPreset, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && (e.target as HTMLElement)?.tagName !== "TEXTAREA") {
        e.preventDefault();
        handleImport();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, widthStr, heightStr, thickness]);

  if (!isOpen) return null;

  const toggleLock = () => {
    setLockAspect((prev) => {
      const next = !prev;
      const h = parseFloat(heightStr);
      const w = parseFloat(widthStr);
      if (next && h > 0 && w > 0) {
        setRatio(w / h);
      }
      return next;
    });
  };

  const handleWidthChange = (valStr: string) => {
    setWidthStr(valStr);
    setActivePreset("custom");
    const val = parseFloat(valStr);
    if (Number.isFinite(val) && val > 0 && lockAspect && ratio > 0) {
      setHeightStr((val / ratio).toFixed(3));
    }
  };

  const handleHeightChange = (valStr: string) => {
    setHeightStr(valStr);
    setActivePreset("custom");
    const val = parseFloat(valStr);
    if (Number.isFinite(val) && val > 0 && lockAspect && ratio > 0) {
      setWidthStr((val * ratio).toFixed(3));
    }
  };

  const applyPreset = (preset: "illustrator" | "web" | "direct_mm" | "detected") => {
    setActivePreset(preset);
    let newW = initialWidth;
    let newH = initialHeight;

    if (preset === "illustrator") {
      // 1pt = 1/72 inch = 25.4 / 72 mm ≈ 0.352778 mm
      newW = rawW * (25.4 / 72);
      newH = rawH * (25.4 / 72);
    } else if (preset === "web") {
      // 1px = 1/96 inch = 25.4 / 96 mm ≈ 0.264583 mm
      newW = rawW * (25.4 / 96);
      newH = rawH * (25.4 / 96);
    } else if (preset === "direct_mm") {
      // 1 unit = 1 mm
      newW = rawW * 1.0;
      newH = rawH * 1.0;
    } else if (preset === "detected") {
      newW = initialWidth;
      newH = initialHeight;
    }

    setWidthStr(newW.toFixed(3));
    setHeightStr(newH.toFixed(3));
    if (newH > 0) {
      setRatio(newW / newH);
    }
  };

  const handleImport = () => {
    const w = parseFloat(widthStr) || initialWidth;
    const h = parseFloat(heightStr) || initialHeight;
    if (w <= 0 || h <= 0 || thickness <= 0) return;
    onImport({
      width: Math.max(0.01, w),
      height: Math.max(0.01, h),
      thickness: Math.max(0.01, thickness),
    });
  };

  return (
    <div className="modal-backdrop">
      <div
        className="projects-modal svg-import-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="svg-import-title"
      >
        <div className="modal-header">
          <div className="modal-title-group">
            <h2 id="svg-import-title">Import SVG Artwork</h2>
            <span className="modal-subtitle">{fileName}</span>
          </div>
          <button
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
            title="Cancel (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="svg-import-body">
          {/* Preset Buttons */}
          <div className="svg-import-section">
            <label className="svg-import-section-title">Scale / Unit Preset</label>
            <div className="svg-preset-grid">
              <button
                type="button"
                className={`svg-preset-btn ${activePreset === "illustrator" ? "active" : ""}`}
                onClick={() => applyPreset("illustrator")}
                title="Illustrator points: 1 pt = 1/72 in (0.353 mm)"
              >
                <strong>Illustrator (72 DPI)</strong>
                <span>1 pt = 1/72" (0.353 mm)</span>
              </button>

              <button
                type="button"
                className={`svg-preset-btn ${activePreset === "web" ? "active" : ""}`}
                onClick={() => applyPreset("web")}
                title="Standard CSS / Web: 1 px = 1/96 in (0.265 mm)"
              >
                <strong>Web / CSS (96 DPI)</strong>
                <span>1 px = 1/96" (0.265 mm)</span>
              </button>

              <button
                type="button"
                className={`svg-preset-btn ${activePreset === "direct_mm" ? "active" : ""}`}
                onClick={() => applyPreset("direct_mm")}
                title="1 SVG user unit = 1 mm"
              >
                <strong>Exact 1:1 mm</strong>
                <span>1 unit = 1.000 mm</span>
              </button>

              <button
                type="button"
                className={`svg-preset-btn ${activePreset === "detected" ? "active" : ""}`}
                onClick={() => applyPreset("detected")}
                title="Use the automatically detected artwork size"
              >
                <strong>Detected artwork</strong>
                <span>{detectedLabel}</span>
              </button>
            </div>
          </div>

          {/* Size inputs */}
          <div className="svg-import-section">
            <label className="svg-import-section-title">Dimensions (mm)</label>
            <div className="svg-dims-row">
              <div className="svg-dim-field">
                <span className="svg-dim-label">Width (X)</span>
                <div className="svg-input-wrap">
                  <input
                    type="number"
                    className="num"
                    min={0.001}
                    step="0.001"
                    value={widthStr}
                    onChange={(e) => handleWidthChange(e.target.value)}
                  />
                  <span className="svg-unit-tag">mm</span>
                </div>
              </div>

              <button
                type="button"
                className={`svg-lock-btn ${lockAspect ? "active" : ""}`}
                onClick={toggleLock}
                title={lockAspect ? "Proportional scale locked (click to unlock)" : "Proportional scale unlocked (click to lock)"}
                aria-label="Toggle aspect ratio lock"
              >
                {lockAspect ? "🔒" : "🔓"}
              </button>

              <div className="svg-dim-field">
                <span className="svg-dim-label">Height (Y)</span>
                <div className="svg-input-wrap">
                  <input
                    type="number"
                    className="num"
                    min={0.001}
                    step="0.001"
                    value={heightStr}
                    onChange={(e) => handleHeightChange(e.target.value)}
                  />
                  <span className="svg-unit-tag">mm</span>
                </div>
              </div>

              <div className="svg-dim-field">
                <span className="svg-dim-label">Thickness (Z)</span>
                <div className="svg-input-wrap">
                  <input
                    type="number"
                    className="num"
                    min={0.01}
                    step="any"
                    value={thickness || ""}
                    onChange={(e) => setThickness(Math.max(0.01, Number(e.target.value)))}
                  />
                  <span className="svg-unit-tag">mm</span>
                </div>
              </div>
            </div>
          </div>

          <p className="svg-bounds-note">
            Dimensions use the visible artwork paths, not empty artboard space. Presets always scale X and Y uniformly.
          </p>

          {/* Summary Callout */}
          <div className="svg-preview-callout">
            <span className="svg-preview-tag">Extruded Volume:</span>
            <strong>{widthStr} mm × {heightStr} mm × {thickness.toFixed(2)} mm</strong>
          </div>
        </div>

        <div className="svg-import-footer">
          <button type="button" className="svg-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="svg-btn-import" onClick={handleImport}>
            Import at {widthStr} × {heightStr} mm
          </button>
        </div>
      </div>
    </div>
  );
}
