import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import ManifoldModule from 'manifold-3d';
import OpenCascade from 'replicad-opencascadejs';
import {MeshShape,getManifold,setManifold,setOC} from 'replicad';
setOC(await OpenCascade());
const m=await ManifoldModule(); m.setup(); setManifold(m);
const load=(file,names,deps={})=>{
  const source=readFileSync(new URL(file,import.meta.url),'utf8').replace(/^import [\s\S]*?;\r?\n/gm,'').replaceAll('export ','');
  const js=ts.transpile(source,{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None});
  return new Function(...Object.keys(deps),`${js};return {${names.join(',')}};`)(...Object.values(deps));
};
const g=load('../src/sketch/geometry.ts',['mergeAnchors','breakPath','linkHandles','convertAnchor','anchor','insertAnchor','segmentCubic','cubicPoint','nearestOnCubic','sketchCommands','sketchBounds','pathArea','parseSketch','splitCubic']);
const {svgMeshSolid,svgRevolveSolid}=load('../src/kernel/svgSolid.ts',['svgMeshSolid','svgRevolveSolid'],{getManifold,MeshShape});
const near=(a,b,tol=1e-6)=>assert.ok(Math.abs(a-b)<=tol,`${a} ≈ ${b}`);

// A square drawn with the Pen: four corners, closed.
const square=(id,x0,y0,s)=>({id,closed:true,anchors:[g.anchor(x0,y0),g.anchor(x0+s,y0),g.anchor(x0+s,y0+s),g.anchor(x0,y0+s)]});
const outer=square('outer',0,0,40), inner=square('inner',10,10,20);
near(Math.abs(g.pathArea(outer)),1600,1e-9);

// Straight segments become L commands; the path closes back on its start.
const [cmds]=g.sketchCommands({paths:[outer]});
assert.deepEqual(cmds.map(c=>c[0]),['M','L','L','L','L']);
assert.deepEqual(cmds.at(-1),['L',0,0]);

// Open paths are not extruded.
assert.deepEqual(g.sketchCommands({paths:[{...outer,closed:false}]}),[]);

// A path inside another is a hole: 40×40 minus 20×20, 5 mm tall.
const holed=svgMeshSolid(g.sketchCommands({paths:[outer,inner]}),5);
near(holed.wrapped.volume(),(1600-400)*5,1e-6);
// Two separate shapes both extrude.
const apart=svgMeshSolid(g.sketchCommands({paths:[outer,square('b',60,0,10)]}),2);
near(apart.wrapped.volume(),(1600+100)*2,1e-6);

// Adding an anchor on a curve keeps its shape exactly.
const k=0.5523;
const circle={id:'c',closed:true,anchors:[
  {x:10,y:0,inX:0,inY:-10*k,outX:0,outY:10*k,mode:'smooth'},
  {x:0,y:10,inX:10*k,inY:0,outX:-10*k,outY:0,mode:'smooth'},
  {x:-10,y:0,inX:0,inY:10*k,outX:0,outY:-10*k,mode:'smooth'},
  {x:0,y:-10,inX:-10*k,inY:0,outX:10*k,outY:0,mode:'smooth'},
]};
const split=g.insertAnchor(circle,0,0.3);
assert.equal(split.anchors.length,5);
assert.equal(split.anchors[1].mode,'smooth','anchor added on a curve is smooth');
const original=g.segmentCubic(circle,0);
for(const t of [0.1,0.25]) {
  const p=g.cubicPoint(original,t), q=g.cubicPoint(g.segmentCubic(split,0),t/0.3);
  near(p[0],q[0],1e-9); near(p[1],q[1],1e-9);
}
for(const t of [0.5,0.9]) {
  const p=g.cubicPoint(original,t), q=g.cubicPoint(g.segmentCubic(split,1),(t-0.3)/0.7);
  near(p[0],q[0],1e-9); near(p[1],q[1],1e-9);
}
// Curves are extruded as curves: a Bézier circle of radius 10 is close to π·r².
const disc=svgMeshSolid(g.sketchCommands({paths:[circle]}),1);
assert.ok(Math.abs(disc.wrapped.volume()-Math.PI*100)<1.5,`circle area ${disc.wrapped.volume()}`);

