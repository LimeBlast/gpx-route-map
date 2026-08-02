import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defineConfig } from "vite";
import { isTileRequest, serveTile } from "./scripts/lib/pmtiles-server.mjs";
import { serveFile } from "./scripts/lib/serve-file.mjs";

// The basemap extracts live outside public/ so vite does not copy ~180MB into
// dist on every build; serve them in dev, and from the render server in export.
function basemapPlugin() {
  const basemapDir = path.resolve(import.meta.dirname, "basemap");

  return {
    name: "serve-basemap",
    configureServer(server) {
      server.middlewares.use("/basemap", (request, response) => {
        const requested = decodeURIComponent((request.url || "").split("?")[0]);

        if (isTileRequest(`/basemap${requested}`)) {
          serveTile(basemapDir, `/basemap${requested}`, response);
          return;
        }

        const filePath = path.join(basemapDir, path.normalize(requested));

        if (!filePath.startsWith(basemapDir)) {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }

        serveFile(filePath, request, response);
      });
    }
  };
}

// maplibre resolves its worker relative to its own bundle — ./maplibre-gl-worker.mjs
// next to the built chunk — but vite never emits that file. Without it the
// worker 404s and the map silently loads nothing.
function maplibreWorkerPlugin() {
  return {
    name: "emit-maplibre-worker",
    async closeBundle() {
      const from = path.resolve(import.meta.dirname, "node_modules/maplibre-gl/dist");
      const to = path.resolve(import.meta.dirname, "dist/assets");

      await mkdir(to, { recursive: true });

      // The worker imports ./maplibre-gl-shared.mjs, so that has to travel too
      for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
        await copyFile(path.join(from, file), path.join(to, file));
      }
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [basemapPlugin(), maplibreWorkerPlugin()],
  // Pre-bundling maplibre-gl breaks its worker: the dep directory does not get
  // maplibre-gl-worker.mjs, the worker 404s, and tiles silently never load
  optimizeDeps: { exclude: ["maplibre-gl"] }
});
