import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../migrations/0001_init.sql?raw";
import qualitySchema from "../migrations/0002_location_quality.sql?raw";
import historySchema from "../migrations/0003_location_history_index.sql?raw";
import timezoneSchema from "../migrations/0004_location_timezone.sql?raw";
import worker from "../src/index";
import type { ApiEnv } from "../src/types";

const AUTH = { Authorization: "Bearer test-token" };
const SELF = exports.default;
const PAYLOAD = { longitude: 121.4737, latitude: 31.2304, timestamp: 1_791_504_000_000, device: "phone", city: "Shanghai" };

beforeAll(async () => {
  const sql = `${schema}\n${qualitySchema}\n${historySchema}\n${timezoneSchema}`.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  for (const statement of sql.split(";")) {
    const query = statement.replace(/\s+/g, " ").trim();
    if (query) await env.DB.exec(query);
  }
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM Locations; DELETE FROM Projects; DELETE FROM LocationAnalysisState;");
});

function get(path: string) {
  return SELF.fetch(`https://example.com${path}`, { headers: AUTH });
}

function report(payload: unknown = PAYLOAD) {
  return SELF.fetch("https://example.com/api/location", {
    method: "PUT", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

async function seed(longitude: number, date: number, device = "phone") {
  const result = await env.DB.prepare("INSERT INTO Locations (Longitude, Latitude, City, Device, Date) VALUES (?, 31, 'Shanghai', ?, ?) RETURNING ID")
    .bind(longitude, device, date).first<{ ID: number }>();
  return result!.ID;
}

async function project(name = "trip", start = 1000, end = 3000) {
  await env.DB.prepare("INSERT INTO Projects (Name, StartTime, EndTime) VALUES (?, ?, ?)").bind(name, start, end).run();
}

describe("authentication and routing", () => {
  it("provides a data-free health check and token verification endpoint", async () => {
    const health = await SELF.fetch("https://example.com/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", name: "footprint-serverless-api" });
    expect(await (await get("/api/me")).json()).toEqual({ authenticated: true, method: "bearer" });
  });

  it.each(["/api/location", "/api/locations", "/api/projects", "/api/projects/trip", "/api/me", "/location", "/locations", "/data"])("protects %s", async path => {
    const response = await SELF.fetch(`https://example.com${path}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each<Record<string, string>>([
    {}, { Authorization: "Bearer wrong" }, { Authorization: "Basic test-token" },
    { "Cf-Access-Jwt-Assertion": "access.jwt" }, { Token: "test-token" },
    { Authorization: "Bearer test-token extra" },
  ])("requires an API token rather than an Access header: %j", async headers => {
    const response = await SELF.fetch("https://example.com/api/locations", { headers });
    expect(response.status).toBe(401);
  });

  it("fails closed when the runtime secret is absent", async () => {
    const response = await worker.fetch(new Request("https://example.com/api/locations", { headers: AUTH }), { DB: env.DB });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "auth_not_configured" } });
  });

  it("returns structured 404 and 405 errors", async () => {
    expect((await get("/api/unknown")).status).toBe(404);
    const response = await SELF.fetch("https://example.com/api/location", { method: "POST", headers: AUTH });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT");
  });

  it("catches asynchronous database failures without disclosing internal errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingEnv: ApiEnv = { INGEST_TOKEN: "test-token", DB: {
      prepare: () => ({ bind: () => ({ first: async () => { throw new Error("database details test-token"); } }) }),
    } as unknown as D1Database };
    try {
      const response = await worker.fetch(new Request("https://example.com/api/location", { headers: AUTH }), failingEnv);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal_error", message: "The request could not be completed" } });
    } finally { log.mockRestore(); }
  });
});

describe("location reporting", () => {
  it.each([8, 0, -5, 5.5, 5.75, -3.5, -12, 14, 80 / 60])("persists client UTC hour offset %s without changing the observation instant", async timezone => {
    const response = await report({ ...PAYLOAD, timezone });
    expect(response.status).toBe(201);
    const result = await response.json<{ location: { id: number; timezone: number; timestamp: number } }>();
    expect(result.location).toMatchObject({ timezone, timestamp: PAYLOAD.timestamp });
    expect(await env.DB.prepare("SELECT Timezone FROM Locations WHERE ID = ?").bind(result.location.id).first("Timezone")).toBe(timezone);
    expect(await (await get("/api/location")).json()).toMatchObject({ location: { timezone } });
    expect(await (await get("/api/locations")).json()).toMatchObject({ locations: [{ timezone }] });
  });

  it("keeps old clients compatible with a null timezone", async () => {
    expect(await (await report()).json()).toMatchObject({ location: { timezone: null } });
    expect(await (await report({ ...PAYLOAD, timezone: null })).json()).toMatchObject({ location: { timezone: null } });
  });

  it.each([15, -13, 8.001, "UTC+8", "", true, {}, []].map(timezone => ({ timezone })))("rejects invalid timezone %j before storing a record", async ({ timezone }) => {
    const response = await report({ ...PAYLOAD, timezone });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { field: "timezone" } });
    expect(await env.DB.prepare("SELECT COUNT(*) FROM Locations").first("COUNT(*)")).toBe(0);
  });

  it("accepts a numeric timezone through the legacy form API", async () => {
    const response = await SELF.fetch("https://example.com/location", { method: "PUT", headers: { Token: "test-token" },
      body: new URLSearchParams({ lat: "31", lng: "121", datetime: "2026-10-09T12:00:00+08:00", device: "phone", timezone: "5.75" }) });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT Timezone FROM Locations").first("Timezone")).toBe(5.75);
  });

  it("persists WGS84 coordinates and millisecond timestamps without conversion", async () => {
    const response = await report();
    expect(response.status).toBe(201);
    const result = await response.json<{ location: { id: number } }>();
    expect(result.location).toMatchObject(PAYLOAD);
    const row = await env.DB.prepare("SELECT * FROM Locations WHERE ID = ?").bind(result.location.id).first();
    expect(row).toMatchObject({ Longitude: PAYLOAD.longitude, Latitude: PAYLOAD.latitude, Date: PAYLOAD.timestamp, Device: "phone" });
  });

  it("normalizes timezone-aware datetimes and allows coordinates at zero", async () => {
    const response = await report({ longitude: 0, latitude: 0, datetime: "2026-10-09T12:00:00+08:00", device: "phone" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ location: { longitude: 0, latitude: 0, city: "", timestamp: Date.parse("2026-10-09T04:00:00Z") } });
  });

  it("accepts form payloads through the canonical API", async () => {
    const response = await SELF.fetch("https://example.com/api/location", {
      method: "PUT", headers: AUTH,
      body: new URLSearchParams({ lat: "31.23", lng: "121.47", datetime: "2026-10-09T04:00:00Z", device: "phone" }),
    });
    expect(response.status).toBe(201);
  });

  it.each([
    { longitude: 181 }, { latitude: -91 }, { longitude: "121junk" }, { latitude: "" },
    { longitude: null }, { timestamp: "not-a-date" }, { timestamp: "2026-02-30T00:00:00Z" },
    { timestamp: "2026-10-09T24:00:00Z" }, { timestamp: "2026-10-09T00:00:00" },
    { timestamp: -1 }, { timestamp: 8_640_000_000_000_001 }, { device: " " },
    { device: "x".repeat(201) }, { city: 123 },
  ])("rejects invalid fields before storing data: %j", async changes => {
    const response = await report({ ...PAYLOAD, ...changes });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM Locations").first("count")).toBe(0);
  });

  it("rejects malformed JSON, non-object bodies and unsupported content types", async () => {
    for (const body of ["{bad-json", "[]", "null"]) {
      expect((await SELF.fetch("https://example.com/api/location", {
        method: "PUT", headers: { ...AUTH, "content-type": "application/json" }, body,
      })).status).toBe(400);
    }
    expect((await SELF.fetch("https://example.com/api/location", { method: "PUT", headers: AUTH, body: "text" })).status).toBe(415);
  });

  it("rejects uploaded files in place of a coordinate", async () => {
    const form = new FormData();
    form.set("longitude", new File(["121.4"], "coordinate.txt"));
    form.set("latitude", "31"); form.set("device", "phone"); form.set("timestamp", "1000");
    expect((await SELF.fetch("https://example.com/api/location", { method: "PUT", headers: AUTH, body: form })).status).toBe(400);
  });
});

describe("location queries", () => {
  it("returns null or an empty list when there are no locations", async () => {
    expect(await (await get("/api/location")).json()).toEqual({ location: null });
    expect(await (await get("/api/locations")).json()).toEqual({ locations: [], pagination: { limit: 500, offset: 0, hasMore: false } });
  });

  it("selects latest by observation time, with ID breaking ties", async () => {
    await seed(10, 3000);
    await seed(20, 1000);
    const id = await seed(30, 3000);
    expect(await (await get("/api/location")).json()).toMatchObject({ location: { id, longitude: 30, timestamp: 3000 } });
  });

  it("sorts trajectories chronologically and reports pagination accurately", async () => {
    await seed(30, 3000); await seed(10, 1000); await seed(20, 2000);
    const first = await (await get("/api/locations?limit=2")).json<{ locations: { longitude: number }[]; pagination: { hasMore: boolean } }>();
    expect(first.locations.map(row => row.longitude)).toEqual([10, 20]);
    expect(first.pagination.hasMore).toBe(true);
    const last = await (await get("/api/locations?limit=2&offset=2")).json();
    expect(last).toMatchObject({ locations: [{ longitude: 30 }], pagination: { hasMore: false } });
    const descending = await (await get("/api/locations?order=desc&limit=1")).json();
    expect(descending).toMatchObject({ locations: [{ longitude: 30 }] });
  });

  it("intersects inclusive date, device and project filters", async () => {
    await project(); await seed(10, 1000); await seed(20, 2000, "watch"); await seed(30, 3000); await seed(40, 4000);
    const result = await (await get("/api/locations?project=trip&device=phone&since=1000&until=3000")).json<{ locations: { longitude: number }[] }>();
    expect(result.locations.map(row => row.longitude)).toEqual([10, 30]);
    expect(await (await get("/api/location?device=watch")).json()).toMatchObject({ location: { longitude: 20 } });
    expect((await get("/api/locations?project=missing")).status).toBe(404);
  });

  it("binds device and project names as data", async () => {
    const name = "trip' OR 1=1 --";
    await project(name); await seed(10, 2000); await seed(20, 4000);
    const result = await (await get(`/api/locations?project=${encodeURIComponent(name)}`)).json();
    expect(result).toMatchObject({ locations: [{ longitude: 10 }] });
    expect(await (await get(`/api/location?device=${encodeURIComponent("' OR 1=1 --")}`)).json()).toEqual({ location: null });
  });

  it.each(["limit=0", "limit=5001", "limit=1.5", "offset=-1", "order=random", "since=bad", "since=3000&until=1000", "device="])("rejects invalid query parameters: %s", async query => {
    expect((await get(`/api/locations?${query}`)).status).toBe(400);
  });
});

describe("projects", () => {
  const write = (path: string, method: string, body: unknown, auth: Record<string, string> = AUTH) => SELF.fetch(`https://example.com${path}`, {
    method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const input = { name: "上海 行程", startTime: 1000, endTime: 3000 };
  it("lists and looks up the existing time-window projects", async () => {
    await project("上海 行程", 1000, 3000); await project("second", 4000, 6000);
    expect(await (await get("/api/projects?limit=1")).json()).toMatchObject({ projects: [{ name: "second", startTime: 4000, endTime: 6000 }], pagination: { hasMore: true } });
    expect(await (await get(`/api/projects/${encodeURIComponent("上海 行程")}`)).json()).toMatchObject({ project: { name: "上海 行程", startTime: 1000, endTime: 3000 } });
    expect((await get("/api/projects/missing")).status).toBe(404);
    expect((await get("/api/projects/%GG")).status).toBe(400);
  });

  it("creates a persisted project without changing its location records", async () => {
    const locationId = await seed(120, 2000);
    const response = await write("/api/projects", "POST", { ...input, name: `  ${input.name}  ` });
    expect(response.status).toBe(201);
    const result = await response.json<{ project: { id: number; name: string; startTime: number; endTime: number } }>();
    expect(result.project).toMatchObject(input);
    expect(await env.DB.prepare("SELECT * FROM Projects WHERE ID = ?").bind(result.project.id).first()).toMatchObject({
      Name: input.name, StartTime: 1000, EndTime: 3000,
    });
    expect(await (await get("/api/locations?project=" + encodeURIComponent(input.name))).json()).toMatchObject({ locations: [{ id: locationId }] });
    expect(await env.DB.prepare("SELECT COUNT(*) FROM Locations").first("COUNT(*)")).toBe(1);
  });

  it("updates by ID so duplicate names cannot edit a different project", async () => {
    await project("duplicate", 1000, 2000); await project("duplicate", 3000, 4000);
    const id = await env.DB.prepare("SELECT ID FROM Projects ORDER BY ID DESC LIMIT 1").first<number>("ID");
    const response = await write(`/api/projects/${id}`, "PATCH", { name: "更新", startTime: 5000, endTime: 9000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: { id, name: "更新", startTime: 5000, endTime: 9000 } });
    expect(await (await get("/api/projects/duplicate")).json()).toMatchObject({ project: { startTime: 1000, endTime: 2000 } });
  });

  it("accepts partial changes and preserves unedited millisecond timestamps", async () => {
    await project("trip", 1001, 3003);
    const id = await env.DB.prepare("SELECT ID FROM Projects").first<number>("ID");
    expect(await (await write(`/api/projects/${id}`, "PATCH", { name: "renamed" })).json()).toEqual({ project: { id, name: "renamed", startTime: 1001, endTime: 3003 } });
    expect((await write(`/api/projects/${id}`, "PATCH", { endTime: 500 })).status).toBe(400);
    expect(await (await get("/api/projects/renamed")).json()).toMatchObject({ project: { endTime: 3003 } });
  });

  it("keeps GET numeric names as names while PATCH targets a numeric ID", async () => {
    await project("123", 1000, 2000);
    expect(await (await get("/api/projects/123")).json()).toMatchObject({ project: { name: "123" } });
    expect((await write("/api/projects/900000", "PATCH", { name: "new" })).status).toBe(404);
    expect((await write("/api/projects/trip", "PATCH", input)).status).toBe(400);
  });

  it("normalizes timezone-aware times and permits overlapping, multi-month projects", async () => {
    const payload = { name: "trip", startTime: "2026-01-01T00:00:00+08:00", endTime: "2026-04-01T23:59:59+08:00" };
    for (let i = 0; i < 2; i++) {
      const response = await write("/api/projects", "POST", payload);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ project: { name: "trip", startTime: Date.parse(payload.startTime), endTime: Date.parse(payload.endTime) } });
    }
  });

  it.each([
    { name: " " }, { name: null }, { name: "x".repeat(201) }, { startTime: undefined }, { startTime: -1 },
    { startTime: "2026-02-30T00:00:00Z" }, { startTime: "2026-10-01T12:00:00" }, { endTime: 999 }, { endTime: null },
  ])("rejects invalid project data before storing it: %j", async changes => {
    expect((await write("/api/projects", "POST", { ...input, ...changes })).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM Projects").first("COUNT(*)")).toBe(0);
  });

  it.each(["0", "-1", "1.5", "9007199254740992", "%31"])("rejects invalid edit IDs: %s", async id => {
    expect((await write(`/api/projects/${id}`, "PATCH", input)).status).toBe(400);
  });

  it("rejects empty patches, deletion and unauthenticated writes", async () => {
    await project();
    const id = await env.DB.prepare("SELECT ID FROM Projects").first<number>("ID");
    expect((await write(`/api/projects/${id}`, "PATCH", {})).status).toBe(400);
    expect((await write("/api/projects", "POST", input, {})).status).toBe(401);
    expect((await write(`/api/projects/${id}`, "PATCH", input, {})).status).toBe(401);
    expect((await write(`/api/projects/${id}`, "DELETE", {})).status).toBe(405);
  });
});

describe("legacy compatibility", () => {
  it("preserves the old form upload and response envelope", async () => {
    const response = await SELF.fetch("https://example.com/location", {
      method: "PUT", headers: { Token: "test-token" },
      body: new URLSearchParams({ lat: "31.23", lng: "121.47", datetime: "2026-10-09 12:00:00", device: "phone" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await (await get("/location")).json()).toMatchObject({ success: true, name: "location-report-service", data: { Longitude: 121.47, Latitude: 31.23, Device: "phone" } });
    expect(await (await get("/locations")).json()).toMatchObject({ success: true, data: { results: [{ Longitude: 121.47 }] } });
  });

  it("does not let a legacy Token override an invalid Bearer", async () => {
    expect((await SELF.fetch("https://example.com/location", { headers: { Authorization: "Bearer wrong", Token: "test-token" } })).status).toBe(401);
  });

  it("serves chronological map data for current, all and project selections", async () => {
    await project(); await seed(30, 3000); await seed(10, 1000); await seed(40, 4000);
    for (const [name, expected] of [["current", [40]], ["all", [10, 30, 40]], ["trip", [10, 30]]] as const) {
      const response = await SELF.fetch("https://example.com/data", { method: "POST", headers: AUTH, body: new URLSearchParams({ project: name }) });
      const result = await response.json<{ Longitude: number; Device?: string }[]>();
      expect(result.map(row => row.Longitude)).toEqual(expected);
      expect(result.every(row => !("Device" in row))).toBe(true);
    }
  });

  it("requires a token even for previously public project map queries", async () => {
    await project(); await seed(10, 1000);
    expect((await SELF.fetch("https://example.com/data", { method: "POST", body: new URLSearchParams({ project: "trip" }) })).status).toBe(401);
  });
});
