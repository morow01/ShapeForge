import { useEffect, useMemo, useState, useRef } from "react";
import type { SceneNode } from "../document/types";
import type { ScenePart } from "../kernel/types";
import { generateBlueprintData, type BlueprintData, type OrthoViewData, type BlueprintDimension, type BlueprintGeometry } from "../document/blueprint";
import { BlueprintIcon, ExportIcon } from "./icons";

interface Props {
  open: boolean;
  projectName: string;
  nodes: SceneNode[];
  parts: ScenePart[];
  onClose: () => void;
  captureGeometry?: () => BlueprintGeometry[];
}

type TabType = "multi" | "front" | "top" | "side" | "details" | "cutlist";

/** A view the reader has asked to see full size. */
interface Enlarged { title: string; view: OrthoViewData; iso: boolean }

/**
 * One titled drawing on a sheet. Four of them share a page, so at paper size
 * each is small — clicking opens it full size, which is the only way to read a
 * 22 mm tenon on a sheet scaled to fit a 1000 mm table.
 */
function ViewCell({ title, of, view, iso, showClearances, showPartLabels, highContrast, onOpen }: {
  /** Shown in the cell header, so it stays short. */
  title: string;
  /** Which part this view belongs to, added only to the enlarged title —
   *  once a drawing fills the screen, its own header is the only label left. */
  of?: string;
  view: OrthoViewData; iso?: boolean;
  showClearances: boolean; showPartLabels: boolean; highContrast: boolean;
  onOpen: (enlarged: Enlarged) => void;
}) {
  const full = of ? `${of} — ${title}` : title;
  return (
    <button
      type="button"
      className="blueprint-grid-cell blueprint-cell-button"
      onClick={() => onOpen({ title: full, view, iso: !!iso })}
      title={`Enlarge ${full}`}
    >
      <div className="cell-header">
        {title}
        <span className="cell-zoom-hint" aria-hidden="true">⤢</span>
      </div>
      {iso
        ? <IsoSvg viewData={view} highContrast={highContrast} />
        : <ViewSvg viewData={view} showClearances={showClearances} showPartLabels={showPartLabels} highContrast={highContrast} />}
    </button>
  );
}

