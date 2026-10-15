import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { formatDate, formatTime, isTrajectoryPoint } from "../src/model.ts";
import { dayDate, MAX_RANGE_DAYS, quickRange } from "../src/timeline.ts";

const origin = process.env.FOOTPRINT_PREVIEW_URL || "http://127.0.0.1:5173";
const executablePath = process.env.FOOTPRINT_BROWSER_PATH || "/opt/google/chrome/chrome";
if (!existsSync(executablePath)) throw new Error("Set FOOTPRINT_BROWSER_PATH to a local Chromium executable.");
const output = fileURLToPath(new URL("../../../.local/console-preview/", import.meta.url));
mkdirSync(output, { recursive: true, mode: 0o700 });

// Read expected observations from the actual local API. Requests and Mapbox
// configuration are never intercepted or replaced with generated records.
async function get(path) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, `Local API unavailable: ${path}`);
  return response.json();
}
const rawPoints = [], offsets = [];
let hasMore = true;
while (hasMore) {
  const offset = rawPoints.length;
  const page = await get(`/api/locations?view=raw&order=asc&limit=5000&offset=${offset}`);
  assert(Array.isArray(page.locations) && page.pagination);
  assert(page.locations.length || !page.pagination.hasMore, "API pagination cannot advance.");
  rawPoints.push(...page.locations); offsets.push(offset); hasMore = page.pagination.hasMore;
}
const points = rawPoints.filter(isTrajectoryPoint);
assert(points.length > 1, "Load real historical records before running browser checks.");
if (process.env.FOOTPRINT_SNAPSHOT) {
  const original = JSON.parse(readFileSync(process.env.FOOTPRINT_SNAPSHOT, "utf8")).sort((a, b) => a.Date - b.Date || a.ID - b.ID);
  assert.deepEqual(rawPoints.map(p => [p.id, p.timestamp, p.longitude, p.latitude, p.device, p.city]),
    original.map(p => [p.ID, p.Date, p.Longitude, p.Latitude, p.Device, p.City]));
}
const config = await get("/api/console-config");
const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const latest = points.at(-1), oldest = points[0];
const latestQueryCount = points.filter(point => [point.id, point.city, point.device, formatDate(point.timestamp), formatTime(point.timestamp), point.longitude.toFixed(6), point.latitude.toFixed(6)]
  .some(value => String(value ?? "").includes(String(latest.id)))).length;
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [], calls = [];
page.on("pageerror", error => errors.push(error.message.replace(/pk\.[\w.-]+/g, "[public-token]")));
page.on("request", request => {
  const url = new URL(request.url());
  if (url.pathname !== "/api/locations") return;
  assert.equal(request.headers().authorization, undefined, "API credentials must stay in the local server.");
  assert.equal(request.headers().token, undefined);
  calls.push(Number(url.searchParams.get("offset")));
});
const hasOverflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const waitCount = n => page.waitForFunction(expected => Number(document.querySelector(".drawer-count")?.textContent.replace(/[^\d]/g, "")) === expected, n);
try {
  const start = performance.now();
  await page.goto(origin);
  await page.getByRole("heading", { name: "footprint." }).waitFor();
  await waitCount(points.length);
  assert.equal(await page.locator(".table-scroll").count(), 0, "The table starts collapsed.");
  await page.getByRole("button", { name: "打开表格", exact: true }).click();
  await page.getByRole("button", { name: `查看数据点 ${latest.id}`, exact: true }).waitFor();
  const loadMs = Math.round(performance.now() - start), renderedRows = await page.locator("tbody tr").count();
  assert(renderedRows < 40, "Table should virtualize rather than mount all observations.");
  assert.deepEqual(calls, offsets);
  assert.equal(await page.getByRole("button", { name: "示例", exact: true }).count(), 0);
  assert.equal(await page.locator(".source-switch, .offline-map").count(), 0);
  assert.equal(await hasOverflow(), false);
  if (config.mapboxToken) {
    await page.locator(".mapboxgl-canvas").waitFor({ timeout: 45_000 });
    await page.waitForFunction(() => !document.querySelector(".map-notice"), null, { timeout: 45_000 });
  }
  await page.screenshot({ path: output + "desktop.png" });
  await page.getByRole("button", { name: `查看数据点 ${latest.id}`, exact: true }).click();
  await page.getByRole("complementary", { name: "选中位置详情" }).waitFor();
  assert((await page.locator(".point-card").innerText()).includes(latest.longitude.toFixed(6)));
  assert((await page.locator(".point-card").innerText()).includes(latest.latitude.toFixed(6)));
  await page.getByRole("button", { name: "上一个", exact: true }).click();
  assert((await page.locator(".point-card-heading").innerText()).includes(String(points.at(-2).id)));
  await page.getByRole("button", { name: "下一个", exact: true }).click();
  await page.screenshot({ path: output + "selected.png" });
  const aroundLatest = points.filter(p => Math.abs(p.timestamp - latest.timestamp) <= 86_400_000);
  await page.getByRole("button", { name: "绘制前后 24 小时轨迹", exact: true }).click();
  await waitCount(aroundLatest.length);
  assert((await page.locator(".point-card-heading").innerText()).includes(String(latest.id)), "The anchor point must stay selected.");
  assert.match(await page.locator(".range-button").innerText(), /\d{2}:\d{2}/);
  await page.locator(".range-button").click();
  assert((await page.getByLabel("选取时间范围", { exact: true }).innerText()).includes("48 小时"));
  assert.equal(await page.getByRole("slider", { name: "范围结束日期", exact: true }).getAttribute("aria-valuetext"), dateFormat.format(latest.timestamp + 86_400_000));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "关闭位置详情", exact: true }).click();
  await waitCount(points.length);
  assert.equal(await page.locator(".range-filtered, .point-card").count(), 0, "Closing the point card must also clear its 24-hour context.");

  await page.getByLabel("搜索表格数据").fill(String(latest.id));
  await page.getByRole("button", { name: `查看数据点 ${latest.id}`, exact: true }).waitFor();
  assert((await page.locator("tbody tr").count()) > 0);
  await page.getByLabel("搜索表格数据").fill("");
  await waitCount(points.length);
  await page.getByRole("button", { name: "地图图层", exact: true }).click();
  const layerMenu = page.locator(".layer-popover");
  assert.equal(await layerMenu.getByRole("switch").count(), 3);
  assert.equal(await layerMenu.getByRole("switch", { name: "显示位置点", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await layerMenu.getByRole("switch", { name: "显示国境线", exact: true }).getAttribute("aria-checked"), "false");
  assert.equal(await layerMenu.getByRole("switch", { name: "显示地名", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await layerMenu.locator(".helper").count(), 0);
  await page.keyboard.press("Escape");
  await page.locator(".range-button").click();
  const date = dateFormat.format(latest.timestamp);
  assert.equal(await page.locator('input[type="date"]').count(), 0, "The date form is replaced by a timeline.");
  assert.equal(await page.getByLabel("设备", { exact: true }).count(), 0, "Device filtering is removed.");
  const desktopTimeline = await page.locator(".timeline-popover").boundingBox();
  assert(desktopTimeline && desktopTimeline.width >= 1000 && desktopTimeline.height < 130, "The timeline should be a long, compact two-row strip.");
  const dailyTicks = await page.locator(".timeline-tick").count();
  assert(dailyTicks >= 89 && dailyTicks <= 92, "The axis must show three complete months with daily ticks.");
  assert(await page.locator(".timeline-tick b").count() >= 18, "Dates should be denser than the previous five labels.");
  assert.equal(await page.getByRole("button", { name: "绘制轨迹", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "关闭时间轴", exact: true }).count(), 0);
  const startThumb = page.getByRole("slider", { name: "范围开始日期", exact: true });
  const endThumb = page.getByRole("slider", { name: "范围结束日期", exact: true });
  await startThumb.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  const sameDay = points.filter(p => dateFormat.format(p.timestamp) === date);
  await waitCount(sameDay.length);
  assert((await page.getByLabel("选取时间范围").innerText()).includes("1 天"));
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索表格数据").fill(String(latest.id));
  await page.getByRole("button", { name: `查看数据点 ${latest.id}`, exact: true }).click();
  await page.getByLabel("搜索表格数据").fill("");
  await page.getByRole("button", { name: "关闭位置详情", exact: true }).click();
  await waitCount(sameDay.length);
  assert.equal(await page.locator(".range-filtered").count(), 1, "Closing a normal point card must preserve a manual timeline selection.");
  await page.locator(".range-button").click();
  await startThumb.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  const expectedCount = async () => {
    const start = Number(await startThumb.getAttribute("aria-valuenow"));
    const end = Number(await endThumb.getAttribute("aria-valuenow"));
    assert(end >= start && end - start < MAX_RANGE_DAYS, "Timeline selection cannot exceed 31 inclusive days.");
    return points.filter(p => {
      const day = Math.floor((p.timestamp + 8 * 3_600_000) / 86_400_000);
      return day >= start && day <= end;
    }).length;
  };
  await waitCount(await expectedCount());
  const beforeDragCount = await expectedCount();
  const handle = await startThumb.boundingBox(), axis = await page.locator(".timeline-axis").boundingBox();
  assert(handle && axis);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(axis.x + 1, handle.y + handle.height / 2, { steps: 12 });
  assert.equal(Number((await page.locator(".drawer-count").innerText()).replace(/[^\d]/g, "")), beforeDragCount,
    "Dragging previews the range without updating the map/table until release.");
  await expectedCount();
  assert.equal(Number(await endThumb.getAttribute("aria-valuenow")) - Number(await startThumb.getAttribute("aria-valuenow")), MAX_RANGE_DAYS - 1,
    "Dragging past the month limit must stop at 31 days.");
  await page.mouse.up();
  await waitCount(await expectedCount());
  assert.equal(Number(await endThumb.getAttribute("aria-valuenow")) - Number(await startThumb.getAttribute("aria-valuenow")), MAX_RANGE_DAYS - 1);
  const selectedDates = [Number(await startThumb.getAttribute("aria-valuenow")), Number(await endThumb.getAttribute("aria-valuenow"))];
  const selectedPositions = [await startThumb.boundingBox(), await endThumb.boundingBox()];
  const initialTicks = await page.locator(".timeline-ticks").innerText();
  const panBody = async delta => {
    const bounds = await page.locator(".timeline-axis").boundingBox();
    assert(bounds);
    const x = bounds.x + bounds.width * .5, y = bounds.y + bounds.height - 5;
    await page.mouse.move(x, y); await page.mouse.down();
    const countBeforePan = await page.locator(".drawer-count").innerText();
    await page.mouse.move(x + delta * bounds.width, y, { steps: 10 });
    assert.equal(await page.locator(".drawer-count").innerText(), countBeforePan, "Axis dragging previews until release.");
    await page.mouse.up();
  };
  await panBody(.25);
  assert.notEqual(await page.locator(".timeline-ticks").innerText(), initialTicks, "Dragging the axis body must browse history.");
  const movedDates = [Number(await startThumb.getAttribute("aria-valuenow")), Number(await endThumb.getAttribute("aria-valuenow"))];
  assert(movedDates[0] < selectedDates[0], "Panning to the past must shift selected dates too.");
  assert.equal(movedDates[1] - movedDates[0], selectedDates[1] - selectedDates[0]);
  for (const [index, thumb] of [startThumb, endThumb].entries()) {
    const moved = await thumb.boundingBox(); assert(moved && selectedPositions[index]);
    assert(Math.abs(moved.x - selectedPositions[index].x) < 2, "Selected handles must retain their screen position.");
    assert(moved.x >= axis.x && moved.x + moved.width <= axis.x + axis.width, "Selection must stay visible.");
  }
  await waitCount(await expectedCount());
  await panBody(-.25);
  await waitCount(await expectedCount());
  for (const delta of [100, -100]) {
    await panBody(delta);
    await waitCount(await expectedCount());
    for (const [index, thumb] of [startThumb, endThumb].entries()) {
      const position = await thumb.boundingBox(); assert(position && selectedPositions[index]);
      assert(Math.abs(position.x - selectedPositions[index].x) < 2, "History boundaries must clamp the viewport and selection together.");
      assert(position.x >= axis.x && position.x + position.width <= axis.x + axis.width);
    }
  }
  await page.screenshot({ path: output + "timeline-desktop.png" });
  // Reopening must preserve a historical selection, including its browse month.
  const previousMonth = await page.getByLabel("选择年月").inputValue();
  const historicalDate = new Date(`${previousMonth}-01T00:00:00Z`); historicalDate.setUTCMonth(historicalDate.getUTCMonth() - 1);
  await page.getByLabel("选择年月").selectOption(historicalDate.toISOString().slice(0, 7));
  await startThumb.focus(); await page.keyboard.press("ArrowRight");
  await waitCount(await expectedCount());
  const historicalMonth = await page.getByLabel("选择年月").inputValue();
  await page.keyboard.press("Escape");
  await page.locator(".range-button").click();
  assert.equal(await page.getByLabel("选择年月").inputValue(), historicalMonth);
  await page.getByRole("button", { name: "清除时间范围，显示全部点位", exact: true }).click();
  await waitCount(points.length);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "筛选轨迹", exact: true }).count(), 0);
  assert.equal(await page.locator(".scope-popover").count(), 0);
  const originals = page.getByRole("button", { name: "显示原始轨迹", exact: true });
  assert.equal(await originals.getAttribute("aria-pressed"), "false");
  assert.equal(await originals.locator("..").getByLabel("搜索表格数据").count(), 1, "Raw tracks are directly beside the search field.");
  await originals.click(); await waitCount(rawPoints.length);
  const hidden = rawPoints.findLast(p => !isTrajectoryPoint(p));
  if (hidden) {
    await page.getByLabel("搜索表格数据").fill(String(hidden.id));
    await page.getByRole("button", { name: `查看数据点 ${hidden.id}`, exact: true }).click();
    assert(!/高置信|待复核|证据不足|历史位置/.test(await page.locator(".point-card").innerText()));
    await page.getByLabel("搜索表格数据").fill("");
  }
  await originals.click();
  await waitCount(points.length);
  if (hidden) assert.equal(await page.locator(".point-card").count(), 0, "A hidden selected point must also leave the selection source.");
  assert.equal(await page.getByLabel("质量标记", { exact: true }).count(), 0);
  assert.equal(await page.locator(".quality-badge, .quality-summary, .point-history").count(), 0);

  const checkQuickRanges = async () => {
    const popover = await page.locator(".timeline-popover").boundingBox(); assert(popover);
    assert(popover.height < 130, "Quick ranges must preserve the compact two-row timeline.");
    const controls = await page.locator(".timeline-month, .timeline-preset, .timeline-clear").evaluateAll(elements =>
      elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; }));
    for (const [index, control] of controls.entries()) {
      assert(Math.abs(control.y - controls[0].y) < 1, "All calendar controls must share the first row.");
      assert(control.x >= popover.x && control.x + control.width <= popover.x + popover.width, "Calendar controls must fit inside the popover.");
      if (index) assert(control.x >= controls[index - 1].x + controls[index - 1].width, "Calendar controls must not overlap.");
    }
    for (const [preset, label] of [["today", "今天"], ["week", "本周"], ["month", "本月"]]) {
      const range = quickRange(preset, await page.evaluate(() => Date.now()));
      const button = page.getByRole("button", { name: label, exact: true });
      await button.click();
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      assert.equal(await startThumb.getAttribute("aria-valuetext"), dayDate(range[0]));
      assert.equal(await endThumb.getAttribute("aria-valuetext"), dayDate(range[1]));
      await waitCount(points.filter(p => {
        const day = Math.floor((p.timestamp + 8 * 3_600_000) / 86_400_000);
        return day >= range[0] && day <= range[1];
      }).length);
    }
  };
  await page.locator(".range-button").click();
  await checkQuickRanges();
  await page.screenshot({ path: output + "timeline-presets-desktop.png" });
  await page.getByRole("button", { name: "清除时间范围，显示全部点位", exact: true }).click();
  await waitCount(points.length); await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "地图图层", exact: true }).click();
  assert.equal(await layerMenu.getByRole("switch").count(), 3);
  assert.equal(await layerMenu.locator(".helper").count(), 0);
  await page.keyboard.press("Escape");
  assert.deepEqual(calls, offsets, "Local filters and layers must not reload the position API.");
  assert.equal(await page.getByRole("button", { name: "导出当前表格 CSV", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "展开表格", exact: true }).count(), 0);
  await page.getByRole("button", { name: "收起表格", exact: true }).click();
  assert.equal(await page.locator(".table-scroll").count(), 0);
  await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click();
  const tableDialog = page.getByRole("dialog", { name: "足迹数据", exact: true });
  await tableDialog.waitFor();
  assert.equal(await page.locator(".table-scroll").count(), 1, "Only one virtual table should be mounted.");
  assert(await tableDialog.getByLabel("搜索表格数据").evaluate(element => document.activeElement === element));
  await tableDialog.getByRole("button", { name: "观测时间", exact: true }).click();
  assert.equal(await tableDialog.locator('th[aria-sort="ascending"]').count(), 1);
  await tableDialog.getByLabel("搜索表格数据").fill(String(latest.id));
  await waitCount(latestQueryCount);
  const dialogOriginals = tableDialog.getByRole("button", { name: "显示原始轨迹", exact: true });
  await dialogOriginals.click(); assert.equal(await dialogOriginals.getAttribute("aria-pressed"), "true");
  await dialogOriginals.click(); assert.equal(await dialogOriginals.getAttribute("aria-pressed"), "false");
  assert.equal(await tableDialog.count(), 1, "The inline raw toggle keeps the table dialog open.");
  await tableDialog.getByRole("button", { name: "关闭表格弹窗", exact: true }).click();
  assert.equal(await page.locator(".table-scroll").count(), 0);
  await page.getByRole("button", { name: "打开表格", exact: true }).click();
  assert.equal(await page.getByLabel("搜索表格数据").inputValue(), String(latest.id));
  assert.equal(await page.locator('th[aria-sort="ascending"]').count(), 1, "Sort order survives changing table presentation.");
  await page.getByLabel("搜索表格数据").fill(""); await waitCount(points.length);
  for (let i = 0; i < 3 && await page.locator('th[aria-sort="descending"]').count() === 0; i++)
    await page.getByRole("button", { name: "观测时间", exact: true }).click();
  const compactTable = await page.locator(".data-drawer").boundingBox();
  assert(compactTable && compactTable.height >= 300 && compactTable.height <= 390, "The embedded table should retain its original height.");
  await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click(); await tableDialog.waitFor();
  assert.equal(await page.locator(".table-scroll").count(), 1);
  await page.screenshot({ path: output + "table-dialog-desktop.png" });
  await page.mouse.click(40, 40); await tableDialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".data-drawer .table-scroll").count(), 1, "Closing the dialog restores the compact table.");
  await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click(); await tableDialog.waitFor();
  await page.keyboard.press("Escape"); await tableDialog.waitFor({ state: "hidden" });
  assert(await page.getByRole("button", { name: "弹窗查看表格", exact: true }).evaluate(element => element === document.activeElement));
  await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click(); await tableDialog.waitFor();
  await tableDialog.getByLabel("搜索表格数据").fill(String(latest.id));
  await tableDialog.getByRole("button", { name: `查看数据点 ${latest.id}`, exact: true }).click();
  await tableDialog.waitFor({ state: "hidden" });
  await page.getByRole("complementary", { name: "选中位置详情" }).waitFor();
  await page.getByRole("button", { name: "关闭位置详情", exact: true }).click();
  await page.getByLabel("搜索表格数据").fill(""); await waitCount(points.length);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(150);
    assert.equal(await hasOverflow(), false);
    await page.getByRole("button", { name: "弹窗查看表格", exact: true }).click(); await tableDialog.waitFor();
    const dialogBox = await tableDialog.boundingBox();
    assert(dialogBox && dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= width && dialogBox.y + dialogBox.height <= 844);
    assert.equal(await page.locator(".table-scroll").count(), 1);
    await page.screenshot({ path: output + `table-dialog-${width}.png` });
    await page.keyboard.press("Escape"); await tableDialog.waitFor({ state: "hidden" });
    await page.getByLabel("搜索表格数据").fill(String(latest.id));
    await page.getByRole("button", { name: `查看数据点 ${latest.id}`, exact: true }).click();
    await page.getByLabel("搜索表格数据").fill("");
    await page.getByRole("button", { name: "绘制前后 24 小时轨迹", exact: true }).click();
    await waitCount(aroundLatest.length);
    assert.equal(await hasOverflow(), false, "Precise time labels and the point action must fit on mobile.");
    if (width === 390) await page.screenshot({ path: output + "mobile.png" });
    await page.locator(".range-button").click();
    await page.getByRole("slider", { name: "范围开始日期", exact: true }).waitFor();
    assert.equal(await hasOverflow(), false);
    const popover = await page.locator(".timeline-popover").boundingBox();
    assert(popover && popover.x >= 0 && popover.x + popover.width <= width, "The timeline must fit on mobile.");
    if (width === 390) await page.screenshot({ path: output + "timeline-mobile.png" });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "关闭位置详情", exact: true }).click();
    await waitCount(points.length);
    assert.equal(await page.locator(".range-filtered, .point-card").count(), 0, "Closing the mobile point card must clear its context too.");
    await page.locator(".range-button").click();
    await checkQuickRanges();
    await page.screenshot({ path: output + `timeline-presets-${width}.png` });
    await page.getByRole("button", { name: "清除时间范围，显示全部点位", exact: true }).click();
    await waitCount(points.length); await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  calls.length = 0;
  const reloadComplete = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/locations" && Number(url.searchParams.get("offset")) === offsets.at(-1);
  });
  await page.getByRole("button", { name: "重新加载数据", exact: true }).click();
  await reloadComplete;
  await waitCount(points.length);
  assert.deepEqual(calls, offsets);
  await page.locator(".table-scroll").evaluate(element => element.scrollTop = element.scrollHeight);
  await page.getByRole("button", { name: `查看数据点 ${oldest.id}`, exact: true }).waitFor();
  await page.getByRole("button", { name: `查看数据点 ${oldest.id}`, exact: true }).click();
  assert((await page.locator(".point-card").innerText()).includes(oldest.longitude.toFixed(6)));
  assert.equal(errors.length, 0);
  const result = { points: points.length, rawPoints: rawPoints.length, hiddenPoints: rawPoints.length - points.length, quickRanges: ["today", "week", "month"], renderedRows, loadMs, checkedViewportWidths: [1440, 390, 320],
    source: "local-api", paginationOffsets: offsets, mapboxLoaded: !!config.mapboxToken, errors };
  writeFileSync(output + "browser-result-live.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
