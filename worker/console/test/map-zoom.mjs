import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { isTrajectoryPoint } from "../src/model.ts";

const origin = process.env.FOOTPRINT_PREVIEW_URL || "http://127.0.0.1:5173";
const rawObservations = [];
while (true) {
  const response = await fetch(`${origin}/api/locations?view=raw&order=asc&limit=5000&offset=${rawObservations.length}`);
  assert.equal(response.status, 200);
  const result = await response.json(); rawObservations.push(...result.locations);
  if (!result.pagination.hasMore) break;
  assert(result.locations.length, "Pagination must advance.");
}
const observations = rawObservations.filter(isTrajectoryPoint);
assert(observations.length > 1);
const anchor = observations.at(-1), center = [anchor.longitude, anchor.latitude];
const browser = await chromium.launch({
  executablePath: process.env.FOOTPRINT_BROWSER_PATH || "/opt/google/chrome/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], apiRequests = [];
page.on("pageerror", error => errors.push(error.message.replace(/pk\.[\w.-]+/g, "[public-token]")));
page.on("request", request => {
  if (new URL(request.url()).pathname === "/api/locations") apiRequests.push(request.url());
});
// Expose the real Mapbox instance only inside this check browser. API records,
// tiles and source processing are unchanged and are never replaced with mocks.
await page.route("**/src/Map.tsx*", async route => {
  const response = await route.fetch(), source = await response.text();
  assert(source.includes("map.current = m;"));
  await route.fulfill({ response, body: source.replace("map.current = m;", "map.current = m; window.__footprintTestMap = m;") });
});
const camera = async (zoom, direct = zoom > 5) => {
  await page.evaluate(({ zoom, center }) => window.__footprintTestMap.jumpTo({ zoom, center }), { zoom, center });
  await page.waitForFunction(({ zoom, direct }) => {
    const map = window.__footprintTestMap, id = direct ? "footprint-filtered-points" : "footprint-clusters";
    return Math.abs(map.getZoom() - zoom) < 1e-8 && !map.isMoving()
      && map.isSourceLoaded(direct ? "footprint-filtered-points" : "footprint-points")
      && map.queryRenderedFeatures({ layers: [id] }).length > 0;
  }, { zoom, direct }, { timeout: 45_000 });
};
try {
  await page.goto(origin);
  await page.getByRole("button", { name: "打开表格", exact: true }).click();
  await page.waitForFunction(total => {
    const map = window.__footprintTestMap;
    return map?.isSourceLoaded("footprint-points") && map.isSourceLoaded("footprint-filtered-points") && !map.isMoving()
      && map.getSource("footprint-points")._data.features.length === total
      && map.getSource("footprint-filtered-points")._data.features.length === total;
  }, observations.length, { timeout: 45_000 });
  assert.deepEqual(await page.evaluate(() => window.__footprintTestMap.getSource("footprint-filtered-points")._data.features.map(feature => feature.id)), observations.map(point => point.id));
  const initialApiRequests = apiRequests.length;
  await page.evaluate(() => {
    const map = window.__footprintTestMap;
    window.__footprintInitialMap = map;
    window.__footprintZoomUpdates = { sources: {}, pointLayout: 0, tableMutations: 0 };
    for (const id of ["footprint-points", "footprint-filtered-points", "footprint-lines"]) {
      const source = map.getSource(id), original = source.setData;
      window.__footprintZoomUpdates.sources[id] = 0;
      source.setData = function (...args) { window.__footprintZoomUpdates.sources[id]++; return original.apply(this, args); };
    }
    const originalLayout = map.setLayoutProperty;
    map.setLayoutProperty = function (id, property, ...args) {
      if (property === "visibility" && ["footprint-points", "footprint-filtered-points", "footprint-clusters", "footprint-count"].includes(id))
        window.__footprintZoomUpdates.pointLayout++;
      return originalLayout.call(this, id, property, ...args);
    };
    const observer = new MutationObserver(records => { window.__footprintZoomUpdates.tableMutations += records.length; });
    observer.observe(document.querySelector(".data-drawer"), { subtree: true, childList: true, characterData: true });
    window.__footprintTableObserver = observer;
  });
  const levels = [];
  for (const zoom of [4.99, 5, 5.0001, 5.8, 6, 14, 5, 4]) {
    const before = await page.evaluate(() => window.__footprintZoomUpdates.pointLayout);
    await camera(zoom);
    const snapshot = await page.evaluate(() => {
      const map = window.__footprintTestMap;
      const visibility = Object.fromEntries(["footprint-points", "footprint-filtered-points", "footprint-clusters", "footprint-count"].map(id => [id, map.getLayoutProperty(id, "visibility")]));
      return { zoom: map.getZoom(), visibility,
        renderedClusters: map.queryRenderedFeatures({ layers: ["footprint-clusters", "footprint-count"] }).length,
        renderedPoints: new Set(map.queryRenderedFeatures({ layers: ["footprint-filtered-points"] }).map(feature => feature.id)).size,
        sameMap: map === window.__footprintInitialMap,
        layoutChanges: window.__footprintZoomUpdates.pointLayout };
    });
    const direct = zoom > 5;
    assert.equal(snapshot.visibility["footprint-filtered-points"], direct ? "visible" : "none");
    for (const id of ["footprint-points", "footprint-clusters", "footprint-count"])
      assert.equal(snapshot.visibility[id], direct ? "none" : "visible");
    assert.equal(snapshot.sameMap, true);
    if (direct) { assert.equal(snapshot.renderedClusters, 0); assert(snapshot.renderedPoints > 0); }
    else assert(snapshot.renderedClusters > 0);
    const previous = levels.at(-1);
    if (previous && (previous.zoom > 5) === direct) assert.equal(snapshot.layoutChanges, before, "Zooms in the same mode must not rewrite visibility.");
    levels.push({ zoom, renderedClusters: snapshot.renderedClusters, renderedPoints: snapshot.renderedPoints });
  }
  const updates = await page.evaluate(() => {
    window.__footprintTableObserver.disconnect();
    return { ...window.__footprintZoomUpdates, clusterMaxZoom: window.__footprintTestMap.getStyle().sources["footprint-points"].clusterMaxZoom };
  });
  assert(Object.values(updates.sources).every(value => value === 0), "Zooming must never resubmit point or line data.");
  assert.equal(updates.tableMutations, 0, "Camera changes must not rerender the table.");
  assert.equal(updates.clusterMaxZoom, 5);
  assert.equal(apiRequests.length, initialApiRequests, "Camera changes must not reload API observations.");
  assert.equal(await page.locator(".mapboxgl-marker").count(), 0, "Use WebGL circles for the full dataset.");
  // Verify a real unclustered map point remains selectable at high zoom.
  await camera(14);
  const position = await page.evaluate(center => window.__footprintTestMap.project(center), center);
  await page.mouse.click(position.x, position.y);
  await page.getByRole("complementary", { name: "选中位置详情" }).waitFor();
  await page.getByRole("button", { name: "绘制前后 24 小时轨迹", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭位置详情", exact: true }).click();
  await page.getByRole("button", { name: "地图图层", exact: true }).click();
  const pointsToggle = page.getByRole("switch", { name: "显示位置点", exact: true });
  await pointsToggle.click();
  // Hidden points are checked without waiting for visible rendered features.
  for (const zoom of [5, 5.1]) {
    await page.evaluate(({ center, zoom }) => window.__footprintTestMap.jumpTo({ center, zoom }), { center, zoom });
    await page.waitForFunction(() => ["footprint-points", "footprint-filtered-points", "footprint-clusters", "footprint-count"].every(id => window.__footprintTestMap.getLayoutProperty(id, "visibility") === "none"));
  }
  await pointsToggle.click(); await page.keyboard.press("Escape");
  // An exact 24-hour context continues to disable aggregation at every zoom.
  await page.getByLabel("搜索表格数据").fill(String(anchor.id));
  await page.getByRole("button", { name: `查看数据点 ${anchor.id}`, exact: true }).click();
  await page.getByRole("button", { name: "绘制前后 24 小时轨迹", exact: true }).click();
  const contextPoints = observations.filter(point => Math.abs(point.timestamp - anchor.timestamp) <= 86_400_000);
  await page.waitForFunction(total => window.__footprintTestMap.getSource("footprint-filtered-points")._data.features.length === total, contextPoints.length);
  await camera(3, true);
  assert.deepEqual(await page.evaluate(() => window.__footprintTestMap.getSource("footprint-filtered-points")._data.features.map(feature => feature.id)), contextPoints.map(point => point.id));
  assert.equal(await page.evaluate(() => window.__footprintTestMap.getLayoutProperty("footprint-clusters", "visibility")), "none");
  assert.equal(errors.length, 0);
  const output = fileURLToPath(new URL("../../../.local/console-preview/", import.meta.url));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const result = { source: "local-api", total: observations.length, threshold: 5, levels, cameraUpdates: updates,
    apiReloads: apiRequests.length - initialApiRequests, mapPointSelection: true, filteredAtLowZoom: true, errors };
  writeFileSync(output + "map-zoom.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