// Adding an anchor on a straight segment puts a corner on the line.
// The anchor lands where the click was, as the editor finds it (nearest point
// on the segment) — on straight segments too, where t is not spread evenly.
for(const clickX of [3,10,31]) {
  const {t}=g.nearestOnCubic(g.segmentCubic(outer,0),[clickX,0.4]);
  const onLine=g.insertAnchor(outer,0,t);
  near(onLine.anchors[1].x,clickX,1e-3); near(onLine.anchors[1].y,0,1e-9);
  assert.equal(onLine.anchors[1].mode,'corner');
}
// Same for a curve: the new anchor sits on the nearest point to the click.
{
  const seg=g.segmentCubic(circle,1), target=g.cubicPoint(seg,0.7);
  const {t,point}=g.nearestOnCubic(seg,[target[0]+0.05,target[1]+0.05]);
  const added=g.insertAnchor(circle,1,t).anchors[2];
  near(added.x,point[0],1e-9); near(added.y,point[1],1e-9);
}

// Nearest point finds the grabbed spot on a curve.
const hit=g.nearestOnCubic(original,g.cubicPoint(original,0.62));
near(hit.t,0.62,1e-3); assert.ok(hit.distance<1e-3,`distance ${hit.distance}`);

// Bounds follow the curve, not the handles.
const b=g.sketchBounds({paths:[circle]});
near(b.maxX,10,1e-9); near(b.maxY,10,0.01);

// Saved sketches load back, dropping malformed anchors.
const parsed=g.parseSketch({paths:[{id:'p',closed:true,anchors:[{x:0,y:0},{x:'bad',y:1},{x:5,y:0,outX:2},{x:5,y:5,mode:'smooth'}]},{anchors:[]}]});
assert.equal(parsed.paths.length,1);
assert.equal(parsed.paths[0].anchors.length,3);
assert.deepEqual(parsed.paths[0].anchors[1],{x:5,y:0,inX:0,inY:0,outX:2,outY:0,mode:'corner'});
assert.equal(g.parseSketch(null),undefined);
assert.equal(g.parseSketch({paths:[{anchors:[{x:0,y:0,smooth:true},{x:1,y:0}]}]}).paths[0].anchors[0].mode,'smooth','older saves keep smooth anchors');

// Anchor types: dragging one handle moves the other by the anchor's rule.
const base={x:0,y:0,inX:-2,inY:0,outX:6,outY:0};
const dragged=(mode)=>g.linkHandles({...base,mode,outX:0,outY:4},'out');
assert.deepEqual([dragged('corner').inX,dragged('corner').inY],[-2,0],'corner leaves the other handle');
near(dragged('smooth').inX,0); near(dragged('smooth').inY,-2); // in line, own length 2
near(dragged('symmetric').inX,0); near(dragged('symmetric').inY,-4); // mirrored, same length 4

// Converting: symmetric lines up and evens the handles; corner removes them.
const bent={id:'b',closed:false,anchors:[g.anchor(-10,0),{x:0,y:0,inX:-2,inY:-2,outX:6,outY:0,mode:'corner'},g.anchor(10,0)]};
const sym=g.convertAnchor(bent,1,'symmetric');
near(Math.hypot(sym.inX,sym.inY),Math.hypot(sym.outX,sym.outY)); near(sym.inX,-sym.outX); near(sym.inY,-sym.outY);
const smooth=g.convertAnchor(bent,1,'smooth');
near(smooth.inX*smooth.outY-smooth.inY*smooth.outX,0,1e-9); // collinear
near(Math.hypot(smooth.outX,smooth.outY),6); // own length kept
// Smooth or symmetric to corner keeps the handles, so the shape stays as it is.
const corner=g.convertAnchor({...bent,anchors:[bent.anchors[0],sym,bent.anchors[2]]},1,'corner');
assert.deepEqual([corner.inX,corner.inY,corner.outX,corner.outY,corner.mode],[sym.inX,sym.inY,sym.outX,sym.outY,'corner']);
// …and from then on its handles move independently.
const bentCorner=g.linkHandles({...corner,outX:0,outY:5},'out');
assert.deepEqual([bentCorner.inX,bentCorner.inY],[sym.inX,sym.inY]);
const fresh=g.convertAnchor(bent,1,'symmetric');
assert.equal(fresh.mode,'symmetric');
const plain=g.convertAnchor({...bent,anchors:[g.anchor(-9,0),g.anchor(0,0),g.anchor(9,0)]},1,'symmetric');
near(plain.outX,3); near(plain.inX,-3); // a third of the way to each neighbour
// Splitting next to a symmetric anchor leaves it smooth.
const symCircle={...circle,anchors:circle.anchors.map(a=>({...a,mode:'symmetric'}))};
assert.equal(g.insertAnchor(symCircle,0,0.3).anchors[0].mode,'smooth');

