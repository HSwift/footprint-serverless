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
interface Location {
  id: number;
  timestamp: number;
  longitude: number;
  quality: { status: string; reason: string; version: string; evidence: unknown };
}
interface IngestResult {
  location: Location;
  analysis: { state: string; windowPoints: number; updatedPoints: number };
}

beforeAll(async () => {
  const sql = `${schema}\n${qualitySchema}\n${historySchema}\n${timezoneSchema}`.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  for (const statement of sql.split(";")) {
    const query = statement.replace(/\s+/g, " ").trim();
    if (query) await env.DB.exec(query);
  }
});
beforeEach(async () => {
  await env.DB.exec("DELETE FROM Locations; DELETE FROM LocationAnalysisState;");
});

function payload(longitude: number, seconds: number, device = "phone", latitude = 30) {
  return { longitude, latitude, timestamp: seconds * 1000, device };
}
function request(data: ReturnType<typeof payload>) {
  return new Request<unknown, IncomingRequestCfProperties>("https://example.com/api/location", { method: "PUT",
    headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(data) });
}
async function report(longitude: number, seconds: number, device = "phone", latitude = 30) {
  const response = await SELF.fetch(request(payload(longitude, seconds, device, latitude)));
  expect(response.status).toBe(201);
  return response.json<IngestResult>();
}
async function list(query = "") {
  const response = await SELF.fetch(`https://example.com/api/locations${query}`, { headers: AUTH });
  expect(response.status).toBe(200);
  return response.json<{ locations: Location[]; pagination: { hasMore: boolean } }>();
}

async function historicalVisit(status = "retained", count = 1, longitude = 121, latitude = 30) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const row = await env.DB.prepare("INSERT INTO Locations (Longitude, Latitude, City, Device, Date) VALUES (?, ?, '', 'phone', ?) RETURNING ID")
      .bind(longitude, latitude, i * 30_000).first<{ ID: number }>();
    ids.push(row!.ID);
    await env.DB.prepare(`INSERT INTO LocationQuality (LocationID, Status, Reason, AlgorithmVersion, Revision, CheckedAt, Evidence)
      VALUES (?, ?, 'test-history', 'excursion-v3-experimental', 1, 0, '{}')`).bind(row!.ID, status).run();
  }
  // Put the older visit outside the 129-point trajectory window.
  const filler = Array.from({ length: 70 }, (_, i) => ({ date: 86_400_000 + i * 60_000 }));
  await env.DB.prepare(`INSERT INTO Locations (Longitude, Latitude, City, Device, Date)
    SELECT 120, 30, '', 'phone', json_extract(value, '$.date') FROM json_each(?)`).bind(JSON.stringify(filler)).run();
  return ids;
}

async function historicalReturn(longitude = 121, latitude = 30) {
  await report(120, 172800); await report(120, 172830);
  const spike = await report(longitude, 172860, "phone", latitude);
  await report(120, 172890); await report(120, 172920);
  return (await list()).locations.find(p => p.id === spike.location.id)!;
}

