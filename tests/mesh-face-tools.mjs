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
// Independent face axes: the bottom is fixed while width and height taper.
const stretchOp={point:[10,10,10],normal:[0,0,1],offset:0,
 stretch:{scale:[1.2,1.4],origin:[-10,-10],translation:[0,0]}};
const stretched=resizeMeshFace(mesh(box),stretchOp);
assert.ok(stretched,'independent width and height resize');
assert.ok(Math.abs(stretched.volume()-4000*(1+0.6/2+0.08/3))<0.01,'affine taper volume');
const stretchedRaw=stretched.wrapped.getMesh();
const bottom=[];
for(let i=0;i<stretchedRaw.vertProperties.length;i+=stretchedRaw.numProp) {
 const p=Array.from(stretchedRaw.vertProperties.slice(i,i+3));
 if(Math.abs(p[2])<1e-6) bottom.push(p);
}
assert.ok(bottom.every(p=>p[0]>=-1e-6 && p[0]<=20.000001 && p[1]>=-1e-6 && p[1]<=20.000001),'far face remains fixed');
const rotatedStretch=resizeMeshFace(mesh(rotated),{...stretchOp,point:rotate([10,10,10]),normal:rotate([0,0,1]),
 stretch:{scale:[1.1,1.1],origin:[0,0],translation:[0,0]}});
assert.ok(rotatedStretch,'rotated face resize');
assert.ok(Math.abs(rotatedStretch.volume()-4000*(1+0.2/2+0.01/3))<0.02);
assert.equal(resizeMeshFace(mesh(box),{...stretchOp,stretch:{...stretchOp.stretch,scale:[0,1]}}),null,'collapsed size is refused');
console.log('Independent face dimensions, fixed far face, rotated resize and invalid size passed');
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
const boss=m.Manifold.cylinder(16,10,10,64).translate([20,20,0]);
const complex=tray.add(boss).subtract(m.Manifold.cylinder(30,7,7,48).translate([15,20,-1]));
const hollowComplex=hollow(mesh(complex),{kind:'shell',points:[[24,20,16]],normal:[0,0,1],thickness:2});
assert.ok(hollowComplex, 'compound hollow fixture');
for (const [name, shape] of [['tray',mesh(tray)],['compound',mesh(complex)],['hollow compound',hollowComplex]]) {
  for (const offset of [0.5, 2]) {
    let reason = '';
    const resized = resizeMeshFace(shape,{point:[40,20,10],normal:[1,0,0],offset}, message => { reason = message; });
    assert.ok(resized, `${name} outer wall ${offset}: ${reason}`);
    assert.equal(resized.wrapped.status(), 'NoError');
    assert.ok(resized.volume() > shape.volume(), `${name} outer wall must grow`);
  }
}
console.log('Tray, compound and hollow compound outer wall resizes passed at 0.5 and 2 mm');
