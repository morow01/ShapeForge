import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import ManifoldModule from 'manifold-3d';
import OpenCascade from 'replicad-opencascadejs';
import {MeshShape,getManifold,setManifold,setOC} from 'replicad';
setOC(await OpenCascade());
const m=await ManifoldModule(); m.setup(); setManifold(m);
const source=readFileSync(new URL('../src/kernel/meshFace.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function','function');
const js=ts.transpile(source,{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None});
const {resizeMeshFace,offsetExtrudeMesh}=new Function('MeshShape','getManifold',`${js};return {resizeMeshFace,offsetExtrudeMesh};`)(MeshShape,getManifold);
const mesh=s=>new MeshShape(new m.Manifold(s.getMesh()));
const box=m.Manifold.cube([20,20,10]);
for(const offset of [-2,2]) {
 const r=resizeMeshFace(mesh(box),{point:[10,10,10],normal:[0,0,1],offset});
 assert.ok(r,`resize ${offset}`);
 const width=20+2*offset;
 assert.ok(Math.abs(r.volume()-10/3*(400+20*width+width*width))<1e-3);
}
for(const height of [-3,3]) {
 const r=offsetExtrudeMesh(mesh(box),{point:[10,10,10],normal:[0,0,1],inset:2,height});
 assert.ok(r);
 assert.ok(Math.abs(r.volume()-(4000+256*height))<1e-3);
}
const ring=box.subtract(m.Manifold.cube([8,8,12]).translate([6,6,-1]));
const r=offsetExtrudeMesh(mesh(ring),{point:[2,10,10],normal:[0,0,1],inset:1,height:3});
assert.ok(r);
assert.ok(Math.abs(r.volume()-(ring.volume()+(18*18-10*10)*3))<1e-3);
const disconnected=box.add(m.Manifold.cube([20,20,10]).translate([30,0,0]));
const d=offsetExtrudeMesh(mesh(disconnected),{point:[10,10,10],normal:[0,0,1],inset:2,height:3});
assert.ok(d); assert.ok(Math.abs(d.volume()-(8000+256*3))<1e-3);
assert.equal(offsetExtrudeMesh(mesh(box),{point:[10,10,10],normal:[0,0,1],inset:11,height:3}),null);
console.log('Mesh face tools: resize in/out, extrude/cut, holes, disconnected faces and invalid inset passed');
const rotated=box.rotate([25,35,15]);
// Obtain the transformed normal and click by applying the same transform to a probe triangle.
const probe=m.Manifold.cube([0.001,0.001,0.001]).translate([10,10,10]).rotate([25,35,15]);
const angles=[25,35,15].map(v=>v*Math.PI/180);
const rotate=p=>{let [x,y,z]=p; const [a,b,c]=angles; [y,z]=[y*Math.cos(a)-z*Math.sin(a),y*Math.sin(a)+z*Math.cos(a)]; [x,z]=[x*Math.cos(b)+z*Math.sin(b),-x*Math.sin(b)+z*Math.cos(b)]; return [x*Math.cos(c)-y*Math.sin(c),x*Math.sin(c)+y*Math.cos(c),z];};
const tilted=offsetExtrudeMesh(mesh(rotated),{point:rotate([10,10,10]),normal:rotate([0,0,1]),inset:2,height:3});
assert.ok(tilted); assert.ok(Math.abs(tilted.volume()-4768)<0.01);
console.log('Arbitrary face orientation passed');
const openingJs=js;
const opening=new Function('MeshShape','getManifold',`${openingJs};return meshShellOpening;`)(MeshShape,getManifold);
const cutter=opening(mesh(box),[10,10,10],[0,0,1],2);
assert.ok(cutter);
assert.ok(cutter.intersect(m.Manifold.cube([1,1,3]).translate([0,0,7])).isEmpty(),'Shell cutter must preserve rim');
assert.equal(opening(mesh(box),[10,10,10],[0,0,1],11),null);
console.log('Shell opening preserves wall rim and rejects collapsed openings');
const shapeSource=readFileSync(new URL('../src/kernel/shape.ts',import.meta.url),'utf8');
const hollowSource=shapeSource.slice(shapeSource.indexOf('function hollowMesh('),shapeSource.indexOf('/**\n * Builds the stable portion',shapeSource.indexOf('function hollowMesh(')));
const hollowJS=ts.transpile(hollowSource.split('/**')[0],{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None});
const hollow=new Function('MeshShape','getManifold','meshShellOpening',`${hollowJS};return hollowMesh;`)(MeshShape,getManifold,opening);
const thickFloor=hollow(mesh(box),{kind:'shell',points:[[10,10,10]],normal:[0,0,1],thickness:2,bottomThickness:4,openingInset:2});
assert.ok(thickFloor);
assert.ok(Math.abs(thickFloor.volume()-(4000-256*6))<0.01);
console.log('Independent thicker floor passed');
const tray=m.Manifold.cube([40,40,20]).subtract(m.Manifold.cube([32,40,20]).translate([4,4,4]));
let diagnosticSource=source.replace('} catch { return null; }','} catch (e) { console.log(e); return null; }');
diagnosticSource=diagnosticSource.split('\n').map((line,i)=>line.replaceAll('return null;',`{ console.log('Rejected at source line ${i+1}'); return null; }`)).join('\n');
const diagnostic=new Function('MeshShape','getManifold',`${ts.transpile(diagnosticSource,{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None})};return resizeMeshFace;`)(MeshShape,getManifold);
console.log('Tray side:',!!diagnostic(mesh(tray),{point:[40,20,10],normal:[1,0,0],offset:0.5}));
// An inside wall: its floor runs out in FRONT of it, not behind. That used to
// be rejected outright for every pocket or tray.
for (const offset of [0.5, -0.5]) {
  let reason = '';
  const inner = resizeMeshFace(mesh(tray), {point:[4,20,12],normal:[1,0,0],offset}, r => { reason = r; });
  assert.ok(inner, `inside wall resize ${offset}: ${reason}`);
  assert.equal(inner.wrapped.status(), 'NoError');
  assert.ok(Math.abs(inner.volume() - tray.volume()) > 1e-3, 'inside wall resize changed nothing');
}
console.log('Inside wall resize passed');
