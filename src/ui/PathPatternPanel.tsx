import { useEffect, useMemo, useState } from "react";
import type { SceneNode, SketchData } from "../document/types";
import type { DisplayUnit } from "../measurement";
import { fromMillimetres, toMillimetres, UNIT_LABEL } from "../measurement";
import { anchor } from "../sketch/geometry";
import { pathPlacements, type PathPlacement } from "../geometry/pathPattern";
import { SketchEditor } from "./SketchEditor";
import { NodeSwatch } from "./NodeSwatch";

interface Props {
  source: SceneNode; nodes: SceneNode[]; unit: DisplayUnit; decimals: number;
  onPreview: (placements: PathPlacement[]) => void;
  onApply: (placements: PathPlacement[]) => void; onClose: () => void;
}
export function PathPatternPanel({ source, nodes, unit, decimals, onPreview, onApply, onClose }: Props) {
  const [guide, setGuide] = useState("custom");
  const [sketch, setSketch] = useState<SketchData>({ paths: [{ id: "guide", closed: false, anchors: [anchor(0,0), {...anchor(40,20), inX:-20,inY:0,outX:20,outY:0},anchor(80,0)] }] });
  const [editing, setEditing] = useState(false);
  const [pathIndex, setPathIndex] = useState(0);
  const [mode, setMode] = useState("count");
  const [count, setCount] = useState(8);
  const [spacing, setSpacing] = useState(15);
  const [follow, setFollow] = useState(false);
  const [angle, setAngle] = useState(0);
  const guides = nodes.filter(n => n.id !== source.id && n.type === "object" && n.sketch?.paths.length);
  const chosen = guides.find(n => n.id === guide);
  const data = chosen?.type === "object" ? chosen.sketch! : sketch;
  const result = useMemo(() => {
    try {
      const path = data.paths[pathIndex];
      if (!path) return { placements: [], error: "Choose a path." };
      return { placements: pathPlacements(path, { count, spacing: mode === "spacing" ? spacing : undefined, follow, angle,
        origin: chosen?.position ?? source.position, rotation: chosen?.rotation ?? [0,0,0], scale: chosen?.scale ?? [1,1,1], sourceRotation: source.rotation }), error: "" };
    } catch (e) { return { placements: [], error: (e as Error).message }; }
  }, [data, pathIndex, count, spacing, mode, follow, angle, chosen, source]);
  useEffect(() => { onPreview(editing ? [] : result.placements); }, [result, editing, onPreview]);
  useEffect(() => () => onPreview([]), [onPreview]);
  if (editing) return <SketchEditor guideOnly title="Draw a pattern guide · XY plane" applyLabel="Use guide" initial={sketch} initialDepth={1}
    initialShape={{revolve:false,angle:360,axis:0,upright:false}} displayUnit={unit} decimals={decimals} onCancel={() => setEditing(false)}
    onApply={value => { setSketch(value); setPathIndex(0); setEditing(false); }} />;
  return <section className="path-pattern-panel" role="dialog" aria-label="Along Path">
    <header><h2>Along Path</h2><button onClick={onClose} aria-label="Close path pattern">×</button></header>
    <p style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
      <span>Repeat</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <NodeSwatch node={source} size={11} />
        <strong>{source.name}</strong>
      </span>
      <span>along a 2D curve. The scene shows the result before you apply.</span>
    </p>
    <label>Guide<select value={guide} onChange={e => {setGuide(e.target.value);setPathIndex(0);}}><option value="custom">Draw a guide (XY plane)</option>{guides.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
    {guide === "custom" && <><button onClick={() => setEditing(true)}>Edit guide in Sketch</button><p>The guide’s origin is the source object’s position. Open paths are supported.</p></>}
    {data.paths.length > 1 && <label>Path<select value={pathIndex} onChange={e => setPathIndex(Number(e.target.value))}>{data.paths.map((p,i) => <option key={p.id} value={i}>Path {i+1} · {p.closed ? "closed" : "open"}</option>)}</select></label>}
    <label>Distribution<select value={mode} onChange={e => setMode(e.target.value)}><option value="count">Number of copies</option><option value="spacing">Fixed spacing</option></select></label>
    {mode === "count" ? <label>Count (including original)<input type="number" min={1} max={300} step={1} value={count} onChange={e => setCount(Number(e.target.value))}/></label>
      : <label>Spacing ({UNIT_LABEL[unit]})<input type="number" min={0.01} step="any" value={fromMillimetres(spacing,unit)} onChange={e => setSpacing(toMillimetres(Number(e.target.value),unit))}/></label>}
    <label>Orientation<select value={follow ? "follow" : "keep"} onChange={e => setFollow(e.target.value === "follow")}><option value="keep">Keep orientation</option><option value="follow">Follow path</option></select></label>
    <p>{follow ? "The object’s local X direction follows the curve. Use rotation offset to turn it sideways." : "Every copy keeps the source object’s orientation."}</p>
    <label>Rotation offset (°)<input type="number" min={-360} max={360} value={angle} onChange={e => setAngle(Number(e.target.value))}/></label>
    <p>{result.error || `${result.placements.length} objects · ${data.paths[pathIndex]?.closed ? "closed loop" : "open path"}`}</p>
    <p>Apply creates an assembly of independent copies and moves the original to the first position. Undo restores it.</p>
    <footer><button onClick={onClose}>Cancel</button><button className="primary" disabled={!result.placements.length || !Number.isFinite(angle)} onClick={() => onApply(result.placements)}>Create pattern</button></footer>
  </section>;
}
