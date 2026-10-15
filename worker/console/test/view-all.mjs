import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { EMPTY_FILTERS, filterPoints, isTrajectoryPoint, validCoordinate } from "../src/model.ts";

const origin = process.env.FOOTPRINT_PREVIEW_URL || "http://127.0.0.1:5173";
async function get(path) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, `Local API unavailable: ${path}`);
  return response.json();
}
const raw = [];
while (true) {
  const result = await get(`/api/locations?view=raw&order=asc&limit=5000&offset=${raw.length}`);
  raw.push(...result.locations);
  if (!result.pagination.hasMore) break;
  assert(result.locations.length, "Pagination must advance.");
}
const projects = [];
while (true) {
  const result = await get(`/api/projects?limit=500&offset=${projects.length}`);
  projects.push(...result.projects);
  if (!result.pagination.hasMore) break;
  assert(result.projects.length);
}
const points = raw.filter(isTrajectoryPoint);
const project = projects.find(candidate => {
  const scoped = filterPoints(raw, { ...EMPTY_FILTERS, project: String(candidate.id) }, projects);
  return scoped.length > 1 && scoped.length < points.length && scoped.some(point => validCoordinate(point)
    && scoped.some(other => other.id !== point.id && validCoordinate(other)
      && Math.abs(other.timestamp - point.timestamp) <= 86_400_000));
});
assert(project, "Real records must include a project with a drawable nearby point window.");
const projectPoints = filterPoints(raw, { ...EMPTY_FILTERS, project: String(project.id) }, projects);
const anchor = projectPoints.find(point => validCoordinate(point)
  && projectPoints.some(other => other.id !== point.id && validCoordinate(other)
    && Math.abs(other.timestamp - point.timestamp) <= 86_400_000));
const historicalProject = projects.find(project => project.endTime < Date.now() - 2 * 86_400_000);
assert(historicalProject, "Real records must include a project that does not overlap today.");
const coordinates = points.filter(validCoordinate);
const expectedBounds = [[Math.min(...coordinates.map(point => point.longitude)), Math.min(...coordinates.map(point => point.latitude))],
  [Math.max(...coordinates.map(point => point.longitude)), Math.max(...coordinates.map(point => point.latitude))]];

