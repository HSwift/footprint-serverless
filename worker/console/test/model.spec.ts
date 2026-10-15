import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, filterPoints, lineGeoJSON, pointGeoJSON, type LocationPoint } from "../src/model";
import { aroundPointRange } from "../src/timeline";

function point(id: number, time: number, device = "phone", longitude = 120): LocationPoint {
  return { id, timestamp: time, longitude, latitude: 30, device, city: "杭州",
    quality: { status: "unassessed", reason: "not_analyzed", version: null, checkedAt: null, evidence: null } };
}
describe("map data and filtering", () => {
  it("includes exact 24-hour boundaries and excludes surrounding calendar-day data", () => {
    const timestamp = Date.parse("2026-01-01T13:45:12.345+08:00");
    const rows = [-86_400_001, -86_400_000, 0, 86_400_000, 86_400_001].map((delta, i) => point(i, timestamp + delta));
    expect(filterPoints(rows, { ...EMPTY_FILTERS, ...aroundPointRange(timestamp) }, []).map(p => p.id)).toEqual([1, 2, 3]);
  });
  it("combines a precise point window with project and cleanup across all devices", () => {
    const rows = [point(1, 1000), point(2, 2000, "watch"), point(3, 3000), point(4, 4000), point(5, 5000)];
    rows[2].quality.status = "outlier"; rows[3].quality.status = "review";
    expect(filterPoints(rows, { ...EMPTY_FILTERS, ...aroundPointRange(3000), project: "1", filtered: true }, [
      { id: 1, name: "trip", startTime: 2000, endTime: 5000 },
    ]).map(p => p.id)).toEqual([2, 5]);
  });
  it("uses Shanghai calendar dates and preserves both date boundaries", () => {
    const rows = [-1, 0, 86_399_999, 86_400_000].map((delta, i) => point(i, Date.parse("2026-10-10T00:00:00+08:00") + delta));
    expect(filterPoints(rows, { ...EMPTY_FILTERS, since: "2026-10-10", until: "2026-10-10" }, []).map(p => p.id)).toEqual([1, 2]);
  });
  it("resolves project by ID so duplicate names do not select the wrong window", () => {
    expect(filterPoints([point(1, 1000), point(2, 2000), point(3, 3000)], { ...EMPTY_FILTERS, project: "2" }, [
      { id: 1, name: "trip", startTime: 1000, endTime: 1000 }, { id: 2, name: "trip", startTime: 2000, endTime: 3000 },
    ]).map(p => p.id)).toEqual([2, 3]);
  });
  it("hides flagged points by default, retains pending and unassessed points, and can show original data", () => {
    const statuses = ["retained", "outlier", "review", "uncertain", "pending", "unassessed"] as const;
    const rows = statuses.map((status, i) => ({ ...point(i + 1, i + 1), quality: { ...point(i, i).quality, status } }));
    expect(filterPoints(rows, EMPTY_FILTERS, []).map(p => p.id)).toEqual([1, 5, 6]);
    expect(filterPoints(rows, { ...EMPTY_FILTERS, filtered: false }, []).map(p => p.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("omits hidden points from both map points and the line", () => {
    const rows = [point(1, 1000, "phone", 120), point(2, 2000, "phone", 150), point(3, 3000, "phone", 121)];
    rows[1].quality.status = "review";
    const visible = filterPoints(rows, EMPTY_FILTERS, []);
    expect(lineGeoJSON(visible).features[0].geometry.coordinates).toEqual([[120, 30], [121, 30]]);
    expect(pointGeoJSON(visible).features.map(feature => feature.id)).toEqual([1, 3]);
  });
  it("keeps stable feature IDs and sends only necessary fields to the map worker", () => {
    const data = pointGeoJSON([point(42, 1)]);
    expect(data.features[0]).toMatchObject({ id: 42, properties: { id: 42 }, geometry: { coordinates: [120, 30] } });
    expect(Object.keys(data.features[0].properties!)).toEqual(["id"]);
  });
  it("reduces display precision while preserving raw coordinates and every point ID", () => {
    const p = point(42, 1, "phone", 120.123456789); p.latitude = 30.987654321;
    expect(pointGeoJSON([p]).features[0]).toMatchObject({ id: 42, geometry: { coordinates: [120.123457, 30.987654] } });
    expect(p.longitude).toBe(120.123456789); expect(p.latitude).toBe(30.987654321);
  });
  it("connects all selected points in stable time order across devices and long gaps", () => {
    const rows = [point(5, 4_001_000, "phone", 123), point(2, 1000, "watch", 121),
      point(4, 4_000_000, "phone", 122), point(1, 1000), point(3, 2000, "watch", 999)];
    expect(lineGeoJSON(rows).features[0].geometry).toEqual({ type: "LineString", coordinates: [
      [120, 30], [121, 30], [122, 30], [123, 30],
    ] });
    expect(rows[0].id).toBe(5);
    expect(pointGeoJSON(rows).features).toHaveLength(4);
  });
  it("keeps every point while omitting stationary line vertices and lines without distinct positions", () => {
    const rows = [point(1, 1000), point(2, 2000), point(3, 3000, "phone", 121)];
    expect(lineGeoJSON(rows).features[0].geometry.coordinates).toEqual([[120, 30], [121, 30]]);
    expect(pointGeoJSON(rows).features).toHaveLength(rows.length);
    expect(lineGeoJSON([point(1, 1000), point(2, 2000)]).features).toEqual([]);
  });
});
