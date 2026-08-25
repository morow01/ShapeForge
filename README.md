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

Early and actively evolving — see the version badge in the app's left panel.
