import { useEffect, useMemo, useState } from "react";
import type { LocalFontData } from "../text/systemFonts";

export interface TextConfig { text: string; font: LocalFontData; size: number; thickness: number }

export function TextModal({ fonts, onClose, onCreate, onPickFile }: {
  fonts: LocalFontData[];
  onClose: () => void;
  onCreate: (config: TextConfig) => void;
  /** Opens the font-file picker. Only route to a font in a browser without
   *  queryLocalFonts, which is every browser except Chrome and Edge. */
  onPickFile: () => void;
}) {
  const [text, setText] = useState("Text");
  const [fontIndex, setFontIndex] = useState(0);
  const [size, setSize] = useState(20);
  const [thickness, setThickness] = useState(2);
  const families = useMemo(() => fonts.map((font, index) => ({ font, index })), [fonts]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="modal-backdrop">
    <div className="projects-modal text-modal" role="dialog" aria-modal="true" aria-labelledby="text-title">
      <div className="modal-header"><div className="modal-title-group"><h2 id="text-title">Add 3D Text</h2><span className="modal-subtitle">{"queryLocalFonts" in window ? "Using fonts installed on this computer" : fonts.length ? "Using the font files you opened" : "Open a font file to get started"}</span></div><button className="modal-close-btn" onClick={onClose}>✕</button></div>
      <div className="text-modal-body">
        <label className="field"><span className="field-label">Text</span><input autoFocus className="name" value={text} onChange={(e) => setText(e.target.value)} /></label>
        {fonts.length === 0
          ? <div className="field">
              <span className="field-label">Font</span>
              {/* Firefox and Safari have no way to list installed fonts, so
                  there is nothing to put in a dropdown. Say that here rather
                  than throwing an OS file dialog at the user unannounced. */}
              <p className="modal-subtitle">This browser cannot list your installed fonts — only Chrome and Edge can. Open a font file instead.</p>
              <button className="modal-btn" onClick={onPickFile}>Choose a font file…</button>
            </div>
          : <label className="field"><span className="field-label">Font</span><select className="num" value={fontIndex} onChange={(e) => setFontIndex(Number(e.target.value))}>{families.map(({font,index}) => <option key={`${font.postscriptName}-${index}`} value={index}>{font.fullName}</option>)}</select>{!("queryLocalFonts" in window) && <button className="modal-btn" onClick={onPickFile}>Add another font file…</button>}</label>}
        <div className="row"><label className="field"><span className="field-label">Text size</span><input className="num" type="number" min="1" step="1" value={size} onChange={(e) => setSize(Number(e.target.value))} /></label><label className="field"><span className="field-label">Thickness</span><input className="num" type="number" min="0.1" step="0.5" value={thickness} onChange={(e) => setThickness(Number(e.target.value))} /></label></div>
        <div className="text-preview" style={{fontFamily: fonts[fontIndex]?.family}}>{text || "Text"}</div>
      </div>
      <div className="svg-import-footer"><button className="svg-btn-cancel" onClick={onClose}>Cancel</button><button className="svg-btn-import" disabled={!text.trim() || !fonts[fontIndex]} onClick={() => onCreate({text: text.trim(), font: fonts[fontIndex], size: Math.max(1,size), thickness: Math.max(.1,thickness)})}>Add Text</button></div>
    </div>
  </div>;
}
