import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { isTrajectoryPoint } from "../src/model.ts";

const origin = process.env.FOOTPRINT_PREVIEW_URL || "http://127.0.0.1:5173", observations = [];
while (true) {
  const response = await fetch(`${origin}/api/locations?view=raw&order=asc&limit=5000&offset=${observations.length}`);
  assert.equal(response.status, 200);
  const result = await response.json(); observations.push(...result.locations);
  if (!result.pagination.hasMore) break;
  assert(result.locations.length, "Pagination must advance.");
}
const visibleCount = observations.filter(isTrajectoryPoint).length;

// Uses the configured public Mapbox token and the running local API. The map
// instance is exposed only in this intercepted dev response, never in the app.
const browser = await chromium.launch({
  executablePath: process.env.FOOTPRINT_BROWSER_PATH || "/opt/google/chrome/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", error => errors.push(error.message.replace(/pk\.[\w.-]+/g, "[public-token]")));
await page.route("**/src/Map.tsx*", async route => {
  const response = await route.fetch(), source = await response.text();
  if (!source.includes("map.current = m;")) throw new Error("Map instrumentation anchor not found.");
  await route.fulfill({ response, body: source.replace("map.current = m;", "map.current = m; window.__footprintTestMap = m;") });
});
try {
  await page.goto(origin);
  await page.getByRole("button", { name: "打开表格", exact: true }).click();
  await page.waitForFunction(total => {
    const map = window.__footprintTestMap;
    return map?.getSource("footprint-points") && map.isSourceLoaded("footprint-points")
      && map.isSourceLoaded("footprint-filtered-points")
      && Number(document.querySelector(".drawer-count")?.textContent.replace(/[^\d]/g, "")) === total;
  }, visibleCount, { timeout: 45_000 });
  await page.locator(".row-select").first().click();
  await page.waitForFunction(() => !window.__footprintTestMap.isMoving()
    && window.__footprintTestMap.isSourceLoaded("footprint-filtered-points"));
  const initial = await page.evaluate(() => {
    const map = window.__footprintTestMap;
    const counts = Object.fromEntries(["footprint-points", "footprint-filtered-points", "footprint-clusters", "footprint-lines"].map(id =>
      [id, new Set(map.queryRenderedFeatures({ layers: [id] }).map(f => f.id ?? f.properties.cluster_id)).size]));
    const points = map.getSource("footprint-points")._data, direct = map.getSource("footprint-filtered-points")._data,
      lines = map.getSource("footprint-lines")._data;
    let hitTests = 0;
    const original = map.queryRenderedFeatures;
    map.queryRenderedFeatures = function (...args) { hitTests++; return original.apply(this, args); };
    window.__footprintHitTests = () => hitTests;
    return { zoom: map.getZoom(), renderedFeatures: counts, pointFeatures: points.features.length,
      directPointFeatures: direct.features.length, lineFeatures: lines.features.length,
      geoJSONBytes: JSON.stringify(points).length + JSON.stringify(direct).length + JSON.stringify(lines).length };
  });
  await page.mouse.move(680, 320);
  await page.mouse.down();
  await page.mouse.move(930, 410, { steps: 30 });
  await page.mouse.up();
  await page.waitForFunction(() => !window.__footprintTestMap.isMoving());
  const dragHitTests = await page.evaluate(() => window.__footprintHitTests());
  const results = await page.evaluate(async () => {
    const map = window.__footprintTestMap, gl = map.getCanvas().getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unknown";
    const sourceUpdates = {};
    for (const id of ["footprint-points", "footprint-filtered-points", "footprint-lines"]) {
      sourceUpdates[id] = 0;
      const source = map.getSource(id), original = source.setData;
      source.setData = function (...args) { sourceUpdates[id]++; return original.apply(this, args); };
    }
    const settledCamera = options => new Promise((resolve, reject) => {
      const complete = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => { map.off("idle", complete); reject(new Error("Map did not finish rendering the profiling view.")); }, 30_000);
      map.once("idle", complete); map.jumpTo(options); map.triggerRepaint();
    });
    const measure = async (label, zoomDelta = 1.2) => {
      const times = [], longTasks = [], startCenter = map.getCenter(), startZoom = map.getZoom();
      const destination = { center: [startCenter.lng + .025, startCenter.lat + .015], zoom: startZoom + zoomDelta };
      // Warm both tile levels before comparing footprint layers with the
      // basemap. Waiting for idle also ensures the queried points are from
      // this view, rather than tiles retained from the previous camera.
      await settledCamera(destination);
      await settledCamera({ center: startCenter, zoom: startZoom });
      const onRender = () => times.push(performance.now());
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: "longtask" }); map.on("render", onRender);
      const started = performance.now();
      await new Promise(resolve => {
        map.once("moveend", resolve);
        map.easeTo({ ...destination, duration: 2000 });
      });
      map.off("render", onRender); observer.disconnect();
      const elapsedMs = performance.now() - started;
      const intervals = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
      const result = { label, renderFrames: times.length, elapsedMs: Math.round(elapsedMs),
        renderFPS: Math.round(times.length / elapsedMs * 1000), p95FrameMs: Math.round(intervals[Math.floor(intervals.length * .95)] || 0),
        longTasks: longTasks.length, maxLongTaskMs: Math.round(Math.max(0, ...longTasks)) };
      await settledCamera({ center: startCenter, zoom: startZoom });
      return result;
    };
    const full = await measure("default-layers");
    const cityCenter = map.getCenter(), cityZoom = map.getZoom();
    await settledCamera({ center: cityCenter, zoom: 5.1 });
    const wideViewPoints = new Set(map.queryRenderedFeatures({ layers: ["footprint-filtered-points"] }).map(feature => feature.id)).size;
    const wide = await measure("expanded-points-zoom-5.1", .6);
    const layers = ["footprint-lines", "footprint-points", "footprint-filtered-points", "footprint-clusters", "footprint-count", "footprint-selection-dot", "footprint-selection-ring"];
    for (const id of layers) map.setLayoutProperty(id, "visibility", "none");
    await new Promise(resolve => setTimeout(resolve, 350));
    const wideBase = await measure("basemap-only-zoom-5.1", .6);
    await settledCamera({ center: cityCenter, zoom: cityZoom });
    const base = await measure("basemap-only");
    return { renderer, viewport: [innerWidth, innerHeight], full, base, wide, wideBase, wideViewPoints, sourceUpdates };
  });
  const output = fileURLToPath(new URL("../../../.local/console-preview/", import.meta.url));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const result = { ...results, initial, dragHitTests, errors };
  if (Object.values(result.sourceUpdates).some(count => count > 0)) throw new Error("Camera movement resubmitted full map sources.");
  if (errors.length) throw new Error("Browser errors occurred during map profiling.");
  writeFileSync(output + (process.env.FOOTPRINT_PERF_OUTPUT || "map-performance.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify(await page.evaluate(() => ({
    mapInstanceFound: !!window.__footprintTestMap,
    pointSourceFound: !!window.__footprintTestMap?.getSource("footprint-points"),
    loadedCount: document.querySelector(".drawer-count")?.textContent,
    mapNotice: document.querySelector(".map-notice")?.textContent,
  }))));
  throw error;
} finally { await browser.close(); }
