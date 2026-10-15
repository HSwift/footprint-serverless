import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { formatDate, formatTime, isTrajectoryPoint } from "../src/model.ts";

const origin = process.env.FOOTPRINT_PREVIEW_URL || "http://127.0.0.1:5173";
const raw = [];
while (true) {
  const response = await fetch(`${origin}/api/locations?view=raw&order=asc&limit=5000&offset=${raw.length}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200); const page = await response.json();
  raw.push(...page.locations); if (!page.pagination.hasMore) break; assert(page.locations.length);
}
const points = raw.filter(isTrajectoryPoint);
// Select from the operator's own data without embedding travel destinations,
// record IDs or geographic bounds in the test suite.
const recorded = points.filter(point => typeof point.timezone === "number" && Number.isFinite(point.timezone));
assert(recorded.length, "Load observations with stored timezone offsets before running this check.");
const uniqueOffsets = [...new Set(recorded.map(point => point.timezone))];
const samples = Array.from({ length: 3 }, (_, index) => {
  const timezone = uniqueOffsets[index % uniqueOffsets.length];
  return { name: `sample-${index + 1}`, point: recorded.findLast(point => point.timezone === timezone) };
});
function expectedTime(point) {
  const minutes = Math.round(point.timezone * 60), absolute = Math.abs(minutes);
  const zone = `${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(point.timestamp).map(part => [part.type, part.value]));
  return { date: `${parts.year}.${parts.month}.${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}`,
    offset: parts.timeZoneName === "GMT" ? "UTC+00:00" : parts.timeZoneName.replace(/^GMT/, "UTC") };
}
const output = fileURLToPath(new URL("../../../.local/console-preview/", import.meta.url));
mkdirSync(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ executablePath: process.env.FOOTPRINT_BROWSER_PATH || "/opt/google/chrome/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York" });
  const errors = [], apiRequests = [], timezoneAssets = [];
  page.on("pageerror", error => errors.push(error.message.replace(/pk\.[\w.-]+/g, "[public-token]")));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) apiRequests.push(path);
    if (path.includes("tz-lookup") || path.includes("geo-tz")) timezoneAssets.push(path);
  });
  await page.goto(origin);
  await page.waitForFunction(total => Number(document.querySelector(".drawer-count")?.textContent.replace(/[^\d]/g, "")) === total, points.length);
  await page.locator(".mapboxgl-canvas").waitFor({ timeout: 45_000 });
  assert.equal(timezoneAssets.length, 0, "Timezone lookup data must stay out of the frontend.");
  const initialApiRequests = apiRequests.length;
  await page.getByRole("button", { name: "打开表格", exact: true }).click();
  const card = page.getByRole("complementary", { name: "选中位置详情" });
  const verify = async sample => {
    await page.getByLabel("搜索表格数据").fill(String(sample.point.id));
    await page.getByRole("button", { name: `查看数据点 ${sample.point.id}`, exact: true }).click();
    assert.equal(typeof sample.point.timezone, "number", "Backfill local historical offsets before this check.");
    await card.locator(`time[data-timezone="${sample.point.timezone}"]`).waitFor();
    const expected = expectedTime(sample.point);
    assert.equal((await card.locator(".point-observed").innerText()).replace(/\s+/g, ""), expected.date + expected.time);
    assert((await card.locator(".point-time-zone").innerText()).includes(expected.offset));
    assert((await card.locator(".point-time-zone").innerText()).includes("当地时间"));
    assert.equal(await card.locator("time").getAttribute("datetime"), new Date(sample.point.timestamp).toISOString());
    const row = page.getByRole("button", { name: `查看数据点 ${sample.point.id}`, exact: true }).locator("../..");
    assert((await row.innerText()).includes(formatDate(sample.point.timestamp)));
    assert((await row.innerText()).includes(formatTime(sample.point.timestamp)), "The table keeps Beijing time.");
    return { name: sample.name, timezone: sample.point.timezone, ...expected };
  };
  const checked = [];
  for (const sample of samples) checked.push(await verify(sample));
  assert.equal(timezoneAssets.length, 0, "Selecting points must not load timezone lookup data.");
  await verify(samples[1]);
  await page.screenshot({ path: output + "point-local-time-desktop.png" });
  // Rapid selection must immediately display the last point's stored offset.
  for (const sample of [samples[2], samples[0], samples[1]]) {
    await page.getByLabel("搜索表格数据").fill(String(sample.point.id));
    await page.getByRole("button", { name: `查看数据点 ${sample.point.id}`, exact: true }).click();
  }
  await card.locator(`time[data-timezone="${samples[1].point.timezone}"]`).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await verify(samples[1]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const zoneBox = await card.locator(".point-time-zone").boundingBox(), cardBox = await card.boundingBox();
    assert(zoneBox && cardBox && zoneBox.x >= cardBox.x && zoneBox.x + zoneBox.width <= cardBox.x + cardBox.width);
    await page.screenshot({ path: output + `point-local-time-${width}.png` });
  }
  assert.equal(apiRequests.length, initialApiRequests, "Local-time cards do not add API or D1 requests.");
  assert.deepEqual(errors, []);
  const result = { source: "local-api", browserTimezone: "America/New_York", checked, timezoneAssetLoads: timezoneAssets.length,
    apiReloads: 0, mobileWidths: [390, 320], errors };
  writeFileSync(output + "local-time-check.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
