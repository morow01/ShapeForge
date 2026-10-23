# Open issue: Shape Builder clearance fails on some removed regions

Written on the laptop at **v0.5.77**, to be picked up on the main PC.
Everything below is already pushed to `main` — `git pull` and this file is there.

## What you see

Select a built shape, set a clearance (0.3 in the case I looked at), and the
panel shows:

> 3 removed regions could not be grown by the 0.3 mm clearance — cut at the
> exact size.

The build still succeeds. The regions that failed simply get no gap around
them, so part of the shape is to size and part of it is 0.3 mm short — which is
worse than either, because nothing tells you *which* parts.

The case in front of me: `Built 1`, built from `Combine 1`, `Cylinder 2` and
`Sphere 1`. 7 regions, 1 kept, so 6 removed, of which 3 could not be grown.

## Where it happens

`src/kernel/shape.ts`:

- The build path that applies the clearance is around **line 6390**, in the
  function that unions the kept cells. For each removed region it calls
  `growSolid(region, clearance)` and cuts the grown version out of the kept
  union. When `growSolid` returns `null` it counts it in `skipped`, leaves the
  kept material alone, and reports the message above.
- `growSolid` (**~6516**) splits a compound into its separate solids, then calls
  `growOcctSolid` on each. One failure fails the lot (`if (!grown) return null`).
- `growOcctSolid` (**~6542**) is the actual offset:
  `BRepOffsetAPI_MakeOffsetShape.PerformByJoin(..., GeomAbs_JoinType.GeomAbs_Intersection, ...)`.
  It returns `null` when `IsDone()` is false, and also when the result's volume
  is not greater than the input's.

## Why it is probably failing

The thing being offset is not a clean primitive. It is a **cell**:
`cellSolid` (**~5590**) intersects the member solids and cuts away all the
others, so a region is the leftover sliver where several shapes overlap. Those
come out with tangent faces (a sphere resting against a cylinder wall), seam
edges, and very thin slivers.

OCCT's skin offset with the `Intersection` join is the brittle one — it wants
to extend and re-intersect every adjacent face, and on tangencies and slivers
it either fails outright or returns something degenerate that the volume check
then rejects. A sphere plus a cylinder plus a combine is exactly the shape of
input that triggers it, which matches 3 of 6 failing rather than all of them.

Note the same `growSolid` is used by Subtract/Union groups and almost never
fails there, because it is handed whole primitives, not boolean leftovers.
That difference is the clue.

## What I would try, in order

1. **Fall back to the arc join.** In `growOcctSolid`, if the `Intersection`
   attempt fails, retry with `GeomAbs_JoinType.GeomAbs_Arc`. OCCT is far more
   robust with it, and for a clearance it is arguably the *more* correct
   offset: it gives a true constant distance `d` in every direction, it just
   rounds convex corners instead of mitring them. For a printing gap nobody
   will see the difference. Cheapest change, most likely to fix it.

2. **Then fall back to the mesh path.** `growSolid` already has a Manifold
   branch for meshes (`minkowskiSum` with a cube). If both B-rep attempts fail,
   tessellate the region, wrap it as a `MeshShape`, grow that, and cut with the
   result. A cube Minkowski is the same mitred growth the `Intersection` join
   gives, so it stays consistent with the groups path. Slower and it coarsens
   that region to a mesh, so only as a last resort — but it would make the
   warning disappear almost entirely.

3. **Per-solid failure should not fail the whole compound.** In `growSolid`
   the loop does `if (!grown) return null`, so one awkward lump throws away the
   growth of every other lump in the same region. Grow what can be grown, fuse
   those, and only give up if nothing worked.

4. **If the warning survives, say which regions.** "3 removed regions" is not
   actionable. The region masks are known at that point, and the Shape Builder
   can already highlight a region — worth naming or highlighting them.

## Repro

1. New design, add a box, a cylinder and a sphere, overlapping so all three
   intersect.
2. Select all three, Shape Builder, keep one region.
3. Set the clearance to Loose (0.3).
4. The panel shows the warning. The number of failures varies with how the
   three overlap — tangencies make it worse.

## One thing to watch, unrelated to the bug

v0.5.77 made the amber cutter ghost draw at **every** clearance, including 0,
because it vanishing at Exact read as the cutting shape being deleted. For a
built shape that means selecting it now ghosts *every removed region* — 6 of
them in the case above — where before, at clearance 0, it drew nothing. It may
be too busy on a build with many regions. If so, the fix is in `App.tsx`
(`clearanceOutlineSpec`, ~3990): keep it always-on for groups, and for builds
either keep the old `clearance > 0` rule or draw only the regions that touch
kept material.

## Where things stand

- `main` is at v0.5.77, pushed, deployed.
- Nothing is in progress in the working tree except `FEEDBACK-NOTES.json`,
  which is deliberately left uncommitted, and an untracked
  `.claude/launch.json.bak`.
- The clearance work that is done and live: the rebuild fix (0.5.73), the
  named fits (0.5.74), Exact (0.5.75), the compact custom box (0.5.76), and
  the ghost staying on at Exact (0.5.77).
