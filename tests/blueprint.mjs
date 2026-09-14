import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
const source=readFileSync(new URL('../src/document/blueprint.ts',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
const api=new Function('THREE','resolveNodeColor',ts.transpile(source,{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None})+
  ';return {generateBlueprintData,extractBlueprintParts,generateCutList,projectedHull,railDimensions,openingSpans,partSpans,partFamilyName,generatePartSheets,buildViews,extractConnectorParts,connectorStockSize,trimFusedPlugs,featureSpans,viewEdges};')(THREE,node=>node.color ?? '#43aede');
const node=(id,more={})=>({type:'object',id,name:'Board',kind:'box',color:'#abcdef',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],params:{},...more});
const geometry=(id,min,max)=>({id,localSize:max.map((v,i)=>v-min[i]),vertices:
  [0,1].flatMap(x=>[0,1].flatMap(y=>[0,1].map(z=>[x?max[0]:min[0],y?max[1]:min[1],z?max[2]:min[2]])))});
// World-space capture is authoritative even for nested, rotated parts.
const nodes=[node('a',{rotation:[0,90,0]}),node('g',{type:'group',rotation:[0,0,35],children:[node('b',{type:'edit'})]}),
  node('hole',{type:'edit',isHole:true}),node('negative-group',{type:'group',isHole:true,children:[node('hidden-child')]}),
  node('tool',{name:'Joinery Joint 1'}),node('hidden',{hidden:true})];
const snapshots=[geometry('a',[0,0,0],[10,20,40]),geometry('b',[10,0,0],[50,20,10]),
  ...['hole','hidden-child','tool','hidden'].map(id=>geometry(id,[100,0,0],[120,20,20]))];
const data=api.generateBlueprintData('Touching boards',nodes,[],snapshots);
assert.deepEqual(data.parts.map(p=>p.id),['a','b']);
assert.deepEqual(data.overallSize,[50,20,40]);
assert.equal(data.parts[0].max[0],data.parts[1].min[0],'touching edges stay flush');
assert.equal(data.frontView.dimensions.filter(d=>d.kind==='clearance').length,0,'no invented gap');
const triangle=api.projectedHull([[0,0],[10,0],[0,10],[1,1]]);
assert.equal(triangle.length,3,'angled shape is not a bounding rectangle');
const same={...data.parts[0],localSize:[10,20,40]};
assert.equal(api.generateCutList([same,{...same,id:'copy'}])[0].count,2);
assert.equal(api.generateCutList([same,{...same,id:'color',color:'#000'}]).length,2,'different materials stay separate');
assert.equal(api.generateCutList([same,{...same,id:'size',localSize:[10.2,20,40]}]).length,2,'different cut sizes stay separate');
const spaced=api.generateBlueprintData('Gap',[node('a'),node('b')],[],[geometry('a',[0,0,0],[10,10,10]),geometry('b',[15,0,0],[25,10,10])]);
assert.equal(spaced.frontView.dimensions.find(d=>d.kind==='clearance').valueMm,5);
assert.ok(spaced.frontView.dimensions.find(d=>d.kind==='clearance').offset<0,'gap rail lies outside the drawing');
assert.deepEqual(api.generateBlueprintData('Empty',[],[],[]).overallSize,[0,0,0]);

// A carcass is the case a projected-emptiness test cannot see: the sides run
// the full height and the shelves the full width, so the union of everything
// is one solid block with no gap in it. The openings are still real.
const carcass=[['left',[0,0,0],[18,400,825]],['right',[982,0,0],[1000,400,825]],
  ['top',[0,0,825],[1000,400,850]],['bottom',[18,0,0],[982,400,18]],
  ['shelf1',[18,0,298],[982,400,316]],['shelf2',[18,0,596],[982,400,614]],
  ['back',[18,0,0],[982,4,825]]];
// Named as a carpenter would: the two shelves are both "shelf".
const cab=api.generateBlueprintData('Cabinet',carcass.map(([id])=>node(id,{name:id.replace(/\d+$/,'')})),[],
  carcass.map(([id,min,max])=>geometry(id,min,max)));
const opening=(view,type)=>view.dimensions.filter(d=>d.kind==='clearance' && d.type===type).map(d=>d.valueMm);
assert.deepEqual(opening(cab.frontView,'vertical'),[280,280,211],'shelf clear openings');
assert.deepEqual(opening(cab.frontView,'horizontal'),[964],'internal carcass width');
assert.deepEqual(opening(cab.sideView,'vertical'),[280,280,211],'openings restated in profile');
// A shelf cut wall-to-wall touches both sides: a spanning member, not an
// obstruction, so it must not suppress the width it fills.
assert.deepEqual(api.openingSpans(cab.parts,0).map(s=>s.max-s.min),[964]);
// ...but a shelf strictly inside the carcass does suppress bottom-to-top.
assert.ok(!api.openingSpans(cab.parts,2).some(s=>s.max-s.min>700),'no span straddles a shelf');

// Parts only face each other across an axis when they overlap on the others:
// a front leg is never measured against the far back leg.
const legs=['fl','fr','bl','br'].map((id,i)=>node(id,{name:'Leg'}));
const at=(id,x,y)=>geometry(id,[x,y,0],[x+50,y+50,500]);
const table=api.generateBlueprintData('Table',legs,[],
  [at('fl',0,0),at('fr',950,0),at('bl',0,550),at('br',950,550)]);
assert.deepEqual(opening(table.topView,'horizontal'),[900],'clear span between legs, stated once');
assert.equal(api.generateCutList(table.parts)[0].count,4,'four identical legs are one row');

// Duplicating appends "(Copy)"; new shapes get a running number. Neither makes
// a different board.
const board=(id,name)=>({...data.parts[0],id,name,localSize:[964,400,18]});
assert.equal(api.generateCutList([board('a','Shelf'),board('b','Shelf (Copy)'),board('c','Shelf (Copy) (Copy)')])[0].count,3);
assert.equal(api.generateCutList([board('a','Shelf 1'),board('b','Shelf 2')])[0].count,2);
assert.equal(api.generateCutList([board('a','Shelf'),board('b','Divider')]).length,2,'distinct parts stay apart');
// Editing history is not a part description.
assert.equal(api.extractBlueprintParts([node('e',{type:'edit',base:node('b')})],[],[geometry('e',[0,0,0],[10,10,10])])[0].kind,'box (edited)');
assert.equal(api.extractBlueprintParts([node('m',{type:'edit'})],[],[geometry('m',[0,0,0],[10,10,10])])[0].kind,'edited','malformed edit costs one cell, not the drawing');
// Every element carries its own size, or the drawing says how big the whole
// table is without ever saying how big a leg is.
const size=(view,type)=>view.dimensions.filter(d=>d.kind==='part' && d.type===type).map(d=>d.valueMm);
assert.deepEqual(size(table.topView,'horizontal'),[50],'leg width, stated once for four identical legs');
assert.deepEqual(size(table.topView,'vertical'),[50],'leg depth');
// These legs run the full height of the assembly, so the overall dimension
// already states their length and the rail does not repeat it.
assert.deepEqual(size(table.frontView,'vertical'),[],'leg length is the overall height here');
// Give the same legs a top and the length becomes a number of its own.
const topped=api.generateBlueprintData('Table',[...legs,node('top',{name:'Top'})],[],
  [at('fl',0,0),at('fr',950,0),at('bl',0,550),at('br',950,550),geometry('top',[0,0,500],[1000,600,538])]);
assert.deepEqual(size(topped.frontView,'vertical').sort((a,b)=>a-b),[38,500],'leg length and top thickness');
// Panel thicknesses are element sizes too — the other half of what a cut list
// cannot tell you from a drawing.
assert.deepEqual(size(cab.frontView,'vertical').sort((a,b)=>a-b),[18,25,825],'carcass, top and bottom thicknesses');
// A number already carried by the overall dimension or by an opening is not
// repeated: two places to read one size is two places for them to disagree.
assert.ok(!size(cab.topView,'horizontal').includes(1000),'overall width is not restated');
assert.ok(!size(cab.frontView,'horizontal').includes(964),'internal width is not restated as a part size');
assert.equal(api.partSpans(cab.parts,0,[0,1000],[]).filter(s=>s.max-s.min===18).length,1,'both sides share one thickness entry');
console.log('Blueprint: world alignment, edited parts, negative subtrees, hulls, BOM grouping, clearance rails and empty scene passed');
console.log('Blueprint: carcass openings, spanning members, opposed-pair facing, copy grouping and part kinds passed');
console.log('Blueprint: per-element sizes, panel thicknesses and no restated numbers passed');

// One detail page per distinct element, carrying its quantity.
const sheets=cab.partSheets;
assert.equal(sheets.length,cab.cutList.length,'a page for every cut list row, and no more');
assert.deepEqual(sheets.map(s=>s.name),cab.cutList.map(i=>i.name),'pages and schedule agree, in the same order');
const shelfSheet=sheets.find(s=>s.name==='shelf');
assert.deepEqual([shelfSheet.lengthMm,shelfSheet.widthMm,shelfSheet.thicknessMm],[964,400,18]);
assert.equal(shelfSheet.count,2,'two identical shelves are one page marked 2x');
// A page shows its own part, dimensioned, and nothing else.
assert.equal(shelfSheet.frontView.parts.length,1,'a detail page draws one part');
assert.deepEqual(shelfSheet.size,[964,400,18],'page extents are the part, not the assembly');
assert.deepEqual(shelfSheet.frontView.dimensions.map(d=>d.valueMm),[964,18],'width and thickness');
assert.ok(shelfSheet.frontView.dimensions.every(d=>d.kind==='overall'),
  'a lone part has nothing to face across a gap and no size the overall does not state');
assert.equal(api.generatePartSheets([]).length,0,'empty design details nothing');
// The four table legs are one page, not four.
assert.deepEqual(api.generatePartSheets(table.parts).map(s=>s.count),[4]);
console.log('Blueprint: per-element detail pages, quantities and schedule agreement passed');

// Joinery fittings are pieces of timber, not part of the board they join.
// Parameters as the joinery tool writes them for a loose tenon.
// The app paints each new joint a random colour; identical stock must still
// schedule as one row, so a fitting's colour cannot be part of its identity.
let hue=0;
const tenon=(id,more={})=>node(id,{kind:'connector',name:'Joinery Joint '+id,color:`#00000${(hue++)%9}`,
  params:{shape:3,fit:0,width:22,thickness:8,length:20,...more.params},...more});
const mortise=(id)=>tenon(id,{isHole:true,params:{shape:3,fit:1,width:22,thickness:8,length:20}});
// Fused into the board exactly as the app nests them: a group holding the
// board and its plugs, where the group itself carries the built solid.
const joined=[node('topgrp',{type:'group',name:'Table Top (Tenon)',children:[
  node('topbd',{name:'Table Top'}),tenon('t1'),tenon('t2'),tenon('t3'),tenon('t4')]}),
  node('leggrp',{type:'group',name:'Leg (Mortise)',children:[node('legbd',{name:'Leg'}),mortise('m1'),mortise('m2')]})];
const jsnaps=[geometry('topgrp',[0,0,500],[1000,600,538]),geometry('leggrp',[0,0,0],[50,50,500])];
const joinery=api.generateBlueprintData('Joined table',joined,[],jsnaps);
const row=name=>joinery.cutList.find(i=>i.name===name);
assert.ok(row('Loose Tenon'),'tenons are scheduled under their joint name, not "Joinery Joint"');
assert.equal(row('Loose Tenon').count,4,'four tenons, counted as four pieces');
assert.equal(joinery.cutList.filter(i=>i.name==='Loose Tenon').length,1,'identical tenons are one row');
assert.deepEqual([row('Loose Tenon').lengthMm,row('Loose Tenon').widthMm,row('Loose Tenon').thicknessMm],[22,20,8],
  'stock size comes from the joint parameters, not a bounding box');
assert.equal(row('Loose Tenon').kind,'tenon');
// A mortise is the void a tenon goes into; nobody cuts one to length.
assert.equal(joinery.cutList.filter(i=>i.kind==='tenon').length,1,'sockets are not scheduled');
// The board keeps its own size and is not counted as carrying the tenons.
assert.ok(row('Table Top (Tenon)'),'the board is still scheduled');
// Fittings are listed, not drawn: size and quantity on the cut list, no
// detail page — a dowel or domino is cut from stock by its size alone.
assert.equal(joinery.partSheets.some(s=>s.kind==='tenon'),false,'no detail page for tenons');
assert.deepEqual(joinery.partSheets.map(s=>s.name).sort(),['Leg (Mortise)','Table Top (Tenon)'],'boards keep their pages');
assert.ok(row('Loose Tenon'),'tenons still on the cut list');
// ...but the drawings stay on the boards: a fused tenon is already drawn by
// the board it belongs to, and must not be outlined a second time.
assert.deepEqual(joinery.frontView.parts.map(p=>p.id),['topgrp','leggrp'],'fittings are not redrawn on the assembly');
assert.deepEqual(joinery.overallSize,[1000,600,538],'fittings do not stretch the assembly bounds');
// Sizes for every joint the kernel can cut from stock.
assert.deepEqual(api.connectorStockSize({shape:1,radius:4,length:30}),[8,8,30],'dowel is measured across its diameter');
assert.deepEqual(api.connectorStockSize({shape:2,width:10,length:40}),[10,10,40],'square key');
assert.equal(api.connectorStockSize({shape:5}),null,'print-in-place fittings are not cut stock');
// A renamed joint keeps its name but is still scheduled once, not twice.
const renamed=api.generateBlueprintData('Renamed',[node('g',{type:'group',name:'Rail',children:[
  node('bd',{name:'Rail'}),tenon('r1',{name:'Domino 8mm'})]})],[],[geometry('g',[0,0,0],[100,50,20])]);
assert.equal(renamed.cutList.filter(i=>i.name==='Domino 8mm').length,1,'renamed fitting scheduled exactly once');
console.log('Blueprint: joinery fittings scheduled as their own stock, sockets excluded, no double counting passed');

// The kernel fuses each tenon into its board, so an 18mm top with 20mm tenons
// standing proud of it measures 38mm corner to corner. Left alone, the cut
// list sends the carpenter out for 38mm stock to make an 18mm top.
const proud=(id,min,max,studs)=>({id,localSize:[max[0]-min[0],max[1]-min[1],max[2]-min[2]],
  vertices:[...geometry(id,min,max).vertices,
    // tenons standing on the top face, each 20mm proud of it
    ...studs.flatMap(([x,y])=>[0,1].flatMap(a=>[0,1].flatMap(b=>[0,1].map(c=>
      [x+(a?22:0),y+(b?8:0),c?max[2]+20:max[2]]))))]});
const proudBoard=node('top',{type:'group',name:'Table Top',children:[node('bd',{name:'Board'}),
  tenon('p1'),tenon('p2'),tenon('p3'),tenon('p4')]});
const proudTop=api.generateBlueprintData('Proud tenons',[proudBoard],[],
  [proud('top',[0,0,0],[1000,600,18],[[60,60],[900,60],[60,520],[900,520]])]);
const topRow=proudTop.cutList.find(i=>i.name==='Table Top');
assert.equal(topRow.thicknessMm,18,'the board is measured as the board, not board plus tenons');
assert.deepEqual([topRow.lengthMm,topRow.widthMm],[1000,600],'the other two sides are untouched');
assert.deepEqual(proudTop.parts[0].max,[1000,600,18],'extents stop at the board face');
// The tenons are gone from the drawing, but their footprints stay: that is
// where they go, which is what marking out the board needs.
const faceRing=proudTop.parts[0].vertices.filter(v=>Math.abs(v[2]-18)<0.01);
assert.ok(faceRing.length>8,'tenon footprints remain on the face');
assert.equal(proudTop.parts[0].vertices.some(v=>v[2]>18.01),false,'nothing stands proud any more');
// A board with no fittings in it is never trimmed, whatever its shape.
const stepped={id:'s',localSize:[100,50,38],vertices:[...geometry('s',[0,0,0],[100,50,18]).vertices,
  ...geometry('x',[0,0,18],[100,50,38]).vertices]};
const plain=api.generateBlueprintData('Stepped',[node('s',{name:'Stepped'})],[],[stepped]);
assert.equal(plain.cutList[0].thicknessMm,38,'a board with no tenons keeps every millimetre');
assert.deepEqual(api.trimFusedPlugs(geometry('q',[0,0,0],[10,10,10]).vertices,undefined,[20]).trimmed,false,
  'a plain slab has nothing to trim');
console.log('Blueprint: fused tenons trimmed off the board they stand proud of passed');

// A board exactly as thick as its tenons are long: 20mm board, 20mm tenons
// standing off one face. Both slabs match the tenon length; trimming every
// match took both and scheduled the board 0mm thick.
const boxEdges=(min,max)=>{const c=(x,y,z)=>[x?max[0]:min[0],y?max[1]:min[1],z?max[2]:min[2]];
  return [[0,0,0,1,0,0],[0,1,0,1,1,0],[0,0,1,1,0,1],[0,1,1,1,1,1],[0,0,0,0,1,0],[1,0,0,1,1,0],[0,0,1,0,1,1],[1,0,1,1,1,1],
    [0,0,0,0,0,1],[1,0,0,1,0,1],[0,1,0,0,1,1],[1,1,0,1,1,1]].map(([a,b,c1,d,e,f])=>[c(a,b,c1),c(d,e,f)]);};
const plate=[[110,0,0],[130,92,98]];
const studs=[[10,40],[40,40],[70,40]].map(([y,z])=>[[90,y,z],[110,y+22,z+8]]);
const plateGeometry={id:'yv',localSize:[20,92,98],
  vertices:[plate,...studs].flatMap(([mn,mx])=>geometry('x',mn,mx).vertices),
  edges:[plate,...studs].flatMap(([mn,mx])=>boxEdges(mn,mx))};
const yellow=node('yv',{type:'group',name:'Yellow vertical',children:[node('b3',{name:'Box 3'}),tenon('y1'),tenon('y2'),tenon('y3')]});
const flush=api.generateBlueprintData('Flush',[yellow],[],[plateGeometry]).cutList.find(i=>i.name==='Yellow vertical');
assert.equal(flush.thicknessMm,20,'the board keeps its own 20mm, tenons of the same length notwithstanding');
assert.deepEqual([flush.lengthMm,flush.widthMm],[98,92]);
// With no outlines to compare faces there is no telling the slabs apart, so
// the part is left as modelled rather than guessed down to nothing.
const blind=api.generateBlueprintData('Blind',[yellow],[],[{...plateGeometry,edges:undefined}]).cutList.find(i=>i.name==='Yellow vertical');
assert.ok(blind.thicknessMm>0,'never a zero-thickness part');
// A chamfered dowel adds a plane of its own between tip and board face; the
// walk inward must pass it. 20mm pin, 9mm dowel below with a 1mm chamfer.
const dowel=(id)=>node(id,{kind:'connector',name:'Joinery Joint '+id,params:{shape:1,fit:0,radius:5,length:9,chamfer:1}});
const pin=[[0,0,9],[20,20,29]], shaft=[[5,5,1],[15,15,9]], tip=[[6,6,0],[14,14,1]];
const pinGeometry={id:'pin',localSize:[20,20,29],
  vertices:[pin,shaft,tip].flatMap(([mn,mx])=>geometry('x',mn,mx).vertices),
  edges:[pin,shaft,tip].flatMap(([mn,mx])=>boxEdges(mn,mx))};
const redPin=api.generateBlueprintData('Pin',[node('pin',{type:'group',name:'Red pin',children:[node('c1',{kind:'cylinder'}),dowel('d1')]})],[],[pinGeometry])
  .cutList.find(i=>i.name==='Red pin');
assert.deepEqual([redPin.lengthMm,redPin.widthMm,redPin.thicknessMm],[20,20,20],'chamfered dowel trimmed back to the pin face');
// Tenons inside a scaled group are scaled with the board: 20mm tenons in a
// group scaled 0.5 along X stand 10mm proud of a 50mm board.
const slab=[[10,0,0],[60,90,40]], lugs=[[18,32],[58,72]].map(([y0,y1])=>[[0,y0,16],[10,y1,24]]);
const scaledGeometry={id:'gb',localSize:[60,90,40],
  vertices:[slab,...lugs].flatMap(([mn,mx])=>geometry('x',mn,mx).vertices),
  edges:[slab,...lugs].flatMap(([mn,mx])=>boxEdges(mn,mx))};
const grey=node('gb',{type:'group',name:'Gray Box',children:[node('in',{type:'group',scale:[0.5,1,1],
  children:[node('b1',{name:'Box 1'}),tenon('g1'),tenon('g2')]})]});
const scaledRow=api.generateBlueprintData('Scaled',[grey],[],[scaledGeometry]).cutList.find(i=>i.name==='Gray Box');
assert.deepEqual([scaledRow.lengthMm,scaledRow.widthMm,scaledRow.thicknessMm],[90,50,40],'scaled tenons trimmed at their scaled length');
console.log('Blueprint: board as thick as its tenons, no-outline safety, chamfered dowels and scaled groups passed');

// A tray: 108.6 x 90 x 40 with a pocket inset 12mm from every edge, 13mm deep.
// Its outside size says nothing about the walls, the pocket or the floor.
const outer=[[0,0,0],[108.6,90,40]], pocket=[[12,12,27],[96.6,78,40]];
const trayGeometry={id:'tray',localSize:[108.6,90,40],
  vertices:[outer,pocket].flatMap(([mn,mx])=>geometry('x',mn,mx).vertices),
  edges:[outer,pocket].flatMap(([mn,mx])=>boxEdges(mn,mx))};
const trayPage=api.generateBlueprintData('Tray',[node('tray',{name:'Purple Box'})],[],[trayGeometry]).partSheets[0];
const chain=(view,type)=>view.dimensions.filter(d=>d.kind==='part'&&d.type===type).map(d=>+d.valueMm.toFixed(1));
assert.deepEqual(chain(trayPage.topView,'horizontal'),[12,84.6,12],'wall | pocket | wall along the length');
assert.deepEqual(chain(trayPage.topView,'vertical'),[12,66,12],'wall | pocket | wall across the width');
assert.deepEqual(chain(trayPage.frontView,'vertical'),[27,13],'floor | pocket depth');
assert.ok(trayPage.frontView.dimensions.some(d=>d.kind==='overall'&&d.valueMm===108.6),'overall size still stated');
// The assembly sheet with several parts is not buried under every part's chains.
const pair=api.generateBlueprintData('Pair',[node('tray',{name:'Purple Box'}),node('lid',{name:'Lid'})],[],
  [trayGeometry,geometry('lid',[0,0,50],[108.6,90,56])]);
assert.equal(pair.topView.dimensions.filter(d=>d.kind==='part'&&[12,84.6,66].includes(+d.valueMm.toFixed(1))).length,0,
  'inside chains belong on the part page, not the assembly');
// Fillet facets and slot ends are short segments, not steps of their own.
const facets=[...Array(12)].map((_,i)=>[[100+i*0.3,0,39],[100+i*0.3,0.3,39.3]]);
assert.deepEqual(api.featureSpans({...pair.parts[0],edges:[...trayGeometry.edges,...facets]},0).map(s=>+(s.max-s.min).toFixed(1)),[12,84.6,12]);
// Rounded mortise ends facet into long lines at dozens of slightly different
// heights. They must neither bury the pocket depth nor wipe the chain out.
const mortiseFacets=[...Array(20)].map((_,i)=>[[0,30+i*0.5,15+i*0.6],[20,30+i*0.5,15+i*0.6]]);
const busyTray={...pair.parts[0],edges:[...trayGeometry.edges,...mortiseFacets]};
assert.deepEqual(api.featureSpans(busyTray,2).map(s=>+(s.max-s.min).toFixed(1)),[27,13],'pocket depth survives mortise facets');
// A part whose only features are mortises still gets them dimensioned.
const leg={...pair.parts[0],min:[0,0,0],max:[50,50,500],edges:[...boxEdges([0,0,0],[50,50,500]),...boxEdges([10,21,460],[40,29,500])]};
assert.deepEqual(api.featureSpans(leg,1).map(s=>+(s.max-s.min).toFixed(1)),[21,8,21],'mortise position and width on a leg');
console.log('Blueprint: inside features chained on part pages, kept off the assembly, weighted over facets passed');

// Which edges a view draws. A rounded slot end is 7.5-degree facets; drawing
// all their creases stacked them into solid black blocks side-on.
const deg=d=>d*Math.PI/180, tilt=d=>[0,Math.sin(deg(d)),Math.cos(deg(d))];
const crease=(first,second,label)=>({label,c:[[0,0,0],[20,0,0],first,second]});
const cases=[
  crease([0,0,1],tilt(7.5),'flat face into the curve'),
  crease(tilt(7.5),tilt(15),'facet into facet'),
  crease([0,0,1],[1,0,0],'square edge'),
  crease([0,1,0],[0,1,0],'diagonal across one flat face'),
  crease([0,0,1],null,'open boundary'),
];
const drawnIn=view=>cases.filter(({c})=>api.viewEdges({creases:[c]},view).length).map(({label})=>label);
assert.deepEqual(drawnIn([0,0,1]),['square edge','open boundary'],'from above, facets and the tangent line are not edges');
assert.deepEqual(drawnIn([0,1,0]),['flat face into the curve','square edge','open boundary'],
  'side-on, the tangent line is the silhouette; facets and flat-face diagonals still are not');
assert.deepEqual(api.viewEdges({edges:[[[0,0,0],[1,0,0]]]},[0,0,1]),[[[0,0,0],[1,0,0]]],'without crease data, every edge is drawn as before');
console.log('Blueprint: sharp edges and per-view silhouettes drawn, facet creases dropped passed');

// A real mesh captured the way the viewport does: every edge with the normals
// of the triangles either side (see captureBlueprintGeometry in scene.ts).
const captured=(geometry)=>{
  const pos=geometry.getAttribute('position'), index=geometry.getIndex();
  const corner=i=>new THREE.Vector3().fromBufferAttribute(pos,index?index.getX(i):i);
  const key=v=>`${Math.round(v.x*1e4)},${Math.round(v.y*1e4)},${Math.round(v.z*1e4)}`;
  const creases=new Map(), count=index?index.count:pos.count, vertices=[];
  for(let t=0;t+2<count;t+=3){
    const p=[corner(t),corner(t+1),corner(t+2)]; p.forEach(v=>vertices.push(v.toArray()));
    const n=new THREE.Vector3().subVectors(p[1],p[0]).cross(new THREE.Vector3().subVectors(p[2],p[0]));
    if(n.lengthSq()<1e-12) continue; const nn=n.normalize().toArray();
    for(const [i,j] of [[0,1],[1,2],[2,0]]){const ka=key(p[i]),kb=key(p[j]); if(ka===kb) continue;
      const k=ka<kb?ka+'|'+kb:kb+'|'+ka, known=creases.get(k);
      if(known){ if(!known[3]) known[3]=nn; } else creases.set(k,[p[i].toArray(),p[j].toArray(),nn,null]);}
  }
  const outline=new THREE.EdgesGeometry(geometry,1), ep=outline.getAttribute('position'), edges=[];
  for(let i=0;i<ep.count;i+=2) edges.push([new THREE.Vector3().fromBufferAttribute(ep,i).toArray(),new THREE.Vector3().fromBufferAttribute(ep,i+1).toArray()]);
  geometry.computeBoundingBox(); const b=geometry.boundingBox;
  return {min:b.min.toArray(),max:b.max.toArray(),vertices,edges,creases:[...creases.values()]};
};
// A torus lying flat: every ring of facets is a closed loop in a plane of its
// own. Seen side-on it was dimensioned as a comb of 0.5mm "steps".
const torus=captured(new THREE.TorusGeometry(5,1.65,16,48));
assert.deepEqual(api.featureSpans(torus,2),[],'no steps up the side of a torus');
assert.deepEqual(api.featureSpans(torus,0),[],'nor across it');
assert.ok(api.featureSpans({...torus,creases:undefined},2).length>0,'(without face directions the rings do still read as steps — the case this fixes)');
// A real flat step still counts: a 20x20x10 block with a 10x20x10 block on
// half of its top leaves a flat ledge at z=10.
const ledge=new THREE.BufferGeometry();
const P=(x,y,z)=>[x,y,z], quad=(a,b,c,d)=>[a,b,c,a,c,d];
const tris=[
  ...quad(P(0,0,0),P(0,20,0),P(20,20,0),P(20,0,0)),            // bottom, facing -z
  ...quad(P(0,0,0),P(20,0,0),P(20,0,20),P(0,0,20)),            // front y=0, full height
  ...quad(P(20,0,0),P(20,20,0),P(20,20,10),P(20,0,10)),        // right x=20, lower
  ...quad(P(20,0,10),P(20,10,10),P(20,10,20),P(20,0,20)),      // right x=20, upper
  ...quad(P(0,20,0),P(0,0,0),P(0,0,20),P(0,10,20)),            // left x=0 (lower + upper as one outline)
  ...quad(P(0,20,0),P(0,10,20),P(0,10,10),P(0,20,10)),
  ...quad(P(20,20,0),P(0,20,0),P(0,20,10),P(20,20,10)),        // back y=20, lower
  ...quad(P(0,10,10),P(20,10,10),P(20,20,10),P(0,20,10)),      // the ledge, facing +z
  ...quad(P(20,10,10),P(0,10,10),P(0,10,20),P(20,10,20)),      // riser y=10, upper
  ...quad(P(0,0,20),P(20,0,20),P(20,10,20),P(0,10,20)),        // top, facing +z
].flat();
ledge.setAttribute('position',new THREE.Float32BufferAttribute(tris,3));
assert.deepEqual(api.featureSpans(captured(ledge),2).map(s=>s.max-s.min),[10,10],'a real flat ledge is still a step');
console.log('Blueprint: turned shapes give no false steps, flat ledges still do passed');
