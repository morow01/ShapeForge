# 3D CAD App — Feature Wishlist

A browser-based 3D modeling tool for 3D printing, inspired by TinkerCAD (base UI/interaction) and Shapr3D (precision tools). This is a separate project from Rian.

## Platform
- Web browser based, desktop/PC only — no mobile app needed
- Expect this to be a long-term, incremental build (similar to how Rian took ~6 months to reach its current state)

## Import / Export
- Import Illustrator or SVG paths to use as extrusion profiles
- Export to STL (or compatible format) for a Bambu Lab 3D printer
- Current manual workflow being replaced: design shapes in Illustrator (top/side/other views) → import into TinkerCAD → extrude

## Base UI / Interaction
- TinkerCAD-style base UI and object manipulation (selection, rotation, navigation)
- Perspective view / orthographic view toggle (like Shapr3D)
- Illustrator-style smart guides — alignment lines appear when edges, faces, or dimensions match between objects
- Illustrator-style modifier key shortcuts — e.g. alt-drag to duplicate, shift-drag to constrain movement along an axis

## Core Modeling (basic scope for v1)
- Basic primitives (box, cylinder, sphere, cone, etc.)
- Boolean operations: union, subtract, intersect
- TinkerCAD-style "hole" shape — flag an object as a hole so it auto-subtracts from any solid it overlaps, without a manual boolean step
- Numeric precision controls — typed exact offset distances between objects, exact extrusion/face-pull distances
- Live parametric resizing — e.g. typing a new width value updates the object size instantly
- Lockable dimensions / axis locks on resize — prevent accidental drags from resizing the wrong axis
- Toggle between proportional and free-form (non-proportional) resizing — proportional likely default
- Edge fillet / chamfer — select an edge, round or bevel by a set amount
- Point snapping — select a vertex on one object and a vertex on another to snap/join at that point
- Parametric triangle tool — set each side length or each angle numerically (e.g. for gusset/support triangles in brackets)

## Deferred / Future Features
- Revolve
- Array/copy along a path

## Engine / Architecture Notes
- Three.js alone is only a renderer — it doesn't handle real solid geometry (no proper booleans, fillets, or precise measurement on its own)
- Leading option: **OpenCascade.js** — the OpenCascade CAD kernel (used in aerospace/industrial CAD) compiled to WebAssembly, runs near-native speed in-browser, handles booleans/fillets/precise measurement
- Reference project showing this combo works: **CascadeStudio** (Three.js for rendering + OpenCascade for modeling math)
- Plan: bring this full feature list to a Claude Code session and let it weigh in on the most suitable engine/library choice
