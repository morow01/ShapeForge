import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Plugin } from "vite";

// TEMPORARY: lets the in-app feedback pad (src/ui/FeedbackNotes.tsx) read and
// write FEEDBACK-NOTES.json in the project root while the dev server runs.
const feedbackNotesPlugin = (): Plugin => ({
  name: "feedback-notes",
  apply: "serve",
  configureServer(server) {
    const file = "FEEDBACK-NOTES.json";
    server.middlewares.use("/__feedback", (req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try { JSON.parse(body); writeFileSync(file, body); res.statusCode = 204; } catch { res.statusCode = 400; }
          res.end();
        });
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(existsSync(file) ? readFileSync(file, "utf8") : "[]");
    });
  },
});

export default defineConfig({
  plugins: [react(), feedbackNotesPlugin()],
  // GitHub Pages serves a project repo (not a user/org page or a custom
  // domain) from a /<repo-name>/ subpath, so every asset URL the built
  // index.html emits has to carry that prefix — the default "/" resolves
  // to the Pages ACCOUNT root instead and 404s everything. Only the
  // Pages workflow build sets GITHUB_PAGES; local `npm run build` /
  // `npm run preview` / `npm run dev` all still serve from "/", unchanged.
  base: process.env.ELECTRON === "true" ? "./" : process.env.GITHUB_PAGES === "true" ? "/ShapeForge/" : "/",
  // The OCCT wasm glue must not be pre-bundled by esbuild.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  worker: { format: "es" },
  server: {
    host: true,
    port: 5173,
    watch: {
      ignored: ["**/.electron-stage/**", "**/release/**", "**/dist-desktop/**", "**/build-desktop/**"],
    },
  },
});