// Quality: segments per curve set the polygon count; straight edges stay single.
const countOf=(segments)=>{
  const solid=svgMeshSolid(g.sketchCommands({paths:[circle]}),1,undefined,segments);
  return solid.wrapped.numTri();
};
const low=countOf(6), high=countOf(64);
assert.ok(low<high/5,`low ${low} vs high ${high}`);
near(svgMeshSolid(g.sketchCommands({paths:[circle]}),1,undefined,64).wrapped.volume(),Math.PI*100,0.6);
// Scissors: cutting a closed path at an anchor opens it there, with two ends
// on top of each other that each keep their own side's handle.
let ids=0; const newId=()=>`piece${++ids}`;
const [opened,...extra]=g.breakPath(circle,[1],newId);
assert.equal(extra.length,0); assert.equal(opened.id,'c'); assert.equal(opened.closed,false);
assert.equal(opened.anchors.length,5);
const [startEnd,finishEnd]=[opened.anchors[0],opened.anchors.at(-1)];
assert.deepEqual([startEnd.x,startEnd.y],[finishEnd.x,finishEnd.y]);
assert.deepEqual([startEnd.inX,startEnd.inY,startEnd.outX,startEnd.outY],[0,0,circle.anchors[1].outX,circle.anchors[1].outY]);
assert.deepEqual([finishEnd.inX,finishEnd.inY,finishEnd.outX,finishEnd.outY],[circle.anchors[1].inX,circle.anchors[1].inY,0,0]);
// The outline is unchanged: every original segment is still there.
for(let i=0;i<4;i++) assert.deepEqual(g.segmentCubic(opened,i),g.segmentCubic(circle,(i+1)%4));
// Cutting an open path inside splits it in two; its ends cannot be cut.
const line={id:'l',closed:false,anchors:[g.anchor(0,0),g.anchor(10,0),g.anchor(20,0)]};
const halves=g.breakPath(line,[1],newId);
assert.deepEqual(halves.map(p=>p.anchors.map(a=>a.x)),[[0,10],[10,20]]);
assert.deepEqual(halves.map(p=>p.id),['l','piece1']);
assert.equal(g.breakPath(line,[0],newId)[0],line);
// Two cuts in a closed square give two open pieces.
const twoCuts=g.breakPath(outer,[0,2],newId);
assert.deepEqual(twoCuts.map(p=>p.anchors.map(a=>[a.x,a.y])),[[[0,0],[40,0],[40,40]],[[40,40],[0,40],[0,0]]]);
// Merging two anchors: they meet halfway and become one corner that keeps
// the handle on each side.
const ref=(p,i)=>({pathId:p.id,index:i});
const wavy={id:'w',closed:false,anchors:[g.anchor(0,0),{x:10,y:0,inX:-2,inY:1,outX:0,outY:0,mode:'smooth'},{x:12,y:4,inX:0,inY:0,outX:3,outY:3,mode:'smooth'},g.anchor(20,0)]};
const collapsed=g.mergeAnchors([wavy],ref(wavy,1),ref(wavy,2));
assert.deepEqual(collapsed.merged,{pathId:'w',index:1});
assert.deepEqual(collapsed.paths[0].anchors[1],{x:11,y:2,inX:-2,inY:1,outX:3,outY:3,mode:'corner'});
assert.equal(collapsed.paths[0].anchors.length,3);
// Selection order does not matter.
assert.deepEqual(g.mergeAnchors([wavy],ref(wavy,2),ref(wavy,1)).paths,collapsed.paths);
// The two ends of an open path close it.
const u={id:'u',closed:false,anchors:[g.anchor(0,0),g.anchor(0,10),g.anchor(10,10),g.anchor(10,1)]};
const closedU=g.mergeAnchors([u],ref(u,0),ref(u,3));
assert.equal(closedU.paths[0].closed,true);
assert.deepEqual(closedU.paths[0].anchors.map(a=>[a.x,a.y]),[[5,0.5],[0,10],[10,10]]);
// Ends of two separate open paths join into one path, whichever ends are picked.
const left={id:'L',closed:false,anchors:[g.anchor(0,0),g.anchor(10,0)]};
const right={id:'R',closed:false,anchors:[g.anchor(20,0),g.anchor(12,2)]};
const joinedLR=g.mergeAnchors([left,right],ref(left,1),ref(right,1));
assert.equal(joinedLR.paths.length,1);
assert.deepEqual(joinedLR.paths[0].anchors.map(a=>[a.x,a.y]),[[0,0],[11,1],[20,0]]);
assert.deepEqual(joinedLR.merged,{pathId:'L',index:1});
const joinedFromStart=g.mergeAnchors([left,right],ref(left,0),ref(right,0));
assert.deepEqual(joinedFromStart.paths[0].anchors.map(a=>[a.x,a.y]),[[10,0],[10,0],[12,2]]); // left reversed, joined at its start
// A cut closed path rejoins across the cut.
const reclosed=g.mergeAnchors([opened],ref(opened,0),ref(opened,4));
assert.equal(reclosed.paths[0].closed,true);
assert.equal(reclosed.paths[0].anchors.length,4);
for(let i=0;i<4;i++) {
  const [p0,,,p1]=g.segmentCubic(reclosed.paths[0],i);
  assert.ok(p0.every(Number.isFinite)&&p1.every(Number.isFinite));
}
near(Math.abs(g.pathArea(reclosed.paths[0])),Math.abs(g.pathArea(circle)),1e-9);
// Neighbours across a closed path's closing segment.
const squareMerged=g.mergeAnchors([outer],ref(outer,0),ref(outer,3));
assert.deepEqual(squareMerged.paths[0].anchors.map(a=>[a.x,a.y]),[[0,20],[40,0],[40,40]]);
// Middles of different paths, or non-neighbours, cannot merge.
assert.equal(g.mergeAnchors([wavy,u],ref(wavy,1),ref(u,1)),null);
assert.equal(g.mergeAnchors([outer],ref(outer,0),ref(outer,2)),null);

