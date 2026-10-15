import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { isTrajectoryPoint } from "../src/model.ts";
import { calendarDay, dayDate, MAX_RANGE_DAYS, monthWindow } from "../src/timeline.ts";

const origin = process.env.FOOTPRINT_PREVIEW_URL || "http://127.0.0.1:5173";
const rawObservations = [];
while (true) {
  const response = await fetch(`${origin}/api/locations?view=raw&order=asc&limit=5000&offset=${rawObservations.length}`);
  assert.equal(response.status, 200);
  const page = await response.json(); rawObservations.push(...page.locations);
  if (!page.pagination.hasMore) break;
  assert(page.locations.length, "Pagination must advance.");
}
const observations = rawObservations.filter(isTrajectoryPoint);
assert(observations.length > 1, "Load real records before checking map selection.");
const browser = await chromium.launch({
  executablePath: process.env.FOOTPRINT_BROWSER_PATH || "/opt/google/chrome/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message.replace(/pk\.[\w.-]+/g, "[public-token]")));
// Instrument the real Mapbox instance only in this check browser. API data
// and Mapbox responses are loaded normally, without mocked records or tiles.
await page.route("**/src/Map.tsx*", async route => {
  const response = await route.fetch(), source = await response.text();
  assert(source.includes("map.current = m;"));
  await route.fulfill({ response, body: source.replace("map.current = m;", "map.current = m; window.__footprintTestMap = m;") });
});
try {
  await page.goto(origin);
  await page.getByRole("button", { name: "打开表格", exact: true }).click();
  await page.waitForFunction(total => {
    const map = window.__footprintTestMap;
    return map?.isSourceLoaded("footprint-points") && map.getSource("footprint-points")._data.features.length === total;
  }, observations.length, { timeout: 45_000 });
  await page.evaluate(() => { window.__footprintInitialMap = window.__footprintTestMap; });
  await page.locator(".range-button").click();
  const axis = await page.locator(".timeline-axis").boundingBox(); assert(axis);
  await page.mouse.click(axis.x + axis.width * .9, axis.y + axis.height - 5);
  const startThumb = page.getByRole("slider", { name: "范围开始日期", exact: true });
  const endThumb = page.getByRole("slider", { name: "范围结束日期", exact: true });
  await startThumb.focus(); await page.keyboard.press("Home");
  const since = await startThumb.getAttribute("aria-valuetext"), until = await endThumb.getAttribute("aria-valuetext");
  const start = Date.parse(`${since}T00:00:00+08:00`), end = Date.parse(`${until}T23:59:59.999+08:00`);
  assert(end - start < MAX_RANGE_DAYS * 86_400_000);
  const selected = observations.filter(p => p.timestamp >= start && p.timestamp <= end);
  assert(selected.length > 1);
  const coordinates = [];
  for (const point of selected) {
    const position = [point.longitude, point.latitude].map(value => Math.round(value * 1e6) / 1e6);
    if (!coordinates.length || position.some((value, i) => value !== coordinates.at(-1)[i])) coordinates.push(position);
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(total => {
    const map = window.__footprintTestMap;
    return map.isSourceLoaded("footprint-filtered-points") && map.isSourceLoaded("footprint-lines")
      && map.getSource("footprint-filtered-points")._data.features.length === total && !map.isMoving()
      && map.queryRenderedFeatures({ layers: ["footprint-filtered-points"] }).length > 0;
  }, selected.length, { timeout: 45_000 });
  const filtered = await page.evaluate(() => {
    const map = window.__footprintTestMap;
    const updates = {};
    for (const id of ["footprint-points", "footprint-filtered-points", "footprint-lines"]) {
      const source = map.getSource(id), original = source.setData; updates[id] = 0;
      source.setData = function (...args) { updates[id]++; return original.apply(this, args); };
    }
    window.__footprintSelectionUpdates = updates;
    return { sameMap: map === window.__footprintInitialMap,
      clustered: map.getStyle().sources["footprint-filtered-points"].cluster,
      ids: map.getSource("footprint-filtered-points")._data.features.map(f => f.id),
      line: map.getSource("footprint-lines")._data,
      renderedClusters: map.queryRenderedFeatures({ layers: ["footprint-clusters", "footprint-count"] }).length,
      renderedPoints: new Set(map.queryRenderedFeatures({ layers: ["footprint-filtered-points"] }).map(f => f.id)).size,
    };
  });
  assert.equal(filtered.sameMap, true); assert.equal(filtered.clustered, false); assert.equal(filtered.renderedClusters, 0);
  assert.deepEqual(filtered.ids, selected.map(p => p.id));
  assert.equal(filtered.line.features.length, 1);
  assert.deepEqual(filtered.line.features[0].geometry, { type: "LineString", coordinates });
  const output = fileURLToPath(new URL("../../../.local/console-preview/", import.meta.url));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: output + "filtered-map.png" });
  await page.locator(".range-button").click();
  const panAxis = await page.locator(".timeline-axis").boundingBox(); assert(panAxis);
  const positionsBeforePan = [await startThumb.boundingBox(), await endThumb.boundingBox()];
  await page.mouse.move(panAxis.x + panAxis.width * .5, panAxis.y + panAxis.height - 5); await page.mouse.down();
  await page.mouse.move(panAxis.x + panAxis.width * .7, panAxis.y + panAxis.height - 5, { steps: 10 });
  const previewUpdates = await page.evaluate(() => ({ ...window.__footprintSelectionUpdates }));
  assert(Object.values(previewUpdates).every(value => value === 0), "Dragging the axis must preview without resubmitting map data.");
  await page.mouse.up();
  const shiftedSince = await startThumb.getAttribute("aria-valuetext"), shiftedUntil = await endThumb.getAttribute("aria-valuetext");
  const shiftedStart = Date.parse(`${shiftedSince}T00:00:00+08:00`), shiftedEnd = Date.parse(`${shiftedUntil}T23:59:59.999+08:00`);
  const shiftedPoints = observations.filter(point => point.timestamp >= shiftedStart && point.timestamp <= shiftedEnd);
  assert.equal(shiftedEnd - shiftedStart, end - start);
  assert(shiftedStart < start);
  for (const [index, thumb] of [startThumb, endThumb].entries()) {
    const position = await thumb.boundingBox(); assert(position && positionsBeforePan[index]);
    assert(Math.abs(position.x - positionsBeforePan[index].x) < 2, "Panning must keep the selection at its screen position.");
  }
  await page.waitForFunction(total => {
    const map = window.__footprintTestMap;
    return map.isSourceLoaded("footprint-filtered-points") && map.isSourceLoaded("footprint-lines")
      && map.getSource("footprint-filtered-points")._data.features.length === total && !map.isMoving();
  }, shiftedPoints.length, { timeout: 45_000 });
  const updates = await page.evaluate(() => window.__footprintSelectionUpdates);
  assert.deepEqual(updates, { "footprint-points": 0, "footprint-filtered-points": 1, "footprint-lines": 1 }, "A pan should commit map data only once on release.");
  assert.deepEqual(await page.evaluate(() => window.__footprintTestMap.getSource("footprint-filtered-points")._data.features.map(feature => feature.id)), shiftedPoints.map(point => point.id));
  await page.keyboard.press("Escape");
  // Historical gaps need not have observations just outside the panned range.
  // Choose a real day boundary with nearby observations, then isolate that day
  // to verify the point action expands beyond the current filter reliably.
  const anchor = observations.findLast((point, index) => index > 0
    && calendarDay(observations[index - 1].timestamp) < calendarDay(point.timestamp)
    && point.timestamp - observations[index - 1].timestamp < 86_400_000);
  assert(anchor, "Real records must include a nearby observation across a day boundary.");
  const anchorDay = calendarDay(anchor.timestamp), anchorDate = dayDate(anchorDay);
  await page.locator(".range-button").click();
  await page.getByLabel("选择年月").selectOption(anchorDate.slice(0, 7));
  const anchorWindow = monthWindow(anchorDate.slice(0, 7));
  const anchorAxis = await page.locator(".timeline-axis").boundingBox(); assert(anchorAxis);
  await page.mouse.click(anchorAxis.x + 12 + (anchorDay - anchorWindow[0]) / (anchorWindow[1] - anchorWindow[0]) * (anchorAxis.width - 24),
    anchorAxis.y + anchorAxis.height - 5);
  assert.equal(await startThumb.getAttribute("aria-valuetext"), anchorDate);
  assert.equal(await endThumb.getAttribute("aria-valuetext"), anchorDate);
  const anchorDayPoints = observations.filter(point => calendarDay(point.timestamp) === anchorDay);
  await page.waitForFunction(total => window.__footprintTestMap.getSource("footprint-filtered-points")._data.features.length === total, anchorDayPoints.length);
  await page.keyboard.press("Escape");
  const context = observations.filter(point => Math.abs(point.timestamp - anchor.timestamp) <= 86_400_000);
  assert(context.some(point => calendarDay(point.timestamp) < anchorDay), "The point action must be able to expand beyond the previous date filter.");
  await page.getByLabel("搜索表格数据").fill(String(anchor.id));
  await page.getByRole("button", { name: `查看数据点 ${anchor.id}`, exact: true }).click();
  await page.getByLabel("搜索表格数据").fill("");
  await page.getByRole("button", { name: "绘制前后 24 小时轨迹", exact: true }).click();
  await page.waitForFunction(total => {
    const map = window.__footprintTestMap;
    return map.isSourceLoaded("footprint-filtered-points") && map.isSourceLoaded("footprint-lines")
      && map.getSource("footprint-filtered-points")._data.features.length === total && !map.isMoving();
  }, context.length, { timeout: 45_000 });
  const contextMap = await page.evaluate(() => {
    const map = window.__footprintTestMap;
    return { ids: map.getSource("footprint-filtered-points")._data.features.map(feature => feature.id),
      line: map.getSource("footprint-lines")._data,
      anchor: map.getSource("footprint-selection")._data.features[0]?.id,
      clustered: map.getStyle().sources["footprint-filtered-points"].cluster };
  });
  const contextCoordinates = [];
  for (const point of context) {
    const position = [point.longitude, point.latitude].map(value => Math.round(value * 1e6) / 1e6);
    if (!contextCoordinates.length || position.some((value, i) => value !== contextCoordinates.at(-1)[i])) contextCoordinates.push(position);
  }
  assert.deepEqual(contextMap.ids, context.map(point => point.id));
  assert.equal(contextMap.anchor, anchor.id); assert.equal(contextMap.clustered, false);
  assert.equal(contextMap.line.features.length, 1);
  assert.deepEqual(contextMap.line.features[0].geometry, { type: "LineString", coordinates: contextCoordinates });
  await page.screenshot({ path: output + "point-context.png" });
  await page.locator(".range-button").click();
  assert((await page.getByLabel("选取时间范围", { exact: true }).innerText()).includes("48 小时"));
  const contextHandle = await startThumb.boundingBox(), contextAxis = await page.locator(".timeline-axis").boundingBox();
  assert(contextHandle && contextAxis);
  const labelBeforeContextPan = await page.locator(".range-button").innerText();
  await page.mouse.move(contextAxis.x + contextAxis.width * .5, contextAxis.y + contextAxis.height - 5); await page.mouse.down();
  await page.mouse.move(contextAxis.x + contextAxis.width * .55, contextAxis.y + contextAxis.height - 5, { steps: 10 }); await page.mouse.up();
  const contextShift = Number(await startThumb.getAttribute("aria-valuenow"))
    - Math.floor((anchor.timestamp - 86_400_000 + 8 * 3_600_000) / 86_400_000);
  assert(contextShift < 0);
  const movedContext = observations.filter(point => Math.abs(point.timestamp - (anchor.timestamp + contextShift * 86_400_000)) <= 86_400_000);
  await page.waitForFunction(total => window.__footprintTestMap.getSource("footprint-filtered-points")._data.features.length === total, movedContext.length);
  assert.deepEqual(await page.evaluate(() => window.__footprintTestMap.getSource("footprint-filtered-points")._data.features.map(feature => feature.id)), movedContext.map(point => point.id));
  assert((await page.getByLabel("选取时间范围", { exact: true }).innerText()).includes("48 小时"), "Panning must preserve the precise 48-hour duration.");
  const labelAfterContextPan = await page.locator(".range-button").innerText();
  assert.notEqual(labelAfterContextPan, labelBeforeContextPan);
  assert.deepEqual(labelAfterContextPan.match(/\d{2}:\d{2}/g), labelBeforeContextPan.match(/\d{2}:\d{2}/g), "Panning must preserve the exact clock times.");
  const movedContextHandle = await startThumb.boundingBox(); assert(movedContextHandle);
  assert(Math.abs(contextHandle.x - movedContextHandle.x) < 2);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^查看数据点 \d+$/ }).first().click();
  await page.getByRole("button", { name: "关闭位置详情", exact: true }).click();
  await page.waitForFunction(total => {
    const map = window.__footprintTestMap;
    const direct = map.getZoom() > 5;
    return map.getLayoutProperty("footprint-clusters", "visibility") === (direct ? "none" : "visible")
      && map.getLayoutProperty("footprint-filtered-points", "visibility") === (direct ? "visible" : "none")
      && map.getSource("footprint-points")._data.features.length === total
      && map.getSource("footprint-filtered-points")._data.features.length === total
      && map.getSource("footprint-lines")._data.features.length === 0
      && map.getSource("footprint-selection")._data.features.length === 0;
  }, observations.length);
  assert.equal(await page.locator(".range-filtered, .point-card").count(), 0);
  assert.equal(errors.length, 0);
  const result = { source: "local-api", total: observations.length, selected: selected.length, since, until,
    renderedPoints: filtered.renderedPoints, renderedClusters: filtered.renderedClusters, continuousLines: filtered.line.features.length,
    lineVertices: coordinates.length, mapReused: filtered.sameMap, panningSourceUpdates: updates,
    pannedRange: { since: shiftedSince, until: shiftedUntil, points: shiftedPoints.length, selectionPinned: true },
    pointContext: { hours: 48, points: context.length, lineVertices: contextCoordinates.length, anchorPreserved: true, clearedOnCardClose: true }, aggregationRestored: true, errors };
  writeFileSync(output + "map-selection.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
