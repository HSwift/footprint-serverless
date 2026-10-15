import assert from "node:assert/strict";
import { globSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { EMPTY_FILTERS, filterPoints, formatDate, lineGeoJSON } from "../src/model.ts";
import { projectDateTime } from "../src/project.ts";

// CRUD checks are restricted to the separate local preview DB. Only the temporary
// project created by this run is edited and removed; historical records stay intact.
const origin = process.env.FOOTPRINT_PREVIEW_URL || "http://127.0.0.1:5173";
assert(["127.0.0.1", "localhost"].includes(new URL(origin).hostname), "Project CRUD checks require a local preview.");
const output = fileURLToPath(new URL("../../../.local/console-preview/", import.meta.url));
const databases = globSync(output + "d1/v3/d1/miniflare-D1DatabaseObject/*.sqlite").filter(path => /\/[a-f0-9]{64}\.sqlite$/.test(path));
assert.equal(databases.length, 1, "Use the dedicated historical preview database.");
mkdirSync(output, { recursive: true, mode: 0o700 });
async function get(path) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(10_000) }); assert.equal(response.status, 200); return response.json();
}
assert.equal((await get("/api/console-config")).localPreview, true);
const originalProjects = (await get("/api/projects?limit=500")).projects;
const raw = [];
while (true) {
  const page = await get(`/api/locations?view=raw&order=asc&limit=5000&offset=${raw.length}`);
  raw.push(...page.locations); if (!page.pagination.hasMore) break; assert(page.locations.length);
}
const points = filterPoints(raw, EMPTY_FILTERS, []), latest = points.at(-1);
const sample = originalProjects.find(project => {
  const length = filterPoints(raw, { ...EMPTY_FILTERS, project: String(project.id) }, originalProjects).length;
  return length > 1 && length < points.length;
});
assert(sample && latest);
const name = `项目检查_${Date.now()}`, revisedName = name + "_更新";
let createdId;
const browser = await chromium.launch({ executablePath: process.env.FOOTPRINT_BROWSER_PATH || "/opt/google/chrome/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York", locale: "zh-CN" });
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message.replace(/pk\.[\w.-]+/g, "[public-token]")));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return;
    assert.equal(request.headers().authorization, undefined); assert.equal(request.headers().token, undefined);
    requests.push({ path, method: request.method() });
  });
  await page.route("**/src/Map.tsx*", async route => {
    const response = await route.fetch(), source = await response.text();
    assert(source.includes("map.current = m;"));
    await route.fulfill({ response, body: source.replace("map.current = m;", "map.current = m; window.__projectsMap = m;") });
  });
  await page.goto(origin);
  await page.waitForFunction(total => window.__projectsMap?.isSourceLoaded("footprint-points")
    && window.__projectsMap.getSource("footprint-points")._data.features.length === total
    && !window.__projectsMap.isMoving(), points.length, { timeout: 45_000 });
  const initialLocationRequests = requests.filter(request => request.path === "/api/locations").length;
  assert.equal(await page.locator(".table-scroll").count(), 0);
  await page.getByRole("tab", { name: "项目", exact: true }).click();
  await page.getByRole("table", { name: "项目列表", exact: true }).waitFor();
  assert.equal(await page.locator(".table-scroll").count(), 1);
  assert.equal(await page.locator('select[aria-label="项目"]').count(), 0, "Project dropdown was moved to its own tab.");
  const sampleRow = page.locator(`tr[data-project-id="${sample.id}"]`);
  const expectedSample = filterPoints(raw, { ...EMPTY_FILTERS, project: String(sample.id) }, originalProjects);
  assert.equal((await sampleRow.locator(".project-count").innerText()).replaceAll(",", ""), String(expectedSample.length));
  assert.equal(await sampleRow.getByRole("button", { name: `预览项目 ${sample.name}`, exact: true }).count(), 0);
  await sampleRow.locator(".project-end").click();
  await page.waitForFunction(total => window.__projectsMap.getSource("footprint-filtered-points")._data.features.length === total
    && !window.__projectsMap.isMoving(), expectedSample.length);
  assert.equal(await sampleRow.getAttribute("class"), "project-selected");
  assert.deepEqual(await page.evaluate(() => window.__projectsMap.getSource("footprint-lines")._data.features), lineGeoJSON(expectedSample).features,
    "Clicking any project cell draws its full chronological route.");
  const previewCamera = await page.evaluate(() => ({ center: window.__projectsMap.getCenter().toArray(), zoom: window.__projectsMap.getZoom() }));
  const originals = page.getByRole("button", { name: "显示原始轨迹", exact: true });
  await originals.click();
  const originalSample = raw.filter(point => point.timestamp >= sample.startTime && point.timestamp <= sample.endTime);
  await page.waitForFunction(total => window.__projectsMap.getSource("footprint-filtered-points")._data.features.length === total, originalSample.length);
  assert.equal((await sampleRow.locator(".project-count").innerText()).replaceAll(",", ""), String(originalSample.length));
  assert.deepEqual(await page.evaluate(() => window.__projectsMap.getSource("footprint-lines")._data.features), lineGeoJSON(originalSample).features);
  assert.deepEqual(await page.evaluate(() => ({ center: window.__projectsMap.getCenter().toArray(), zoom: window.__projectsMap.getZoom() })), previewCamera);
  await originals.click();
  await page.waitForFunction(total => window.__projectsMap.getSource("footprint-filtered-points")._data.features.length === total, expectedSample.length);
  await page.getByRole("tab", { name: "位置点", exact: true }).click();
  await page.getByRole("button", { name: "清除项目筛选", exact: true }).waitFor();
  const camera = await page.evaluate(() => ({ center: window.__projectsMap.getCenter().toArray(), zoom: window.__projectsMap.getZoom() }));
  await page.getByRole("button", { name: "清除项目筛选", exact: true }).click();
  await page.waitForFunction(total => window.__projectsMap.getSource("footprint-points")._data.features.length === total, points.length);
  assert.deepEqual(await page.evaluate(() => ({ center: window.__projectsMap.getCenter().toArray(), zoom: window.__projectsMap.getZoom() })), camera);
  assert.equal(await page.evaluate(() => window.__projectsMap.getSource("footprint-lines")._data.features.length), 0);
  assert.equal(await page.evaluate(() => window.__projectsMap.getSource("footprint-endpoints")._data.features.length), 0);
  // Tabs support keyboard selection; changing the tab preserves the map.
  await page.getByRole("tab", { name: "位置点", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "项目", exact: true }).getAttribute("aria-selected"), "true");
  await page.screenshot({ path: output + "projects-desktop.png" });

  await page.getByRole("button", { name: "新增项目", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新增项目", exact: true }); await editor.waitFor();
  const date = formatDate(latest.timestamp).replaceAll(".", "-");
  assert.equal(await editor.getByLabel("开始时间", { exact: true }).inputValue(), `${date}T00:00`);
  await editor.getByLabel("项目名称", { exact: true }).fill(name);
  await editor.getByLabel("结束时间", { exact: true }).fill("2020-01-01T00:00");
  const writesBeforeInvalid = requests.filter(request => request.method !== "GET").length;
  await editor.getByRole("button", { name: "保存项目", exact: true }).click();
  await editor.getByRole("alert").waitFor();
  assert.equal(requests.filter(request => request.method !== "GET").length, writesBeforeInvalid);
  const startTime = Date.parse(`${date}T00:00:00+08:00`), endTime = Date.parse(`${date}T23:59:59+08:00`);
  await editor.getByLabel("结束时间", { exact: true }).fill(`${date}T23:59:59`);
  const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST");
  await editor.getByRole("button", { name: "保存项目", exact: true }).click();
  const response = await created; assert.equal(response.status(), 201);
  const saved = (await response.json()).project; createdId = saved.id;
  assert.deepEqual(saved, { id: createdId, name, startTime, endTime });
  await editor.waitFor({ state: "hidden" });
  let row = page.locator(`tr[data-project-id="${createdId}"]`); await row.waitFor();
  const expected = points.filter(point => point.timestamp >= startTime && point.timestamp <= endTime);
  assert.equal((await row.locator(".project-count").innerText()).replaceAll(",", ""), String(expected.length));
  await row.focus(); await page.keyboard.press("Enter");
  await page.waitForFunction(total => window.__projectsMap.getSource("footprint-filtered-points")._data.features.length === total
    && !window.__projectsMap.isMoving(), expected.length);
  assert.deepEqual(await page.evaluate(() => window.__projectsMap.getSource("footprint-lines")._data.features), lineGeoJSON(expected).features);

  // Edit inside the table dialog, with a second dialog above it.
  await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click();
  const tableDialog = page.getByRole("dialog", { name: "足迹数据", exact: true }); await tableDialog.waitFor();
  await tableDialog.getByRole("button", { name: "显示原始轨迹", exact: true }).click();
  row = tableDialog.locator(`tr[data-project-id="${createdId}"]`);
  await row.getByRole("button", { name: `编辑项目 ${name}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑项目", exact: true }); await edit.waitFor();
  assert.equal(await page.locator(".table-dialog").count(), 1, "Editing does not trigger row preview or close its parent table.");
  assert.equal(await page.locator(".table-dialog .raw-track-toggle").getAttribute("aria-pressed"), "true", "Editing preserves the raw-track setting.");
  await edit.getByLabel("项目名称", { exact: true }).fill(revisedName);
  const changedEnd = latest.timestamp - 1000;
  await edit.getByLabel("结束时间", { exact: true }).fill(projectDateTime(changedEnd));
  const updated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${createdId}` && response.request().method() === "PATCH");
  await edit.getByRole("button", { name: "保存项目", exact: true }).click();
  const updateResponse = await updated; assert.equal(updateResponse.status(), 200);
  const changed = (await updateResponse.json()).project;
  assert.equal(changed.name, revisedName); assert.equal(changed.startTime, startTime);
  assert.equal(changed.endTime, Date.parse(projectDateTime(changedEnd) + "+08:00"));
  await edit.waitFor({ state: "hidden" }); await tableDialog.waitFor();
  await row.getByRole("button", { name: `编辑项目 ${revisedName}`, exact: true }).waitFor();
  assert.equal(await page.locator(".table-scroll").count(), 1);
  await page.keyboard.press("Escape"); await tableDialog.waitFor({ state: "hidden" });
  const expectedEdited = raw.filter(point => point.timestamp >= changed.startTime && point.timestamp <= changed.endTime);
  await page.waitForFunction(total => window.__projectsMap.getSource("footprint-filtered-points")._data.features.length === total
    && !window.__projectsMap.isMoving(), expectedEdited.length);
  assert.deepEqual(await page.evaluate(() => window.__projectsMap.getSource("footprint-lines")._data.features), lineGeoJSON(expectedEdited).features);
  assert.equal(requests.filter(request => request.path === "/api/locations").length, initialLocationRequests, "CRUD and preview must not reload locations.");

  // Reload proves edits are persisted rather than only changed in React state.
  await page.reload(); await page.getByRole("tab", { name: "项目", exact: true }).click();
  await page.getByLabel("搜索项目", { exact: true }).fill(revisedName);
  row = page.locator(`tr[data-project-id="${createdId}"]`);
  await row.getByRole("button", { name: `编辑项目 ${revisedName}`, exact: true }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(100);
    await row.locator(".project-count").click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const toolbarLayout = await page.locator(".project-toolbar > *").evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, width: box.width };
    }).filter(box => box.width > 0));
    for (const [index, box] of toolbarLayout.entries()) {
      assert(box.left >= 0 && box.right <= width, "Project toolbar controls fit on mobile.");
      if (index && Math.abs(box.top - toolbarLayout[index - 1].top) < 5)
        assert(box.left >= toolbarLayout[index - 1].right - 1, "Project toolbar controls do not overlap.");
    }
    assert((await page.getByLabel("搜索项目", { exact: true }).boundingBox()).width >= 100, "Project search keeps enough input space on mobile.");
    await page.screenshot({ path: output + `projects-${width}.png` });
    await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click(); await tableDialog.waitFor();
    await tableDialog.locator(`tr[data-project-id="${createdId}"]`).getByRole("button", { name: `编辑项目 ${revisedName}`, exact: true }).click();
    await edit.waitFor();
    await page.mouse.move(1, 1);
    const box = await edit.boundingBox(); assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width);
    await page.screenshot({ path: output + `project-editor-${width}.png` });
    await page.keyboard.press("Escape"); await edit.waitFor({ state: "hidden" });
    await tableDialog.waitFor();
    await page.waitForFunction(id => document.querySelector(`.table-dialog tr[data-project-id="${id}"] .project-actions button:last-child`) === document.activeElement,
      createdId, { timeout: 5000 });
    await page.keyboard.press("Escape"); await tableDialog.waitFor({ state: "hidden" });
  }
  const locationWrite = await page.evaluate(async body => {
    const response = await fetch("/api/location", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return response.status;
  }, {});
  assert.equal(locationWrite, 405, "The preview keeps location writes blocked.");
  const forbidden = await fetch(origin + "/api/projects", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.com" }, body: "{}" });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(errors, []);
  const result = { source: "local-api", projects: originalProjects.length, rowPreview: true, automaticLines: true, rawToggle: true, create: true, edit: true,
    reloadPersistence: true, timezone: "Shanghai (browser: New York)", mobileWidths: [390, 320], locationReloadsDuringCrud: 0, errors };
  writeFileSync(output + "projects-check.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  const db = new DatabaseSync(databases[0]);
  try { db.prepare("DELETE FROM Projects WHERE Name IN (?, ?)" + (createdId === undefined ? "" : " AND ID = ?"))
    .run(...(createdId === undefined ? [name, revisedName] : [name, revisedName, createdId])); }
  finally { db.close(); }
  assert.deepEqual((await get("/api/projects?limit=500")).projects, originalProjects, "Historical projects must remain unchanged.");
}