// Revolve: spun around the sketch's own axes. A partial turn starts at the
// drawn profile and sweeps out of the sketch plane (+Z); upright puts the axis
// along +Z resting on z = 0.
const rect=(x0,y0,x1,y1)=>[[['M',x0,y0],['L',x1,y0],['L',x1,y1],['L',x0,y1],['L',x0,y0]]];
const revolved=(paths,o)=>svgRevolveSolid(paths,{curveSamples:8,circularSegments:96,...o}).wrapped;
const box=(solid)=>{const b=solid.boundingBox(); return [...b.min,...b.max].map(v=>Math.round(v*100)/100+0);};
const ring=Math.PI*(100-25)*20;
assert.deepEqual(box(revolved(rect(5,0,10,20),{angle:90,axis:0,upright:false})),[0,0,0,10,20,10],'vertical axis, quarter turn out of the plane');
assert.deepEqual(box(revolved(rect(-10,0,-5,20),{angle:90,axis:0,upright:false})),[-10,0,0,0,20,10],'drawn left of the axis');
assert.deepEqual(box(revolved(rect(0,5,20,10),{angle:90,axis:1,upright:false})),[0,0,0,20,10,10],'horizontal axis');
assert.deepEqual(box(revolved(rect(0,-10,20,-5),{angle:90,axis:1,upright:false})),[0,-10,0,20,0,10],'drawn below the axis');
assert.deepEqual(box(revolved(rect(5,3,10,23),{angle:360,axis:0,upright:true})),[-10,-10,0,10,10,20],'upright rests on the plate');
const full=revolved(rect(5,0,10,20),{angle:360,axis:0,upright:false});
// Partial turns keep the same angular resolution, plus four end-cap triangles.
for (const angle of [45,90,180]) {
  const partial=revolved(rect(5,0,10,20),{angle,axis:0,upright:false});
  assert.equal(partial.numTri(),full.numTri()*angle/360+4,`${angle}° triangle count scales with sweep`);
  near(partial.volume(),full.volume()*angle/360,1e-6);
}
const tiny=revolved(rect(5,0,10,20),{angle:1,axis:0,upright:false});
assert.ok(tiny.volume()>0 && tiny.numTri()<full.numTri()/8,'tiny sweeps stay valid and economical');
assert.ok(Math.abs(full.volume()-ring)/ring<0.002,'full turn volume '+full.volume());
assert.throws(()=>revolved(rect(-5,0,10,20),{angle:360,axis:0,upright:false}),/crosses the revolve axis/);
// Touching the axis gives a solid (a cylinder here), not an error.
const solidCylinder=revolved(rect(0,0,10,20),{angle:360,axis:0,upright:true});
assert.ok(Math.abs(solidCylinder.volume()-Math.PI*100*20)/(Math.PI*2000)<0.002);
console.log('Sketch: closed paths extrude, holes cut, curves split exactly, anchor types, quality, scissors, merge, revolve, saved sketches load passed');