const browser = await chromium.launch({ executablePath: process.env.FOOTPRINT_BROWSER_PATH || "/opt/google/chrome/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], apiRequests = [], checked = [];
  page.on("pageerror", error => errors.push(error.message.replace(/pk\.[\w.-]+/g, "[public-token]")));
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/locations") apiRequests.push("locations"); });
  await page.route("**/src/Map.tsx*", async route => {
    const response = await route.fetch(), source = await response.text();
    assert(source.includes("map.current = m;"));
    await route.fulfill({ response, body: source.replace("map.current = m;", "map.current = m; window.__viewAllMap = m;") });
  });
  await page.goto(origin);
  await page.waitForFunction(total => window.__viewAllMap?.isSourceLoaded("footprint-points")
    && window.__viewAllMap.getSource("footprint-points")._data.features.length === total
    && !window.__viewAllMap.isMoving(), points.length, { timeout: 45_000 });
  const initialRequests = apiRequests.length;
  await page.getByRole("heading", { name: "足迹数据", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "坐标手记", exact: true }).count(), 0);
  await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click();
  await page.getByRole("dialog", { name: "足迹数据", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭表格弹窗", exact: true }).click();
  await page.getByRole("button", { name: "打开表格", exact: true }).click();
  await page.evaluate(() => {
    const map = window.__viewAllMap, original = map.fitBounds;
    window.__initialViewAllMap = map; window.__viewAllFits = [];
    map.fitBounds = function (bounds, ...rest) { window.__viewAllFits.push(bounds); return original.call(this, bounds, ...rest); };
  });
  const previewProject = async project => {
    await page.getByRole("tab", { name: "项目", exact: true }).click();
    await page.locator(`tr[data-project-id="${project.id}"]`).locator(".project-name").click();
    await page.getByRole("tab", { name: "位置点", exact: true }).click();
  };
  const reset = async name => {
    const before = await page.evaluate(() => window.__viewAllFits.length);
    const button = page.getByRole("button", { name: "查看全部轨迹并清空连线", exact: true });
    assert.equal(await button.isDisabled(), false, "An empty filtered result must still allow returning to all tracks.");
    await button.click();
    await page.waitForFunction(total => {
      const map = window.__viewAllMap;
      return !map.isMoving() && map.isSourceLoaded("footprint-points") && map.isSourceLoaded("footprint-filtered-points")
        && map.getSource("footprint-filtered-points")._data.features.length === total
        && !map.getSource("footprint-lines")._data.features.length;
    }, points.length, { timeout: 45_000 });
    const result = await page.evaluate(() => {
      const map = window.__viewAllMap;
      return { ids: map.getSource("footprint-filtered-points")._data.features.map(point => point.id),
        clusteredIds: map.getSource("footprint-points")._data.features.map(point => point.id),
        fits: window.__viewAllFits, sameMap: map === window.__initialViewAllMap,
        endpoints: map.getSource("footprint-endpoints")._data.features.length,
        selection: map.getSource("footprint-selection")._data.features.length,
        visibility: ["footprint-lines", "footprint-directions", "footprint-endpoints"].map(id => map.getLayoutProperty(id, "visibility")) };
    });
    assert.deepEqual(result.ids, points.map(point => point.id)); assert.deepEqual(result.clusteredIds, result.ids);
    assert.equal(result.fits.length - before, 1, "Fit the new full collection once, after filters reset.");
    assert.deepEqual(result.fits.at(-1), expectedBounds); assert.equal(result.sameMap, true);
    assert.equal(result.endpoints, 0); assert.equal(result.selection, 0); assert.deepEqual(result.visibility, ["none", "none", "none"]);
    assert.equal(await page.getByLabel("搜索表格数据").inputValue(), "");
    assert.equal(await page.locator(".range-filtered, .point-card, .trajectory-order").count(), 0);
    assert.equal(await page.getByRole("button", { name: "清除项目筛选", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("设备", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "显示原始轨迹", exact: true }).getAttribute("aria-pressed"), "false");
    await page.getByRole("button", { name: "地图图层", exact: true }).click();
    assert.equal(await page.getByRole("switch", { name: "显示位置点", exact: true }).getAttribute("aria-checked"), "true");
    await page.keyboard.press("Escape");
    assert.equal(apiRequests.length, initialRequests);
    checked.push({ name, points: result.ids.length, fitCalls: 1, fullBounds: true });
  };

  await previewProject(project);
  await page.waitForFunction(total => window.__viewAllMap.getSource("footprint-filtered-points")._data.features.length === total
    && !window.__viewAllMap.isMoving(), projectPoints.length);
  await reset("project-filter");

  await previewProject(project);
  await page.getByRole("button", { name: "显示原始轨迹", exact: true }).click();
  await page.getByLabel("搜索表格数据").fill(String(anchor.id));
  await page.getByRole("button", { name: `查看数据点 ${anchor.id}`, exact: true }).click();
  await page.getByRole("button", { name: "绘制前后 24 小时轨迹", exact: true }).click();
  await page.waitForFunction(() => window.__viewAllMap.getSource("footprint-lines")._data.features.length === 1 && !window.__viewAllMap.isMoving());
  await page.getByRole("button", { name: "地图图层", exact: true }).click();
  await page.getByRole("switch", { name: "显示位置点", exact: true }).click(); await page.keyboard.press("Escape");
  await reset("project-search-raw-24h-selection-hidden-points");

  await previewProject(historicalProject);
  await page.locator(".range-button").click(); await page.getByRole("button", { name: "今天", exact: true }).click(); await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__viewAllMap.getSource("footprint-filtered-points")._data.features.length === 0);
  await reset("empty-filter-result");

  await page.locator(".range-button").click(); await page.getByRole("button", { name: "本月", exact: true }).click();
  await page.keyboard.press("Escape"); await reset("timeline-range");
  await reset("already-unfiltered");

  await page.setViewportSize({ width: 390, height: 844 });
  await previewProject(project); await reset("project-filter-mobile");
  assert.deepEqual(errors, []);
  const output = fileURLToPath(new URL("../../../.local/console-preview/", import.meta.url));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const result = { source: "local-api", points: points.length, checked, apiReloads: 0, errors };
  writeFileSync(output + "view-all-reset.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
