import { getManifold, MeshShape } from "replicad";
import type { Vec3, ResizeFaceOp, OffsetExtrudeOp } from "../document/types";

const dot = (a: Vec3, b: Vec3) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return a.map(v=>v/l) as Vec3; };
const key = (a: number,b: number) => a<b ? `${a}:${b}` : `${b}:${a}`;

/** Twice the area, in mm², below which a triangle is an invisible speck whose
 *  orientation is rounding noise rather than geometry. */
const SPECK_CROSS = 1e-8;
const ADJOINING_FLAT_MESSAGE = "This face runs flush into its neighbour, so there is no edge to resize it against.";
const FOLD_MESSAGE ="Resizing this face by that amount would fold the surfaces next to it. Try a smaller amount.";

/** Select one connected planar patch, using welded topology rather than render vertices. */
function planarPatch(solid: MeshShape, point: Vec3, direction: Vec3) {
  const raw = solid.wrapped.getMesh();
  const vertices: Vec3[] = [];
  const canonical = new Map<string,number>();
  const ids: number[] = [];
  for(let i=0;i<raw.vertProperties.length;i+=raw.numProp) {
    const p: Vec3 = [raw.vertProperties[i],raw.vertProperties[i+1],raw.vertProperties[i+2]];
    const k=p.map(v=>Math.round(v*1e6)).join(',');
    let id=canonical.get(k);
    if(id===undefined) { id=vertices.length; vertices.push(p); canonical.set(k,id); }
    ids.push(id);
  }
  const triangles: number[][]=[];
  const normals: Vec3[]=[];
  const edges=new Map<string,number[]>();
  const n=unit(direction), x=unit(cross(Math.abs(n[2])<0.9?[0,0,1]:[1,0,0],n)), y=cross(n,x);
  const project=(p:Vec3): [number,number] => {const q=sub(p,point); return [dot(q,x),dot(q,y)];};
  let seed=-1;
  const candidates=new Set<number>();
  for(let i=0;i<raw.triVerts.length;i+=3) {
    const t=triangles.length, tri=Array.from(raw.triVerts.slice(i,i+3),id=>ids[id]);
    triangles.push(tri);
    const [a,b,c]=tri.map(id=>vertices[id]);
    const normal=unit(cross(sub(b,a),sub(c,a))); normals.push(normal);
    for(let j=0;j<3;j++) {const k=key(tri[j],tri[(j+1)%3]); const list=edges.get(k)??[]; list.push(t); edges.set(k,list);}
    if(dot(normal,n)<0.99999 || tri.some(id=>Math.abs(dot(sub(vertices[id],point),n))>0.002)) continue;
    candidates.add(t);
    // The click must lie inside the triangle, not merely near its centroid.
    const p=tri.map(id=>project(vertices[id]));
    const signs=p.map((v,j)=>v[0]*p[(j+1)%3][1]-v[1]*p[(j+1)%3][0]);
    if(signs.every(v=>v>=-1e-5)) seed=t;
  }
  if(seed<0) return null;
  const flood=(start:number, accept:(t:number)=>boolean) => {
    const result=new Set<number>([start]), queue=[start];
    while(queue.length) {const t=queue.pop()!; const tri=triangles[t];
      for(let j=0;j<3;j++) for(const other of edges.get(key(tri[j],tri[(j+1)%3]))??[]) {
        if(!result.has(other)&&accept(other)) {result.add(other);queue.push(other);}
      }
    }
    return result;
  };
  const selected=flood(seed,t=>candidates.has(t));
  const boundary: [number,number][]=[];
  for(const t of selected) {const tri=triangles[t]; for(let j=0;j<3;j++) {
    const a=tri[j],b=tri[(j+1)%3];
    if((edges.get(key(a,b))??[]).filter(other=>selected.has(other)).length===1) boundary.push([a,b]);
  }}
  const manifold=getManifold();
  const section=new manifold.CrossSection(Array.from(selected,t=>triangles[t].map(id=>project(vertices[id]))),'NonZero');
  return {vertices,triangles,normals,edges,n,x,y,project,selected,boundary,section,flood};
}

export function offsetExtrudeMesh(solid: MeshShape, op: OffsetExtrudeOp): MeshShape | null {
  try {
    const patch=planarPatch(solid,op.point,op.normal);
    if(!patch || !Number.isFinite(op.height) || Math.abs(op.height)<1e-6) return null;
    const profile=patch.section.offset(-op.inset,'Miter',8);
    if(profile.isEmpty()) return null;
    const overlap=0.001;
    const low=op.height>0?-overlap:op.height;
    const high=op.height>0?op.height:overlap;
    const {x,y,n}=patch;
    const origin=op.point.map((v,i)=>v+low*n[i]) as Vec3;
    const prism=profile.extrude(high-low).transform([
      ...x,0,...y,0,...n,0,...origin,1,
    ]);
    const result=op.height>0?solid.wrapped.add(prism):solid.wrapped.subtract(prism);
    if(result.isEmpty() || result.status()!=='NoError' || Math.abs(result.volume()-solid.volume())<1e-8) return null;
    return new MeshShape(result);
  } catch { return null; }
}

/** A shell opening preserves a rim and is confined to the clicked patch. */
export function meshShellOpening(solid: MeshShape, point: Vec3, normal: Vec3, thickness: number, inset = thickness) {
  const patch = planarPatch(solid, point, normal);
  if (!patch) return null;
  const profile = patch.section.offset(-inset, 'Round', 2, 32);
  if (profile.isEmpty()) return null;
  const { x, y, n } = patch;
  const depth = thickness + 0.01;
  const origin = point.map((value, i) => value - depth * n[i]) as Vec3;
  return profile.extrude(depth + 0.01).transform([...x, 0, ...y, 0, ...n, 0, ...origin, 1]);
}