describe("inline trajectory quality", () => {
  it("finds an earlier retained visit outside the bounded trajectory window", async () => {
    const [oldId] = await historicalVisit();
    const spike = await historicalReturn();
    expect(spike.quality).toMatchObject({ status: "outlier", evidence: { historicalMatches: [
      { pointId: spike.id, previousId: oldId, distanceMeters: 0, ageSeconds: 172860, searchComplete: true },
    ], historicalSearch: { complete: true, returnedCandidates: 1 } } });
    expect(await env.DB.prepare("SELECT Status FROM LocationQuality WHERE LocationID = ?").bind(oldId).first("Status")).toBe("retained");
  });
  it("does not use an old candidate as reliable visit evidence", async () => {
    await historicalVisit("outlier");
    expect((await historicalReturn()).quality).toMatchObject({ status: "outlier", evidence: { historicalMatches: [] } });
  });
  it("caps dense history lookups and identifies incomplete searches", async () => {
    await historicalVisit("retained", 80);
    expect((await historicalReturn()).quality).toMatchObject({ status: "outlier", evidence: {
      historicalMatches: [{ searchComplete: false }], historicalSearch: { complete: false, returnedCandidates: 64, candidateLimit: 64 },
    } });
  });
  it("caps raw historical candidates before rejecting unreliable annotations", async () => {
    await historicalVisit("outlier", 80);
    expect((await historicalReturn()).quality).toMatchObject({ status: "outlier", evidence: {
      historicalMatches: [], historicalSearch: { complete: false, returnedCandidates: 64 },
    } });
  });
  it("limits total history queries when the update window contains many anomalous points", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ index: i, latitude: i % 12 >= 2 && i % 12 < 10 ? 26 : 30 }))
      .filter(row => row.index !== 30);
    await env.DB.prepare(`INSERT INTO Locations (Longitude, Latitude, City, Device, Date)
      SELECT 120, json_extract(value, '$.latitude'), '', 'phone', json_extract(value, '$.index') * 60000 FROM json_each(?)`)
      .bind(JSON.stringify(rows)).run();
    const batchSizes: number[] = [];
    const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length); return env.DB.batch(statements);
    } } as unknown as D1Database;
    const response = await worker.fetch(request(payload(120, 30 * 60)), { DB: db, INGEST_TOKEN: "test-token" });
    expect(response.status).toBe(201);
    expect((await response.json<IngestResult>()).analysis.state).toBe("updated");
    expect(batchSizes[2]).toBe(2);
    const raw = (await list()).locations;
    expect(raw.filter(p => p.quality.status === "outlier").length).toBeGreaterThan(16);
    expect(raw.some(p => (p.quality.evidence as { historicalSearch?: { reason?: string } } | null)?.historicalSearch?.reason === "candidate_limit")).toBe(true);
  });
  it("queries historical matches through the spatial index without a sorting table", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT l.*, q.Status AS ReferenceStatus FROM (SELECT l.* FROM Locations l
      INDEXED BY idx_locations_device_latitude_longitude_date
      WHERE l.Device = 'phone' AND l.Latitude BETWEEN 29.999 AND 30.001 AND l.Longitude BETWEEN 120.999 AND 121.001
      AND l.Date <= 86400000 ORDER BY l.Latitude, l.Longitude, l.Date, l.ID LIMIT 65
      ) l LEFT JOIN LocationQuality q ON q.LocationID = l.ID`).all<{ detail: string }>();
    expect(plan.results.some(p => p.detail.includes("idx_locations_device_latitude_longitude_date") && p.detail.includes("Latitude>"))).toBe(true);
    expect(plan.results.some(p => p.detail.includes("TEMP B-TREE"))).toBe(false);
  });
  it("preserves primary classification when optional history lookup fails", async () => {
    await report(120, 172800); await report(120, 172830); const spike = await report(121, 172860);
    // Fail the third batch: ingest, snapshot, then supplementary history.
    let batches = 0;
    const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
      if (++batches === 3) throw new Error("history unavailable");
      return env.DB.batch(statements);
    } } as unknown as D1Database;
    const response = await worker.fetch(request(payload(120, 172890)), { DB: db, INGEST_TOKEN: "test-token" });
    expect(response.status).toBe(201);
    expect((await response.json<IngestResult>()).analysis.state).toBe("updated");
    expect((await list()).locations.find(p => p.id === spike.location.id)?.quality).toMatchObject({ status: "review", evidence: {
      historicalMatches: [], historicalSearch: { complete: false, reason: "unavailable" },
    } });
    await report(120, 172920);
    expect((await list()).locations.find(p => p.id === spike.location.id)?.quality).toMatchObject({ status: "outlier", evidence: {
      historicalSearch: { complete: true },
    } });
  });
  it("saves a new observation and waits for future context", async () => {
    const result = await report(120, 0);
    expect(result.location.quality).toMatchObject({ status: "pending", reason: "awaiting_context", version: "excursion-v3-experimental" });
    expect(result.analysis).toEqual({ state: "updated", windowPoints: 1, updatedPoints: 0 });
    expect(await env.DB.prepare("SELECT Longitude, Date FROM Locations WHERE ID = ?").bind(result.location.id).first())
      .toEqual({ Longitude: 120, Date: 0 });
  });

  it("revises an earlier spike as later observations arrive, and filters only high-confidence candidates", async () => {
    await report(120, 0); await report(120, 30);
    const spike = await report(121, 60);
    expect(spike.location.quality).toMatchObject({ status: "uncertain", reason: "unresolved_jump" });
    await report(120, 90);
    expect((await list()).locations.find(p => p.id === spike.location.id)?.quality.status).toBe("review");
    expect((await list("?view=filtered")).locations).toHaveLength(4);
    await report(120, 120);
    const raw = await list();
    expect(raw.locations).toHaveLength(5);
    expect(raw.locations.find(p => p.id === spike.location.id)).toMatchObject({ longitude: 121, quality: { status: "outlier", reason: "return_spike" } });
    expect((await list("?view=filtered&limit=3")).pagination.hasMore).toBe(true);
    expect((await list("?view=filtered")).locations.map(p => p.id)).not.toContain(spike.location.id);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM Locations").first("count")).toBe(5);
  });

  it("retains a plausible good point surrounded by a repeated distant cluster", async () => {
    const ids: number[] = [];
    for (const [longitude, seconds, latitude] of [[120, 0, 30], [120, 30, 30], [120, 60, 26],
      [120, 90, 26], [120.02, 210, 30], [120, 240, 26], [120, 270, 30], [120, 300, 30]]) {
      ids.push((await report(longitude, seconds, "phone", latitude)).location.id);
    }
    const raw = await list();
    expect(raw.locations.filter(p => p.quality.status === "outlier").map(p => p.id)).toEqual([ids[2], ids[3], ids[5]]);
    expect((await list("?view=filtered")).locations.map(p => p.id)).toContain(ids[4]);
  });

  it("keeps continuous flight-speed motion and normal slow out-and-back motion", async () => {
    for (let i = 0; i < 10; i++) await report(100 + i * 0.1, i * 40, "flight");
    for (const [longitude, seconds] of [[120, 0], [120, 300], [120.02, 600], [120, 900], [120, 1200]]) {
      await report(longitude, seconds, "car");
    }
    expect((await list("?view=filtered&device=flight")).locations).toHaveLength(10);
    expect((await list("?view=filtered&device=car")).locations).toHaveLength(5);
    expect((await list()).locations.some(p => p.quality.status === "outlier")).toBe(false);
  });

  it("rechecks historical neighborhoods for backfills without changing the latest observation", async () => {
    await report(120, 0); await report(120, 30); await report(120, 90);
    const latest = await report(120, 120);
    const backfill = await report(121, 60);
    expect(backfill.location.quality.status).toBe("outlier");
    const response = await SELF.fetch("https://example.com/api/location?view=filtered", { headers: AUTH });
    expect(await response.json()).toMatchObject({ location: { id: latest.location.id } });
    expect((await list("?view=filtered")).locations).toHaveLength(4);
  });

  it("propagates a spike annotation to exact duplicates", async () => {
    await report(120, 0); await report(120, 30);
    const a = await report(121, 60), b = await report(121, 60);
    await report(120, 90); await report(120, 120);
    expect((await list()).locations.filter(p => p.quality.status === "outlier").map(p => p.id)).toEqual([a.location.id, b.location.id]);
    expect((await list("?view=filtered")).locations).toHaveLength(4);
  });

  it("keeps conflicting timestamp observations as uncertain instead of choosing a location", async () => {
    await report(120, 0); await report(120, 30);
    const a = await report(121, 60), b = await report(120, 60);
    await report(120, 90); await report(120, 120);
    const raw = await list();
    for (const id of [a.location.id, b.location.id]) expect(raw.locations.find(p => p.id === id)?.quality)
      .toMatchObject({ status: "uncertain", reason: "conflicting_timestamp" });
    expect((await list("?view=filtered")).locations).toHaveLength(6);
  });

  it("attributes an extreme long-gap return and keeps other-device observations", async () => {
    await report(120, 0); await report(120, 30);
    const spike = await report(100, 4000); await report(120, 4030); await report(120, 4060);
    await report(100, 60, "watch");
    const raw = await list();
    expect(raw.locations.find(p => p.id === spike.location.id)?.quality).toMatchObject({ status: "outlier", reason: "long_return_spike" });
    expect((await list("?view=filtered")).locations).toHaveLength(5);
    expect((await list("?device=watch")).locations[0].quality.status).toBe("pending");
  });

  it("upgrades a long return as stable later context arrives without flagging the return point", async () => {
    await report(120, 0); await report(120.002, 8400);
    const spike = await report(100, 14400);
    const returned = await report(120.003, 14700);
    expect((await list()).locations.find(p => p.id === spike.location.id)?.quality)
      .toMatchObject({ status: "review", reason: "long_return_spike" });
    await report(120.0031, 14760);
    const raw = await list();
    expect(raw.locations.find(p => p.id === spike.location.id)?.quality)
      .toMatchObject({ status: "outlier", reason: "long_return_spike", version: "excursion-v3-experimental" });
    expect(raw.locations.find(p => p.id === returned.location.id)?.quality.status).not.toBe("uncertain");
    const filtered = (await list("?view=filtered")).locations;
    expect(filtered.map(p => p.id)).not.toContain(spike.location.id);
    expect(filtered.map(p => p.id)).toContain(returned.location.id);
    expect(raw.locations).toHaveLength(5);
  });

  it("retains a sparse plausible flight out and back", async () => {
    for (const [longitude, seconds] of [[120, 0], [120, 30], [112, 3530], [120, 7030], [120, 7060]])
      await report(longitude, seconds);
    expect((await list()).locations.some(p => p.quality.status === "outlier" || p.quality.status === "review")).toBe(false);
    expect((await list("?view=filtered")).locations).toHaveLength(5);
  });

  it("bounds work even when the device has a large history", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ longitude: 120, timestamp: i * 60000 }));
    await env.DB.prepare(`INSERT INTO Locations (Longitude, Latitude, City, Device, Date)
      SELECT json_extract(value, '$.longitude'), 30, '', 'phone', json_extract(value, '$.timestamp') FROM json_each(?)`)
      .bind(JSON.stringify(rows)).run();
    const result = await report(120, 200 * 60);
    expect(result.analysis.windowPoints).toBe(65);
    expect(result.analysis.updatedPoints).toBe(27);
    expect((await list("?limit=1")).locations[0].quality.status).toBe("unassessed");
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT * FROM Locations
      WHERE Device = ? AND (Date, ID) <= (?, ?) ORDER BY Date DESC, ID DESC LIMIT 66`)
      .bind("phone", 6000000, 100).all<{ detail: string }>();
    expect(plan.results.some(p => p.detail.includes("idx_locations_device_date") && p.detail.includes("Date<"))).toBe(true);
  });

  it("preserves a successful ingest when annotation fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
      if (++calls > 1) throw new Error("analysis unavailable");
      return env.DB.batch(statements);
    } } as unknown as D1Database;
    try {
      const response = await worker.fetch(request(payload(120, 0)), { DB: db, INGEST_TOKEN: "test-token" });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ location: { quality: { status: "pending" } }, analysis: { state: "deferred" } });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM Locations").first("count")).toBe(1);
    } finally { log.mockRestore(); }
  });

  it("does not let an older request overwrite the evidence from a concurrent newer ingest", async () => {
    await report(120, 0); await report(120, 30); const spike = await report(121, 60);
    let inserted = false, staleChanges: number | undefined;
    const db = { batch: env.DB.batch.bind(env.DB), prepare: (sql: string) => {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("INSERT INTO LocationQuality") || !sql.includes("FROM json_each(?)")) return statement;
      return { bind: (...values: unknown[]) => ({ run: async () => {
        const stale = !inserted;
        if (stale) { inserted = true; await report(120, 120); }
        const result = await statement.bind(...values).run();
        if (stale) staleChanges = result.meta.changes;
        return result;
      } }) };
    } } as unknown as D1Database;
    const response = await worker.fetch(request(payload(120, 90)), { DB: db, INGEST_TOKEN: "test-token" } satisfies ApiEnv);
    expect(response.status).toBe(201);
    expect((await response.json<IngestResult>()).analysis.state).toBe("updated");
    expect(staleChanges).toBe(0);
    expect((await list()).locations.find(p => p.id === spike.location.id)?.quality.status).toBe("outlier");
  });

  it("continues to annotate through the legacy ingest while preserving its response", async () => {
    const response = await SELF.fetch("https://example.com/location", { method: "PUT", headers: { Token: "test-token" },
      body: new URLSearchParams({ lng: "120", lat: "30", datetime: "1000", device: "phone" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect((await list()).locations[0].quality.status).toBe("pending");
  });

  it("rejects unknown quality views", async () => {
    const response = await SELF.fetch("https://example.com/api/locations?view=maybe", { headers: AUTH });
    expect(response.status).toBe(400);
  });
});
