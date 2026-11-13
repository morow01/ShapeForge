# ShapeForge

A browser-based parametric 3D CAD tool for 3D printing, inspired by TinkerCAD
(base UI/interaction) and Shapr3D (precision tools). See
[3d-cad-app-idea.md](3d-cad-app-idea.md) for the original feature wishlist.

## Stack

- **[Replicad](https://replicad.xyz)** + **OpenCascade.js** (OCCT compiled to
  WASM) for the modeling kernel — real B-rep solids, booleans, fillets,
  precise measurement. Runs in a Web Worker so the UI never blocks.
- **Three.js** for rendering.
- **React** for the UI shell; the viewport itself is imperative Three.js.
- **Zustand + zundo** for the document model and undo/redo.

## Getting started

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL. Vite serves the OpenCascade
WASM build (~22 MB) alongside the app — the first load is the slow one.

```bash
npm run build    # type-checks, then produces a production build in dist/
npm run preview  # serves that build locally
```

## Project layout

- `src/kernel/` — the Web Worker boundary: builds solids from parameters,
  runs booleans, exports STL. Never touches the DOM.
- `src/document/` — the scene tree (primitives + groups), undo history, and
  localStorage autosave.
- `src/geometry/` — pure geometry math shared between the kernel and the UI
  (currently: triangle solving for the gusset tool).
- `src/viewport/` — the Three.js scene: camera, gizmo, picking, smart-guide
  snapping.
- `src/ui/` — React panels (object tree, inspector).

## Releasing

The version shown in the app's badge comes from `package.json`. To cut a
release:

```bash
npm run release          # patch: 0.0.1 -> 0.0.2 (the usual case)
npm run release:minor    # 0.0.1 -> 0.1.0
npm run release:major    # 0.1.0 -> 1.0.0
```

Each of these runs `npm version`, which:

1. Refuses to run if the working tree isn't clean — nothing gets bundled in
   by accident.
2. Runs `npm run build` first (typecheck + production build). If it fails,
   nothing is bumped, committed, or pushed.
3. Bumps the version in `package.json`/`package-lock.json`, commits it as
   `Release v0.0.2`, and creates a matching `v0.0.2` git tag.
4. Pushes the commit and the tag to `origin`.

## Status

Early and actively evolving — see the version badge in the app header.

### Implemented

- Light, TinkerCAD-inspired workspace with an object tree on the left, the
  canvas in the centre, and contextual properties on the right.
- Illustrator-style Select, Move, and Rotate tool rail with `V`, `M`, and `R`
  shortcuts.
- Primitive creation, object/group renaming, grouping, holes, boolean merged
  results, and STL export.
- TinkerCAD-style resize frame with editable dimensions, proportional or
  independent X/Y/Z scaling, corner handles, and anchored side handles.
- Triangle construction using three sides, two sides plus an included angle,
  or a base plus corner angles.
- STL import with a fast direct-triangle editing preview. Expensive mesh repair
  is deferred until a boolean, merged result, or export actually needs it.
- Smart-guide snapping and exact gaps between two selected objects.
- Browser autosave, new-design action, selection tools, and undo/redo history.

### What “Show merged result” does

The normal editing view displays each top-level object independently. **Show
merged result** asks the modeling kernel to evaluate the complete design as one
printable solid: solid objects are combined, holes are subtracted, and group
operations are applied. This is a useful preview before STL export, but it can
be much more expensive than the editing view for large scanned meshes. Heavy
merge/export work runs separately so it does not block ordinary editing.

### Roadmap and open questions

- Save projects to a file, open existing project files, and improve the new
  project workflow. Browser autosave exists, but portable project files do not.
- Per-object colours, a `T` transparency shortcut, and an optional wireframe
  view.
- Edge, vertex, and face selection with context-specific modeling operations.
- Audit and improve undo/redo across every interaction.
- Decide whether right-click should open a compact contextual menu while the
  full properties inspector remains in the right panel.
- Add an Illustrator-like Shape Builder workflow: select overlapping objects,
  then click to add regions or Alt-click to remove regions.
- SVG import with an import-time size control.
- Investigate additional Illustrator-friendly vector formats. SVG should be
  the primary interchange format; PDF may be practical with path extraction,
  while EPS would require a conversion/parser dependency.
- Continue improving snapping and smart guides.

### Large STL notes

A downloaded/scanned STL can be tens of megabytes and contain hundreds of
thousands or millions of triangles. ShapeForge opens standalone STLs quickly by
rendering their triangles directly, similar to a slicer. Combining, repairing,
or exporting the same mesh can still take much longer because those operations
must construct valid manifold geometry. If a 42.29 MB skull or another scan
times out during a boolean or export, simplifying/decimating it in a mesh tool
is still the most reliable workaround.