/** Offset the planar border and taper adjoining planar patches to their far edge. */
export function resizeMeshFace(solid: MeshShape, op: ResizeFaceOp, onError?: (reason: string) => void): MeshShape | null {
  try {
    const patch=planarPatch(solid,op.point,op.normal);
    if(!patch || !Number.isFinite(op.offset)) throw new Error("Resize check 1 failed.");
    const {vertices,triangles,normals,edges,n,selected,boundary,section,flood}=patch;
    const target=section.offset(op.offset,'Miter',8);
    if(target.isEmpty() || target.numContour()!==section.numContour()) throw new Error("Resize check 2 failed.");
    const constraints=new Map<number,Vec3[]>();
    for(const [a,b] of boundary) {
      const outward=unit(cross(sub(vertices[b],vertices[a]),n));
      for(const id of [a,b]) {const list=constraints.get(id)??[]; list.push(outward); constraints.set(id,list);}
    }
    const shifts=new Map<number,Vec3>();
    for(const [id,list] of constraints) {
      if(list.length!==2) throw new Error("Resize check 3 failed.");
      const denominator=1+dot(list[0],list[1]);
      if(denominator<1e-5) throw new Error("Resize check 4 failed.");
      shifts.set(id,list[0].map((v,i)=>op.offset*(v+list[1][i])/denominator) as Vec3);
    }
    // Each adjoining planar face has its own fixed far edge. A shoulder on a
    // compound therefore stays fixed rather than dragging the entire body.
    const affected=new Set<number>();
    const weights=new Map<number,number>();
    for(const [a,b] of boundary) for(const seed of edges.get(key(a,b))??[]) {
      if(selected.has(seed)||affected.has(seed)) continue;
      const planePoint=vertices[triangles[seed][0]], normal=normals[seed];
      const side=flood(seed,t=>dot(normals[t],normal)>0.99999 && triangles[t].every(id=>Math.abs(dot(sub(vertices[id],planePoint),normal))<0.002));
      const sideIds=new Set(Array.from(side).flatMap(t=>triangles[t]));
      // The far edge may lie behind the selected face (an outside wall, whose
      // neighbours run back from it) or in front of it (an inside wall, whose
      // floor runs out into the cavity). Measuring only behind rejected every
      // inside face of a tray or pocket.
      let depth=0;
      for(const id of sideIds) depth=Math.max(depth,Math.abs(dot(sub(vertices[id],op.point),n)));
      if(depth<1e-5) throw new Error(ADJOINING_FLAT_MESSAGE);
      for(const t of side) affected.add(t);
      for(const id of sideIds) {
        const weight=Math.max(0,Math.min(1,1-Math.abs(dot(sub(vertices[id],op.point),n))/depth));
        weights.set(id,Math.max(weights.get(id)??0,weight));
      }
    }
    for(const t of selected) for(const id of triangles[t]) weights.set(id,1);
    const moved=vertices.map(p=>[...p] as Vec3);
    for(const [id,weight] of weights) {
      if(weight<1e-8) continue;
      let shift=shifts.get(id);
      if(!shift) {
        let best=Infinity;
        for(const [a,b] of boundary) {
          const edge=sub(vertices[b],vertices[a]), q=sub(vertices[id],vertices[a]);
          const t=Math.max(0,Math.min(1,dot(q,edge)/dot(edge,edge)));
          const d=q.map((v,i)=>v-t*edge[i]) as Vec3;
          // Distance in the selected plane, independent of depth.
          const distance=dot(d,d)-dot(d,n)**2;
          if(distance<best) {best=distance; shift=shifts.get(a)!.map((v,i)=>v*(1-t)+shifts.get(b)![i]*t) as Vec3;}
        }
      }
      if(shift) moved[id]=vertices[id].map((v,i)=>v+weight*shift![i]) as Vec3;
    }
    // Reject folds, collapsed faces, and offsets that changed the outline's
    // topology. Being watertight alone does not rule out inverted triangles.
    //
    // Only triangles this resize actually moved are judged, and each against
    // its own starting size. Boolean results carry microscopic sliver
    // triangles well away from any edit — corners 0.00001mm apart — and
    // testing every triangle against a fixed area floor rejected every resize
    // on such a model, whatever face or amount was chosen.
    for(let t=0;t<triangles.length;t++) {
      const ids=triangles[t];
      if(!ids.some(id=>(weights.get(id)??0)>=1e-8)) continue;
      const before=Math.hypot(...cross(sub(vertices[ids[1]],vertices[ids[0]]),sub(vertices[ids[2]],vertices[ids[0]])));
      if(before<SPECK_CROSS) continue;
      const [a,b,c]=ids.map(id=>moved[id]);
      if(dot(cross(sub(b,a),sub(c,a)),normals[t])<=before*1e-3) throw new Error(FOLD_MESSAGE);
    }
    const manifold=getManifold();
    const actual=new manifold.CrossSection(Array.from(selected,t=>triangles[t].map(id=>patch.project(moved[id]))),'NonZero');
    if(actual.subtract(target).area()+target.subtract(actual).area()>Math.max(1e-4,target.area()*1e-5)) throw new Error("Resize check 6 failed.");
    const result=new manifold.Manifold(new manifold.Mesh({numProp:3,vertProperties:Float32Array.from(moved.flat()),triVerts:Uint32Array.from(triangles.flat())}));
    if(result.status()!=='NoError'||result.isEmpty()||result.volume()<=0) throw new Error("Resize check 7 failed.");
    return new MeshShape(result);
  } catch (error) { onError?.(error instanceof Error ? error.message : "Face resize failed."); return null; }
}