// Snapping uses interior curve extrema and translates whole paths rigidly.
const snapGeometry=load('../src/sketch/geometry.ts',['snapShapeToAxis','sampled']);
const bulge={id:'bulge',closed:true,anchors:[
  {...g.anchor(12,14),outX:-24,outY:-30},
  {...g.anchor(12,24),inX:-6,inY:-3},
  g.anchor(30,24),g.anchor(30,14),
]};
const untouched=square('untouched',80,80,10);
const before=structuredClone(bulge);
for(const axis of [0,1]) {
  const source=[bulge,untouched];
  const result=snapGeometry.snapShapeToAxis(source,new Set(['bulge']),axis);
  const bounds=g.sketchBounds({paths:[result[0]]});
  near(axis===0?bounds.minX:bounds.minY,0,1e-10);
  assert.equal(result[1],untouched);
  const dx=result[0].anchors[0].x-bulge.anchors[0].x;
  const dy=result[0].anchors[0].y-bulge.anchors[0].y;
  near(axis===0?dy:dx,0);
  bulge.anchors.forEach((a,i)=>assert.deepEqual(result[0].anchors[i],{...a,x:a.x+dx,y:a.y+dy}));
  near(Math.min(...snapGeometry.sampled(result[0]).map(p=>p[axis])),0,1e-10);
  assert.equal(snapGeometry.snapShapeToAxis(result,new Set(['bulge']),axis),result);
}
assert.deepEqual(bulge,before);
const noSelection=[bulge];
assert.equal(snapGeometry.snapShapeToAxis(noSelection,new Set(),0),noSelection);
const openOnly=[{...bulge,closed:false}];
assert.equal(snapGeometry.snapShapeToAxis(openOnly,new Set(['bulge']),0),openOnly);
for(const axis of [0,1]) {
  const a=square('a',-20,-30,5), b=square('b',10,15,5);
  const moved=snapGeometry.snapShapeToAxis([a,b],new Set(['a','b']),axis);
  near(moved[1].anchors[0].x-moved[0].anchors[0].x,30);
  near(moved[1].anchors[0].y-moved[0].anchors[0].y,45);
  const bounds=g.sketchBounds({paths:moved});
  assert(Math.abs(axis===0 ? (Math.abs(bounds.minX) < 1e-3 ? bounds.minX : bounds.maxX) : (Math.abs(bounds.minY) < 1e-3 ? bounds.minY : bounds.maxY)) < 1e-3);
}
console.log('Snap shape to axis checks passed');
