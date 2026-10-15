import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));
function vars(path: string) { return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {}; }
const config = { ...vars(`${root}../api/.dev.vars`), ...vars(`${root}.dev.vars`) };
const ingestToken = config.INGEST_TOKEN || vars(`${root}../api/.dev.vars`).INGEST_TOKEN;

function localConfig(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") {
        const path = req.url.split("?")[0];
        const projectWrite = (req.method === "POST" && path === "/api/projects")
          || (req.method === "PATCH" && /^\/api\/projects\/[1-9]\d*$/.test(path));
        res.setHeader("Cache-Control", "no-store");
        if (!projectWrite) {
          res.statusCode = 405; res.setHeader("Allow", "GET, HEAD");
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: { code: "method_not_allowed", message: "The preview only permits project writes" } }));
          return;
        }
        // The server supplies API credentials, so require writes to originate here.
        if (req.headers.origin !== `http://${req.headers.host}` || req.headers["sec-fetch-site"] === "cross-site") {
          res.statusCode = 403; res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: { code: "forbidden", message: "Project writes require a same-origin request" } }));
          return;
        }
      }
      if (req.url?.split("?")[0] !== "/api/console-config") return next();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      // Only the deliberately public Mapbox token reaches the client.
      const token = config.MAPBOX_PUBLIC_TOKEN || "";
      res.end(JSON.stringify({ mapboxToken: token.startsWith("pk.") ? token : "",
        mapboxStyle: config.MAPBOX_STYLE || "mapbox://styles/mapbox/light-v11", localPreview: true }));
    });
  };
  return { name: "footprint-local-config", configureServer: mount, configurePreviewServer: mount };
}
const proxy: Record<string, ProxyOptions> = { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true,
  configure: server => {
    server.on("proxyReq", req => {
      req.removeHeader("authorization"); req.removeHeader("token");
      if (ingestToken) req.setHeader("authorization", `Bearer ${ingestToken}`);
    });
  },
} };
export default defineConfig({ root, plugins: [localConfig(), react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
