import { useEffect, useMemo, useState, useRef } from "react";
import type { SceneNode } from "../document/types";
import type { ScenePart } from "../kernel/types";
import { drawingScale, generateBlueprintData, type BlueprintData, type OrthoViewData, type BlueprintDimension, type BlueprintGeometry } from "../document/blueprint";
import { BlueprintIcon, ExportIcon } from "./icons";

/** A dimension label's badge, in drawing units. Shared by the drawing and by
 *  the fitting that frames it, so the frame always leaves room for exactly
 *  the labels that get drawn. */
function badgeSize(label: string, sf: number) {
  return { width: Math.max(24 * sf, (label.length * 3.6 + 6) * sf), height: 8 * sf };
}

/** Where a short dimension's label goes when the line is too short to break
 *  around it: lifted clear, away from the part. Zero when it fits in line. */
function labelShift(dim: BlueprintDimension, sf: number) {
  const badge = badgeSize(dim.label, sf);
  if (dim.type === "horizontal") {
    const length = Math.abs(dim.end[0] - dim.start[0]);
    return length > badge.width + 4 * sf ? 0 : Math.sign(dim.offset || 1) * badge.height * 1.1;
  }
  const length = Math.abs(dim.end[1] - dim.start[1]);
  return length > badge.height + 4 * sf ? 0 : Math.sign(dim.offset || 1) * (badge.width / 2 + 2 * sf);
}

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
function ViewCell({ title, of, view, iso, sheet, showClearances, showPartLabels, highContrast, onOpen }: {
  /** Shown in the cell header, so it stays short. */
  title: string;
  /** Which part this view belongs to, added only to the enlarged title —
   *  once a drawing fills the screen, its own header is the only label left. */
  of?: string;
  view: OrthoViewData; iso?: boolean;
  /** The sheet's orthographic views, so they share one scale in the grid. */
  sheet?: OrthoViewData[];
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
        : <ViewSvg viewData={view} sheet={sheet} showClearances={showClearances} showPartLabels={showPartLabels} highContrast={highContrast} />}
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
  // A steady line on screen whatever the part's size: each view is scaled to
  // fill its cell, so a width in drawing units drew a 20 mm part's outline
  // five times heavier than a 100 mm one's.
  return <g fill="none" stroke={highContrast?"#000":"#334155"} strokeWidth={1.25}>
    {part.edges?.length ? part.edges.map(([a,b],i)=><line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} vectorEffect="non-scaling-stroke" />)
      : <polygon points={(part.outline ?? []).map(p=>p.join(",")).join(" ")} vectorEffect="non-scaling-stroke" />}
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
  const sheet = [data.topView, data.frontView, data.sideView];
  const shared = { showClearances, showPartLabels, highContrast, onOpen };
  return (
    <div className="blueprint-sheet">
      <div className="blueprint-grid-layout">
        <ViewCell title="Top View (Plan)" view={data.topView} sheet={sheet} {...shared} />
        <ViewCell title="Isometric 3D Assembly" view={data.isoView} iso {...shared} />
        <ViewCell title="Front View (Elevation)" view={data.frontView} sheet={sheet} {...shared} />
        <ViewCell title="Right Side View (Profile)" view={data.sideView} sheet={sheet} {...shared} />
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
  const b = viewData.bounds;
  // A margin in proportion to the drawing, so a small part fills its cell as
  // a large one does (see drawingScale).
  const pad = Math.max(b.width, b.height, 1e-3) * 0.04;
  const vbWidth = b.width + pad * 2;
  const vbHeight = b.height + pad * 2;
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
/** Width and height, in drawing units, that every view of a sheet is framed to. */
interface FrameSize { width: number; height: number }

/** On-screen height of a dimension label's text, in CSS pixels. */
const LABEL_TEXT_PX = 11;

const dimensionsShown = (viewData: OrthoViewData, showClearances: boolean) =>
  viewData.dimensions.filter((d) => showClearances || d.kind !== "clearance");

/**
 * The box a view occupies at label scale sf: its drawing and every dimension
 * actually drawn beside it, labels included. Offsets are set from the part's
 * largest dimension rather than this view's, so this measures where each
 * dimension really lands instead of assuming a margin.
 */
function viewExtent(viewData: OrthoViewData, showClearances: boolean, sf: number) {
  const b = viewData.bounds;
  let left = b.minX, right = b.maxX, bottom = b.minY, top = b.maxY;
  for (const dim of dimensionsShown(viewData, showClearances)) {
    const badge = badgeSize(dim.label, sf);
    const shift = labelShift(dim, sf);
    if (dim.type === "horizontal") {
      const line = dim.start[1] + dim.offset + shift;
      const middle = (dim.start[0] + dim.end[0]) / 2;
      left = Math.min(left, dim.start[0], dim.end[0], middle - badge.width / 2);
      right = Math.max(right, dim.start[0], dim.end[0], middle + badge.width / 2);
      bottom = Math.min(bottom, dim.start[1], line - badge.height / 2);
      top = Math.max(top, dim.start[1], line + badge.height / 2);
    } else {
      const line = dim.start[0] + dim.offset + shift;
      const middle = (dim.start[1] + dim.end[1]) / 2;
      left = Math.min(left, dim.start[0], line - badge.width / 2);
      right = Math.max(right, dim.start[0], line + badge.width / 2);
      bottom = Math.min(bottom, dim.start[1], dim.end[1], middle - badge.height / 2);
      top = Math.max(top, dim.start[1], dim.end[1], middle + badge.height / 2);
    }
  }
  return { left, right, bottom, top };
}

/**
 * One frame for all the orthographic views of a sheet, big enough for the
 * largest. Cells are the same size, so an equal frame in each means an equal
 * scale: the plan, elevation and profile are drawn at one size, the way a
 * drawing sheet is, instead of each being blown up separately to fill its cell.
 */
function sheetFrame(views: OrthoViewData[], showClearances: boolean, sf: number): FrameSize {
  const extents = views.map((view) => viewExtent(view, showClearances, sf));
  const width = Math.max(...extents.map((e) => e.right - e.left));
  const height = Math.max(...extents.map((e) => e.top - e.bottom));
  const margin = Math.max(width, height) * 0.03;
  return { width: width + margin * 2, height: height + margin * 2 };
}

/**
 * Label scale that draws dimension text at LABEL_TEXT_PX on screen. Labels
 * sized in drawing units grew with the drawing — small in a sheet cell, huge
 * once enlarged. The frame depends on the labels it has to fit, so this
 * settles over a few rounds. It never goes past 1.45× the sheet's own label
 * scale, where labels would outgrow the lanes the dimensions are packed in.
 */
function screenLabelScale(views: OrthoViewData[], showClearances: boolean, base: number, px: { width: number; height: number }) {
  if (px.width < 1 || px.height < 1) return base;
  let sf = base;
  for (let round = 0; round < 4; round++) {
    const frame = sheetFrame(views, showClearances, sf);
    const unitsPerPx = Math.max(frame.width / px.width, frame.height / px.height);
    sf = Math.min(Math.max((LABEL_TEXT_PX * unitsPerPx) / 5, base * 0.05), base * 1.45);
  }
  return sf;
}

/** CSS pixel size of an element, kept current as it resizes. */
function useElementSize<T extends Element>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((old) => (Math.abs(old.width - width) < 1 && Math.abs(old.height - height) < 1 ? old : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function ViewSvg({
  viewData,
  showClearances,
  showPartLabels,
  highContrast,
  sheet,
}: {
  viewData: OrthoViewData;
  showClearances: boolean;
  showPartLabels: boolean;
  highContrast: boolean;
  /** Every orthographic view of this view's sheet, this one included, so they
   *  share one frame; without it the view fills its own space. */
  sheet?: OrthoViewData[];
}) {
  const b = viewData.bounds;
  const activeDims = dimensionsShown(viewData, showClearances);
  const [svgRef, px] = useElementSize<SVGSVGElement>();
  const views = sheet ?? [viewData];
  const sf = screenLabelScale(views, showClearances, viewData.scale ?? drawingScale(b), px);

  // Centred in the sheet's shared frame, so all its views sit at one scale.
  const extent = viewExtent(viewData, showClearances, sf);
  const frame = sheetFrame(views, showClearances, sf);
  const vbWidth = frame.width, vbHeight = frame.height;
  const centreX = (extent.left + extent.right) / 2, centreY = (extent.bottom + extent.top) / 2;
  const vbMinX = centreX - vbWidth / 2;
  // The drawing is flipped so +Y points up (see the group's transform below):
  // a drawing-space height y lands at 2·minY + height − y on the SVG canvas.
  const vbMinY = 2 * b.minY + b.height - (centreY + vbHeight / 2);
  const labelIds=new Set<string>();
  const occupied:Array<[number,number,number,number]>=[];
  for(const part of viewData.parts) {
    const width=(part.name.length*2.8+4)*sf, height=7*sf;
    if(part.rect.width<width || part.rect.height<height) continue;
    const x=part.rect.x+part.rect.width/2,y=part.rect.y+part.rect.height/2;
    const box:[number,number,number,number]=[x-width/2,y-height/2,x+width/2,y+height/2];
    if(occupied.some(b=>box[0]<b[2] && box[2]>b[0] && box[1]<b[3] && box[3]>b[1])) continue;
    occupied.push(box);labelIds.add(part.id);
  }

  return (
    <svg
      ref={svgRef}
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
                  fontSize={4.5 * sf}
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
          <DimensionLineItem key={dim.id} dim={dim} sf={sf} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Renders extension lines, dimension line, arrows, and mm label text with adaptive scaling.
 */
function DimensionLineItem({ dim, sf }: { dim: BlueprintDimension; sf: number }) {
  const isHoriz = dim.type === "horizontal";
  const [x1, y1] = dim.start;
  const [x2, y2] = dim.end;

  const fontSize = 5.0 * sf;
  const { width: badgeW, height: badgeH } = badgeSize(dim.label, sf);
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
    const gapLo = midX - badgeW / 2 - 1.5 * sf, gapHi = midX + badgeW / 2 + 1.5 * sf;
    // Too narrow to break (a 50 mm leg is thinner than "50.0 mm"): keep the
    // line whole and lift the label clear of it instead.
    const shift = labelShift(dim, sf);
    const fits = shift === 0;
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
  const gapLo = midY - badgeH / 2 - 1.5 * sf, gapHi = midY + badgeH / 2 + 1.5 * sf;
  const shift = labelShift(dim, sf);
  const fits = shift === 0;
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
      {data.partSheets.map((sheet, index) => {
        const views = [sheet.frontView, sheet.topView, sheet.sideView];
        return (
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
            <ViewCell title="Front Elevation" of={sheet.name} view={sheet.frontView} sheet={views} {...shared} />
            <ViewCell title="Top Plan" of={sheet.name} view={sheet.topView} sheet={views} {...shared} />
            <ViewCell title="Right Side Profile" of={sheet.name} view={sheet.sideView} sheet={views} {...shared} />
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
        );
      })}
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
