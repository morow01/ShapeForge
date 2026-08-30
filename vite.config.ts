import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project repo (not a user/org page or a custom
  // domain) from a /<repo-name>/ subpath, so every asset URL the built
  // index.html emits has to carry that prefix — the default "/" resolves
  // to the Pages ACCOUNT root instead and 404s everything. Only the
  // Pages workflow build sets GITHUB_PAGES; local `npm run build` /
  // `npm run preview` / `npm run dev` all still serve from "/", unchanged.
  base: process.env.GITHUB_PAGES === "true" ? "/ShapeForge/" : "/",
  // The OCCT wasm glue must not be pre-bundled by esbuild.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  worker: { format: "es" },
});