## Observations & Architecture Highlights

### 1. Clean Separation of Concerns
- **UI Shell (`src/ui/`)**: React panels (Tree, Inspector, ProjectsModal, Tool rail) do not perform CAD math; they dispatch pure state actions to the Zustand store.
- **Pure Math Layer (`src/geometry/`, `src/snapping/`)**: Trigonometry solvers (e.g. triangle construction modes), bounding box math, and smart-guide snapping calculations are cleanly decoupled from rendering.
- **Worker Isolation (`src/kernel/`)**: All heavy OpenCascade/Replicad and Manifold-3D geometry operations run asynchronously in a Web Worker using `comlink`, preventing UI thread stutters and keeping canvas interactions at 60 FPS.

### 2. State & History Architecture
- **Zustand + Zundo Store (`src/document/store.ts`)**: Centralised scene graph supporting hierarchical groups, primitives, direct push/pull edits, and shape-builder nodes.
- **History Batching**: Seamless undo/redo history batching (`beginHistoryBatch`/`endHistoryBatch`) for continuous drags (gizmo transforms, slider tweaks, and handle movements).
- **Dual Persistence**: IndexedDB blob storage for high-volume binary assets (STLs, SVGs) paired with LocalStorage autosave and portable `.shapeforge` project bundle export/import.

### 3. Performance & Resilience
- **Zero-Copy & Typed Arrays**: Geometry data crossing the worker boundary uses compact typed arrays (`Float32Array`, `Uint32Array`) and structured cloning.
- **Watchdog Protection**: Kernel timeouts (`WATCHDOG_MS`) safeguard against worker lockups during heavy boolean merges or complex non-manifold mesh operations.
- **Deferred Mesh Processing**: Fast direct-triangle preview for mesh imports avoids instant, costly CSG conversions until booleans, merged views, or exports strictly require it.

## GitHub deployment

This repository currently has source code but no GitHub Pages or other GitHub
deployment workflow. Consequently, the repository's `/deployments` URL may
return 404 or show nothing. A deployment will appear only after a hosting
workflow (for example GitHub Pages via GitHub Actions) is configured and run.
Local development remains available through `npm run dev`.

### Folder files

Open a folder on the Home page and choose **Store files…** to keep original 3MF
prototyping templates, STL models, PDFs, images, ZIPs or other supporting files
alongside your designs. Multiple files can be added at once. Attachments are
stored separately from project geometry, so saving one does not import it into
the model or increase the project's geometry workload.

Use the file row to download, rename, move or delete it. Downloads preserve the
original bytes. Files are kept on this computer and sync to the corresponding
Google Drive folders when Drive is connected. Other devices load the file list
first and fetch the original bytes only on Download. Pending changes retry on
the next sync. Move or delete a folder's attachments before deleting the folder.
Attachments are separate from a project's `.shapeforge` export.

Folder attachments support three saved layouts: thumbnail cards matching the
project cards, a list with small previews, and the original compact panel.
Attachment and ShapeForge project layouts are remembered independently, so files can remain in a list while projects use thumbnails.
Thumbnails show STL/3MF geometry (or the 3MF's embedded slicer preview), the first
PDF page, the beginning of text files, and common image formats. Previews are
cached separately and generated one at a time for visible files. A Drive-only
file offers **Load preview** rather than downloading large originals on opening
a folder. Unsupported, invalid, encrypted, or oversized files retain a file icon
and remain downloadable. Rendered model previews are limited to 40 MB; PDF,
image, and embedded 3MF previews to 150 MB.

Attachments use the same context menu as designs, including outside-click,
Escape, scroll and resize dismissal. Each file has a selection checkbox in all
three layouts. Select several files to move or delete them together. Drag any
selected file onto a folder in the sidebar or main area, or onto a breadcrumb
(including All designs) to move the selection. Move to folder is also available
from the shared-style menu and selection toolbar.

Use **File → Import…** to choose a stored STL, 3MF or SVG and add
it to the currently open project. The picker supports search and folder filters,
shows the destination project's name, and downloads a Drive-only original on
demand. The same picker is available through **Import…** in a
supported attachment's context menu. It uses the normal model importer (including
3MF assemblies, SVG options and complexity limits), leaving the saved original
untouched. PDF, text and other reference files remain download-only attachments.


### File actions

- **Open project file…** opens an editable `.shapeforge` file as a separate project.
- **Import…** copies model parts from a file or another saved project into the current one.
- **Save project** keeps it in ShapeForge (this browser or Google Drive).
- **Download project** saves an editable `.shapeforge` copy to your computer.
- **Export model…** prepares an STL or 3MF for printing or another 3D app, then offers **Download STL/3MF**.
- **Store files…** keeps originals in a Home folder without adding geometry. **Download original file** retrieves that attachment unchanged.