/** The full-size drawing, over the sheet it came from. */
function EnlargedView({ enlarged, showClearances, showPartLabels, highContrast, onClose }: {
  enlarged: Enlarged; showClearances: boolean; showPartLabels: boolean; highContrast: boolean; onClose: () => void;
}) {
  useEffect(() => {
    // Captured, so Escape closes this drawing rather than the whole blueprint.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  return (
    <div className="blueprint-zoom-backdrop" role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="blueprint-zoom-panel" role="dialog" aria-modal="true" aria-label={enlarged.title}>
        <header className="blueprint-zoom-header">
          <h4>{enlarged.title}</h4>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close enlarged view" autoFocus>×</button>
        </header>
        <div className="blueprint-zoom-body">
          {enlarged.iso
            ? <IsoSvg viewData={enlarged.view} highContrast={highContrast} />
            : <ViewSvg viewData={enlarged.view} showClearances={showClearances} showPartLabels={showPartLabels} highContrast={highContrast} />}
        </div>
      </section>
    </div>
  );
}

function ProjectedPart({part,highContrast}:{part:OrthoViewData["parts"][number];highContrast:boolean}) {
  // Boundary/crease edges preserve holes and concave profiles. They are
  // deliberately unfilled, so one component cannot hide another's outline.
  return <g fill="none" stroke={highContrast?"#000":"#334155"} strokeWidth={0.65}>
    {part.edges?.length ? part.edges.map(([a,b],i)=><line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)
      : <polygon points={(part.outline ?? []).map(p=>p.join(",")).join(" ")} />}
  </g>;
}

export function BlueprintModal({ open, projectName, nodes, parts, onClose, captureGeometry }: Props) {
  const [tab, setTab] = useState<TabType>("multi");
  const [showClearances, setShowClearances] = useState(true);
  const [showPartLabels, setShowPartLabels] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [enlarged, setEnlarged] = useState<Enlarged | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  const data: BlueprintData = useMemo(() => {
    if (!open) return null as unknown as BlueprintData;
    return generateBlueprintData(projectName, nodes, parts, captureGeometry?.());
  }, [open, projectName, nodes, parts]);

  if (!open || !data) return null;

  const handlePrint = () => {
    window.print();
  };

  const exportSheet = () => {
    const ns="http://www.w3.org/2000/svg";
    const svg=document.createElementNS(ns,"svg");
    svg.setAttribute("xmlns",ns);
    const multi=tab==='multi', drawings=Array.from(printRef.current?.querySelectorAll("svg") ?? []);
    const drawingHeight=tab==='cutlist'?0:multi?840:620;
    const height=drawingHeight+110+32*(data.cutList.length+2);
    svg.setAttribute("viewBox",`0 0 1200 ${height}`);
    svg.setAttribute("width","1200"); svg.setAttribute("height",String(height));
    svg.setAttribute("font-family","Arial, sans-serif");
    const text=(x:number,y:number,value:string,size=16)=>{
      const el=document.createElementNS(ns,"text");el.setAttribute("x",String(x));el.setAttribute("y",String(y));
      el.setAttribute("font-size",String(size));el.setAttribute("fill","#111");el.textContent=value;svg.appendChild(el);
    };
    const background=document.createElementNS(ns,"rect");
    background.setAttribute("width","1200");background.setAttribute("height",String(height));background.setAttribute("fill","white");svg.appendChild(background);
    const titles=multi?["Top View (Plan)","Isometric Assembly","Front View (Elevation)","Right Side (Profile)"]:[tab==='front'?'Front Elevation':tab==='top'?'Top Plan':'Right Side'];
    drawings.forEach((drawing,i)=>{
      const clone=drawing.cloneNode(true) as SVGSVGElement;
      const x=multi?(i%2)*600:0,y=multi?Math.floor(i/2)*420:0;
      text(x+20,y+24,titles[i] ?? '',18);
      clone.setAttribute("x",String(x+10));clone.setAttribute("y",String(y+35));
      clone.setAttribute("width",String(multi?580:1180));clone.setAttribute("height",String(multi?375:575));
      svg.appendChild(clone);
    });
    text(20,drawingHeight+30,`${data.projectName} — ${data.date}`,22);
    text(20,drawingHeight+60,`Overall: ${data.overallSize.join(' × ')} mm     Parts: ${data.parts.length}`);
    text(20,drawingHeight+96,'PART / MATERIAL');text(560,drawingHeight+96,'LENGTH × WIDTH × THICKNESS (mm)');text(1080,drawingHeight+96,'QTY');
    data.cutList.forEach((item,i)=>{
      const y=drawingHeight+128+i*32;
      text(20,y,`${item.name} / ${item.color}`);text(560,y,`${item.lengthMm} × ${item.widthMm} × ${item.thicknessMm}`);text(1100,y,String(item.count));
    });
    return svg;
  };

  const handleExportSVG = () => {
    const svgEl = exportSheet();
    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(svgEl);
    const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(projectName || "blueprint").replace(/\s+/g, "_")}_${tab}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPNG = () => {
    const svgEl = exportSheet();
    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(svgEl);
    const img = new Image();
    const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Number(svgEl.getAttribute("width"))*2;
      canvas.height = Number(svgEl.getAttribute("height"))*2;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pngUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = `${(projectName || "blueprint").replace(/\s+/g, "_")}_${tab}.png`;
      a.click();
      URL.revokeObjectURL(url);
    };
    img.onerror=()=>URL.revokeObjectURL(url);
    img.src = url;
  };

  return (
    <div className="modal-backdrop blueprint-backdrop" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <section className="blueprint-modal" role="dialog" aria-modal="true" aria-labelledby="blueprint-modal-title">
        <header className="modal-header blueprint-header">
          <div className="modal-title-group">
            <div className="blueprint-title-row">
              <BlueprintIcon className="tool-icon modal-icon" />
              <h2 id="blueprint-modal-title">2D Workshop Blueprint & Cut List</h2>
            </div>
            <p className="modal-subtitle">
              Precision orthographic projections, mm dimension lines & carpenter parts schedule
            </p>
          </div>
          <div className="blueprint-header-actions">
            <button className="btn btn-secondary" onClick={handleExportSVG} title="Export Vector SVG">
              <ExportIcon /> SVG
            </button>
            <button className="btn btn-secondary" onClick={handleExportPNG} title="Export High-Res PNG">
              PNG
            </button>
            <button className="btn btn-primary" onClick={handlePrint} title="Print / Save PDF">
              🖨️ Print Blueprint
            </button>
            <button className="modal-close-btn" onClick={onClose} aria-label="Close blueprint">×</button>
          </div>
        </header>

        {/* Tab Controls */}
        <div className="blueprint-tab-bar">
          <div className="blueprint-tabs">
            <button className={`tab-btn ${tab === "multi" ? "active" : ""}`} onClick={() => setTab("multi")}>
              📐 3-View Sheet
            </button>
            <button className={`tab-btn ${tab === "front" ? "active" : ""}`} onClick={() => setTab("front")}>
              🔍 Front Elevation
            </button>
            <button className={`tab-btn ${tab === "top" ? "active" : ""}`} onClick={() => setTab("top")}>
              🔝 Top Plan
            </button>
            <button className={`tab-btn ${tab === "side" ? "active" : ""}`} onClick={() => setTab("side")}>
              ➡️ Side Profile
            </button>
            <button className={`tab-btn ${tab === "details" ? "active" : ""}`} onClick={() => setTab("details")}>
              📄 Part Details ({data.partSheets.length})
            </button>
            <button className={`tab-btn ${tab === "cutlist" ? "active" : ""}`} onClick={() => setTab("cutlist")}>
              📋 Cut List ({data.cutList.reduce((acc, i) => acc + i.count, 0)} pcs)
            </button>
          </div>

          <div className="blueprint-toggles">
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showClearances}
                onChange={(e) => setShowClearances(e.target.checked)}
              />
              Clearances
            </label>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showPartLabels}
                onChange={(e) => setShowPartLabels(e.target.checked)}
              />
              Part Labels
            </label>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={highContrast}
                onChange={(e) => setHighContrast(e.target.checked)}
              />
              High-Contrast
            </label>
          </div>
        </div>

        {/* Blueprint Canvas Container */}
        <div className="blueprint-modal-body" ref={printRef}>
          {tab === "cutlist" ? (
            <CutListTable data={data} />
          ) : tab === "details" ? (
            <PartDetailSheets
              data={data}
              showClearances={showClearances}
              showPartLabels={showPartLabels}
              highContrast={highContrast}
              onOpen={setEnlarged}
            />
          ) : tab === "multi" ? (
            <MultiViewSheet
              data={data}
              showClearances={showClearances}
              showPartLabels={showPartLabels}
              highContrast={highContrast}
              onOpen={setEnlarged}
            />
          ) : (
            <SingleViewCanvas
              viewData={
                tab === "front" ? data.frontView :
                tab === "top" ? data.topView :
                data.sideView
              }
              showClearances={showClearances}
              showPartLabels={showPartLabels}
              highContrast={highContrast}
            />
          )}
          {tab !== "cutlist" && <div className="blueprint-print-cutlist"><CutListTable data={data} /></div>}
        </div>

        {enlarged && (
          <EnlargedView
            enlarged={enlarged}
            showClearances={showClearances}
            showPartLabels={showPartLabels}
            highContrast={highContrast}
            onClose={() => setEnlarged(null)}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Standard 3-View + Isometric Workshop Blueprint Sheet.
 */
function MultiViewSheet({
  data,
  showClearances,
  showPartLabels,
  highContrast,
  onOpen,
}: {
  data: BlueprintData;
  showClearances: boolean;
  showPartLabels: boolean;
  highContrast: boolean;
  onOpen: (enlarged: Enlarged) => void;
}) {
  const shared = { showClearances, showPartLabels, highContrast, onOpen };
  return (
    <div className="blueprint-sheet">
      <div className="blueprint-grid-layout">
        <ViewCell title="Top View (Plan)" view={data.topView} {...shared} />
        <ViewCell title="Isometric 3D Assembly" view={data.isoView} iso {...shared} />
        <ViewCell title="Front View (Elevation)" view={data.frontView} {...shared} />
        <ViewCell title="Right Side View (Profile)" view={data.sideView} {...shared} />
      </div>

      {/* Workshop Title Block */}
      <footer className="blueprint-title-block">
        <div className="tb-col tb-brand">
          <span className="tb-brand-name">ShapeForge CAD</span>
          <span className="tb-sub">Carpentry & Joinery Blueprint</span>
        </div>
        <div className="tb-col">
          <div className="tb-label">PROJECT</div>
          <div className="tb-val">{data.projectName || "Standard Assembly"}</div>
        </div>
        <div className="tb-col">
          <div className="tb-label">DIMENSIONS (W × D × H)</div>
          <div className="tb-val">{data.overallSize[0]} × {data.overallSize[1]} × {data.overallSize[2]} mm</div>
        </div>
        <div className="tb-col">
          <div className="tb-label">PARTS COUNT</div>
          <div className="tb-val">{data.parts.filter((p) => !p.isHole).length} Solid Components</div>
        </div>
        <div className="tb-col">
          <div className="tb-label">UNITS / DATE</div>
          <div className="tb-val">Metric (mm) • {data.date}</div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Single Full-Size View Canvas.
 */
function SingleViewCanvas({
  viewData,
  showClearances,
  showPartLabels,
  highContrast,
}: {
  viewData: OrthoViewData;
  showClearances: boolean;
  showPartLabels: boolean;
  highContrast: boolean;
}) {
  return (
    <div className="blueprint-single-view">
      <div className="cell-header">{viewData.title}</div>
      <ViewSvg
        viewData={viewData}
        showClearances={showClearances}
        showPartLabels={showPartLabels}
        highContrast={highContrast}
      />
    </div>
  );
}

/**
 * Isometric View SVG.
 */
function IsoSvg({
  viewData,
  highContrast,
}: {
  viewData: OrthoViewData;
  highContrast: boolean;
}) {
  const pad = 40;
  const b = viewData.bounds;
  const vbWidth = Math.max(100, b.width + pad * 2);
  const vbHeight = Math.max(100, b.height + pad * 2);
  const vbMinX = b.minX - pad;
  const vbMinY = b.minY - pad;

  return (
    <svg
      className={`blueprint-svg ${highContrast ? "high-contrast" : ""}`}
      viewBox={`${vbMinX} ${vbMinY} ${vbWidth} ${vbHeight}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <g transform={`scale(1, -1) translate(0, ${-(b.minY * 2 + b.height)})`}>
        {viewData.parts.map(p=><ProjectedPart key={p.id} part={p} highContrast={highContrast} />)}      </g>
    </svg>
  );
}

/**
 * Orthographic View SVG with Dimensions (matching user sketch media_1789324562864.png).
 */
function ViewSvg({
  viewData,
  showClearances,
  showPartLabels,
  highContrast,
}: {
  viewData: OrthoViewData;
  showClearances: boolean;
  showPartLabels: boolean;
  highContrast: boolean;
}) {
  const b = viewData.bounds;

  // Filter dimensions
  const activeDims = viewData.dimensions.filter((d) => {
    if (!showClearances && d.kind === "clearance") return false;
    return true;
  });

  // Room for the drawing *and* the dimensions standing off it. Offsets are
  // set from the part's largest dimension, not this view's, so a long leg's
  // 50 x 50 plan gets rails further out than its own span would suggest —
  // sizing the padding from the span alone crops the numbers off the sheet.
  const span = Math.max(b.width, b.height);
  const sf = Math.max(0.6, Math.min(3, Math.max(20, span) / 100));
  // A full label width, not half: a dimension too short to break around its
  // label moves the label clear of the line (see DimensionLineItem), which
  // carries it a further half-width outward — a 13 mm pocket depth lost its
  // "mm" off the frame edge when only the half was allowed for.
  const reach = activeDims.reduce((furthest, d) =>
    Math.max(furthest, Math.abs(d.offset) + (d.label.length * 3.6 + 6) * sf + 2 * sf), 0);
  const pad = Math.max(45, span * 0.35 + 18, reach + 10 * sf);
  const vbWidth = Math.max(80, b.width + pad * 2);
  const vbHeight = Math.max(80, b.height + pad * 2);
  const vbMinX = b.minX - pad;
  const vbMinY = b.minY - pad;
  const labelIds=new Set<string>();
  const occupied:Array<[number,number,number,number]>=[];
  for(const part of viewData.parts) {
    const width=part.name.length*2.8+4, height=7;
    if(part.rect.width<width || part.rect.height<height) continue;
    const x=part.rect.x+part.rect.width/2,y=part.rect.y+part.rect.height/2;
    const box:[number,number,number,number]=[x-width/2,y-height/2,x+width/2,y+height/2];
    if(occupied.some(b=>box[0]<b[2] && box[2]>b[0] && box[1]<b[3] && box[3]>b[1])) continue;
    occupied.push(box);labelIds.add(part.id);
  }

  return (
    <svg
      className={`blueprint-svg ${highContrast ? "high-contrast" : ""}`}
      viewBox={`${vbMinX} ${vbMinY} ${vbWidth} ${vbHeight}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* Engineering Arrowhead definition */}
        <marker
          id="arrow-end"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,1 L5,3 L0,5 Z" fill="#64748b" />
        </marker>
        <marker
          id="arrow-start"
          markerWidth="6"
          markerHeight="6"
          refX="1"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M5,1 L0,3 L5,5 Z" fill="#64748b" />
        </marker>
      </defs>

      {/* Invert Y coordinate so 0,0 is at bottom left */}
      <g transform={`scale(1, -1) translate(0, ${-(b.minY * 2 + b.height)})`}>
        {/* Parts Rectangles */}
        {viewData.parts.map((p) => {

          return (
            <g key={p.id} className="blueprint-part-group">
              <ProjectedPart part={p} highContrast={highContrast} />
              {showPartLabels && labelIds.has(p.id) && (
                <text
                  x={p.rect.x + p.rect.width / 2}
                  y={-(p.rect.y + p.rect.height / 2)}
                  transform="scale(1, -1)"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="4.5"
                  fill="#1e293b"
                  fontWeight="600"
                  style={{ pointerEvents: "none" }}
                >
                  {p.name}
                </text>
              )}
            </g>
          );
        })}

        {/* Dimension Lines */}
        {activeDims.map((dim) => (
          <DimensionLineItem key={dim.id} dim={dim} bounds={b} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Renders extension lines, dimension line, arrows, and mm label text with adaptive scaling.
 */
function DimensionLineItem({ dim, bounds }: { dim: BlueprintDimension; bounds: { width: number; height: number } }) {
  const isHoriz = dim.type === "horizontal";
  const [x1, y1] = dim.start;
  const [x2, y2] = dim.end;

  const maxSpan = Math.max(20, Math.max(bounds.width, bounds.height));
  const sf = Math.max(0.6, Math.min(3.0, maxSpan / 100));

  const fontSize = 5.0 * sf;
  const badgeW = Math.max(24 * sf, (dim.label.length * 3.6 + 6) * sf);
  const badgeH = 8.0 * sf;
  const strokeW = 0.65 * sf;
  const arrowL = 4.5 * sf;
  const arrowW = 2.4 * sf;

  if (isHoriz) {
    const dimY = y1 + dim.offset;
    const midX = (x1 + x2) / 2;
    const dir = Math.sign(x2 - x1) || 1;
    // Drafting convention: the dimension line stops either side of its own
    // label rather than running behind it. An opaque badge alone still shows
    // the line through its edges at print resolution.
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    const fits = hi - lo > badgeW + 4 * sf;
    const gapLo = midX - badgeW / 2 - 1.5 * sf, gapHi = midX + badgeW / 2 + 1.5 * sf;
    // Too narrow to break (a 50 mm leg is thinner than "50.0 mm"): keep the
    // line whole and lift the label clear of it instead.
    const shift = fits ? 0 : Math.sign(dim.offset || 1) * badgeH * 1.1;
    return (
      <g className={`dimension-line-item ${dim.kind}`}>
        {/* Extension lines from workpiece to dimension line */}
        {dim.offset !== 0 && (
          <>
            <line
              x1={x1}
              y1={y1 + Math.sign(dim.offset) * 2 * sf}
              x2={x1}
              y2={dimY + Math.sign(dim.offset) * 3 * sf}
              stroke="#94a3b8"
              strokeWidth={0.5 * sf}
              strokeDasharray={`${1.5 * sf},${1.5 * sf}`}
            />
            <line
              x1={x2}
              y1={y2 + Math.sign(dim.offset) * 2 * sf}
              x2={x2}
              y2={dimY + Math.sign(dim.offset) * 3 * sf}
              stroke="#94a3b8"
              strokeWidth={0.5 * sf}
              strokeDasharray={`${1.5 * sf},${1.5 * sf}`}
            />
          </>
        )}

        {/* Dimension Line, broken either side of the label */}
        {fits ? (
          <>
            <line x1={lo} y1={dimY} x2={gapLo} y2={dimY} stroke="#475569" strokeWidth={strokeW} />
            <line x1={gapHi} y1={dimY} x2={hi} y2={dimY} stroke="#475569" strokeWidth={strokeW} />
          </>
        ) : (
          <line x1={lo} y1={dimY} x2={hi} y2={dimY} stroke="#475569" strokeWidth={strokeW} />
        )}

        {/* Start Arrow */}
        <polygon
          points={`${x1},${dimY} ${x1 + dir * arrowL},${dimY + arrowW} ${x1 + dir * arrowL},${dimY - arrowW}`}
          fill="#475569"
        />

        {/* End Arrow */}
        <polygon
          points={`${x2},${dimY} ${x2 - dir * arrowL},${dimY + arrowW} ${x2 - dir * arrowL},${dimY - arrowW}`}
          fill="#475569"
        />

        {/* Text Badge (flipped upright) */}
        <g transform={`translate(${midX}, ${dimY + shift}) scale(1, -1)`}>
          <rect
            x={-badgeW / 2}
            y={-badgeH / 2}
            width={badgeW}
            height={badgeH}
            fill="#ffffff"
            stroke="#cbd5e1"
            strokeWidth={0.4 * sf}
            rx={1.5 * sf}
          />
          <text
            x={0}
            y={0}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={fontSize}
            fill="#0f172a"
            fontWeight="600"
            fontFamily="system-ui, -apple-system, sans-serif"
          >
            {dim.label}
          </text>
        </g>
      </g>
    );
  }

  // Vertical Dimension
  const dimX = x1 + dim.offset;
  const midY = (y1 + y2) / 2;
  const dir = Math.sign(y2 - y1) || 1;
  const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
  const fits = hi - lo > badgeH + 4 * sf;
  const gapLo = midY - badgeH / 2 - 1.5 * sf, gapHi = midY + badgeH / 2 + 1.5 * sf;
  const shift = fits ? 0 : Math.sign(dim.offset || 1) * (badgeW / 2 + 2 * sf);
  return (
    <g className={`dimension-line-item ${dim.kind}`}>
      {/* Extension lines */}
      {dim.offset !== 0 && (
        <>
          <line
            x1={x1 + Math.sign(dim.offset) * 2 * sf}
            y1={y1}
            x2={dimX + Math.sign(dim.offset) * 3 * sf}
            y2={y1}
            stroke="#94a3b8"
            strokeWidth={0.5 * sf}
            strokeDasharray={`${1.5 * sf},${1.5 * sf}`}
          />
          <line
            x1={x2 + Math.sign(dim.offset) * 2 * sf}
            y1={y2}
            x2={dimX + Math.sign(dim.offset) * 3 * sf}
            y2={y2}
            stroke="#94a3b8"
            strokeWidth={0.5 * sf}
            strokeDasharray={`${1.5 * sf},${1.5 * sf}`}
          />
        </>
      )}

      {/* Dimension Line, broken either side of the label */}
      {fits ? (
        <>
          <line x1={dimX} y1={lo} x2={dimX} y2={gapLo} stroke="#475569" strokeWidth={strokeW} />
          <line x1={dimX} y1={gapHi} x2={dimX} y2={hi} stroke="#475569" strokeWidth={strokeW} />
        </>
      ) : (
        <line x1={dimX} y1={lo} x2={dimX} y2={hi} stroke="#475569" strokeWidth={strokeW} />
      )}

      {/* Start Arrow */}
      <polygon
        points={`${dimX},${y1} ${dimX + arrowW},${y1 + dir * arrowL} ${dimX - arrowW},${y1 + dir * arrowL}`}
        fill="#475569"
      />

      {/* End Arrow */}
      <polygon
        points={`${dimX},${y2} ${dimX + arrowW},${y2 - dir * arrowL} ${dimX - arrowW},${y2 - dir * arrowL}`}
        fill="#475569"
      />

      {/* Text Badge */}
      <g transform={`translate(${dimX + shift}, ${midY}) scale(1, -1)`}>
        <rect
          x={-badgeW / 2}
          y={-badgeH / 2}
          width={badgeW}
          height={badgeH}
          fill="#ffffff"
          stroke="#cbd5e1"
          strokeWidth={0.4 * sf}
          rx={1.5 * sf}
        />
        <text
          x={0}
          y={0}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fill="#0f172a"
          fontWeight="600"
          fontFamily="system-ui, -apple-system, sans-serif"
        >
          {dim.label}
        </text>
      </g>
    </g>
  );
}

/**
 * One page per distinct element: the part on its own, dimensioned, with the
 * quantity and stock it is cut from. Each page breaks onto its own sheet when
 * printed, so the bench gets a drawing per piece rather than one crowded
 * assembly view to squint at.
 */
function PartDetailSheets({ data, showClearances, showPartLabels, highContrast, onOpen }: {
  data: BlueprintData;
  showClearances: boolean;
  showPartLabels: boolean;
  highContrast: boolean;
  onOpen: (enlarged: Enlarged) => void;
}) {
  if (!data.partSheets.length) {
    return <div className="cutlist-sheet"><p className="cutlist-sub">No elements to detail — add a shape to the design.</p></div>;
  }
  const shared = { showClearances, showPartLabels, highContrast, onOpen };
  return (
    <div className="part-detail-stack">
      {data.partSheets.map((sheet, index) => (
        <section className="part-detail-page" key={sheet.id}>
          <header className="part-detail-header">
            <div className="pd-identity">
              <div className="pd-index">Part {index + 1} of {data.partSheets.length}</div>
              <h3>{sheet.name}</h3>
              <div className="pd-kind">{sheet.kind}</div>
            </div>
            <div className="pd-qty">
              <span className="pd-qty-value">{sheet.count}×</span>
              <span className="pd-qty-label">required</span>
            </div>
          </header>

          <div className="part-detail-grid">
            <ViewCell title="Front Elevation" of={sheet.name} view={sheet.frontView} {...shared} />
            <ViewCell title="Top Plan" of={sheet.name} view={sheet.topView} {...shared} />
            <ViewCell title="Right Side Profile" of={sheet.name} view={sheet.sideView} {...shared} />
            <ViewCell title="Isometric" of={sheet.name} view={sheet.isoView} iso {...shared} />
          </div>

          <footer className="part-detail-specs">
            <div className="pd-spec"><span className="tb-label">LENGTH</span><span className="tb-val">{sheet.lengthMm} mm</span></div>
            <div className="pd-spec"><span className="tb-label">WIDTH</span><span className="tb-val">{sheet.widthMm} mm</span></div>
            <div className="pd-spec"><span className="tb-label">THICKNESS</span><span className="tb-val">{sheet.thicknessMm} mm</span></div>
            <div className="pd-spec"><span className="tb-label">MATERIAL</span>
              <span className="tb-val color-swatch-cell"><span className="color-dot" style={{ backgroundColor: sheet.color }} />{sheet.color}</span>
            </div>
            <div className="pd-spec"><span className="tb-label">PROJECT</span><span className="tb-val">{data.projectName}</span></div>
          </footer>
        </section>
      ))}
    </div>
  );
}

/**
 * Cut List & Parts Breakdown Table.
 */
function CutListTable({ data }: { data: BlueprintData }) {
  const totalCount = data.cutList.reduce((acc, item) => acc + item.count, 0);

  return (
    <div className="cutlist-sheet">
      <div className="cutlist-header-row">
        <div>
          <h3>Carpenter's Cut List & Bill of Materials</h3>
          <p className="cutlist-sub">
            Dimensions sorted by: <strong>Length × Width × Thickness (mm)</strong>
          </p>
        </div>
        <div className="cutlist-summary-badge">
          Total Components: <strong>{totalCount} pieces</strong>
        </div>
      </div>

      <table className="cutlist-table">
        <thead>
          <tr>
            <th>Part Description</th>
            <th>Type / Kind</th>
            <th className="num-col">Qty</th>
            <th className="num-col">Length (mm)</th>
            <th className="num-col">Width (mm)</th>
            <th className="num-col">Thick (mm)</th>
            <th>Color / Material</th>
          </tr>
        </thead>
        <tbody>
          {data.cutList.map((item, idx) => (
            <tr key={item.id || idx}>
              <td className="font-semibold">{item.name}</td>
              <td className="text-muted">{item.kind}</td>
              <td className="num-col font-bold">
                <span className="qty-pill">{item.count}×</span>
              </td>
              <td className="num-col">{item.lengthMm} mm</td>
              <td className="num-col">{item.widthMm} mm</td>
              <td className="num-col">{item.thicknessMm} mm</td>
              <td>
                <span className="color-swatch-cell">
                  <span className="color-dot" style={{ backgroundColor: item.color }} />
                  {item.color}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
