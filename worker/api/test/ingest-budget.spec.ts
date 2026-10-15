import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import schema from "../migrations/0001_init.sql?raw";
import qualitySchema from "../migrations/0002_location_quality.sql?raw";
import historySchema from "../migrations/0003_location_history_index.sql?raw";
import timezoneSchema from "../migrations/0004_location_timezone.sql?raw";
import worker from "../src/index";
import { QUALITY_VERSION, analyzeRecentLocations } from "../src/location-quality";
import type { LocationRow } from "../src/types";

beforeAll(async () => {
  const sql = `${schema}\n${qualitySchema}\n${historySchema}\n${timezoneSchema}`.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  for (const statement of sql.split(";")) if (statement.trim()) await env.DB.exec(statement.replace(/\s+/g, " ").trim());
});
beforeEach(async () => { await env.DB.exec("DELETE FROM Locations; DELETE FROM LocationAnalysisState;"); });

function tracedDatabase() {
  const metrics = { queries: 0, calls: 0, rowsRead: 0, rowsWritten: 0, historyQueries: 0 };
  const prepared = new WeakMap<object, { sql: string; statement: D1PreparedStatement }>();
  const record = (sql: string, result: D1Result) => {
    metrics.queries++; metrics.rowsRead += result.meta.rows_read; metrics.rowsWritten += result.meta.rows_written;
    if (sql.includes("INDEXED BY idx_locations_device_latitude_longitude_date")) metrics.historyQueries++;
  };
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    const object = {
      bind: (...values: unknown[]) => wrap(sql, statement.bind(...values)),
      all: async () => { metrics.calls++; const result = await statement.all(); record(sql, result); return result; },
      run: async () => { metrics.calls++; const result = await statement.run(); record(sql, result); return result; },
      first: async (column?: string) => {
        metrics.calls++; const result = await statement.all(); record(sql, result);
        return column ? (result.results[0] as Record<string, unknown> | undefined)?.[column] ?? null : result.results[0] ?? null;
      },
    } as unknown as D1PreparedStatement;
    prepared.set(object, { sql, statement }); return object;
  };
  const db = {
    prepare: (sql: string) => wrap(sql, env.DB.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      metrics.calls++;
      const list = statements.map(s => prepared.get(s)!);
      const results = await env.DB.batch(list.map(s => s.statement));
      results.forEach((r, i) => record(list[i].sql, r)); return results;
    },
  } as unknown as D1Database;
  return { db, metrics };
}

async function seedNormalHistory(count = 70) {
  const rows = Array.from({ length: count }, (_, i) => ({ date: i * 60_000 }));
  await env.DB.prepare(`INSERT INTO Locations (Longitude, Latitude, City, Device, Date)
    SELECT 120, 30, '', 'phone', json_extract(value, '$.date') FROM json_each(?)`).bind(JSON.stringify(rows)).run();
  await env.DB.prepare(`INSERT INTO LocationQuality (LocationID, Status, Reason, AlgorithmVersion, Revision, CheckedAt, Evidence)
    SELECT ID, CASE WHEN Date >= ? THEN 'pending' ELSE 'retained' END,
      CASE WHEN Date >= ? THEN 'awaiting_context' ELSE 'no_excursion_detected' END, ?, 1, 123, '{}' FROM Locations`)
    .bind((count - 2) * 60_000, (count - 2) * 60_000, QUALITY_VERSION).run();
  await env.DB.prepare("INSERT INTO LocationAnalysisState (Device, Revision) VALUES ('phone', 1)").run();
}

async function report(db: D1Database, seconds: number, longitude = 120) {
  const response = await worker.fetch(new Request("https://example.com/api/location", {
    method: "PUT", headers: { Authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ device: "phone", longitude, latitude: 30, timestamp: seconds * 1000 }),
  }), { DB: db, INGEST_TOKEN: "test-token" });
  expect(response.status).toBe(201);
  return response.json<{ location: { id: number; quality: { status: string } }; analysis: { state: string; updatedPoints: number } }>();
}

it("measures D1 queries and writes for an ordinary ingest with an already analyzed history", async () => {
  await seedNormalHistory();
  const { db, metrics } = tracedDatabase();
  const result = await report(db, 4200);
  expect(metrics.queries).toBe(5);
  expect(metrics.calls).toBe(3);
  expect(metrics.historyQueries).toBe(0);
  expect(metrics.rowsRead).toBeLessThanOrEqual(500);
  expect(metrics.rowsWritten).toBeLessThanOrEqual(10);
  expect(result.analysis.updatedPoints).toBe(1);
  expect(result.location.quality.status).toBe("pending");
  expect(await env.DB.prepare(`SELECT q.CheckedAt, q.Revision FROM LocationQuality q JOIN Locations l ON l.ID = q.LocationID
    WHERE l.Date = 3600000`).first()).toEqual({ CheckedAt: 123, Revision: 1 });
});

it("keeps normal ingest reads bounded as device history grows", async () => {
  await seedNormalHistory(3000);
  const { db, metrics } = tracedDatabase();
  const result = await report(db, 3000 * 60);
  expect(metrics.queries).toBe(5);
  expect(metrics.rowsRead).toBeLessThanOrEqual(500);
  expect(metrics.rowsWritten).toBeLessThanOrEqual(10);
  expect(result.analysis.updatedPoints).toBe(1);
});

it("does not write unchanged annotations when the same window is checked again", async () => {
  await seedNormalHistory(); await report(env.DB, 4200);
  const target = await env.DB.prepare("SELECT * FROM Locations ORDER BY Date DESC LIMIT 1").first<LocationRow>();
  const { db, metrics } = tracedDatabase();
  expect((await analyzeRecentLocations(db, target!)).analysis).toMatchObject({ state: "updated", updatedPoints: 0 });
  expect(metrics.queries).toBe(2);
  expect(metrics.rowsWritten).toBe(0);
});

it("retries an unchanged window if concurrent arrivals provide newer context", async () => {
  await report(env.DB, 0);
  const target = await env.DB.prepare("SELECT * FROM Locations LIMIT 1").first<LocationRow>();
  let inserted = false;
  const db = { batch: env.DB.batch.bind(env.DB), prepare: (sql: string) => {
    const statement = env.DB.prepare(sql);
    if (sql !== "SELECT Revision FROM LocationAnalysisState WHERE Device = ?") return statement;
    return { bind: (...values: unknown[]) => ({ first: async () => {
      if (!inserted) { inserted = true; await report(env.DB, 30); await report(env.DB, 60); }
      return statement.bind(...values).first();
    } }) };
  } } as unknown as D1Database;
  const result = await analyzeRecentLocations(db, target!);
  expect(inserted).toBe(true);
  expect(result.analysis).toMatchObject({ state: "updated", windowPoints: 3, updatedPoints: 0 });
  expect(result.quality.status).toBe("retained");
});

it("reuses completed history evidence as more normal points arrive after an excursion", async () => {
  for (const seconds of [0, 30]) await report(env.DB, seconds, 121);
  for (const [longitude, seconds] of [[120, 172800], [120, 172830], [121, 172860], [120, 172890], [120, 172920]])
    await report(env.DB, seconds, longitude);
  const { db, metrics } = tracedDatabase();
  await report(db, 172950);
  expect(metrics.historyQueries).toBe(0);
  expect(metrics.queries).toBe(5);
  expect(await env.DB.prepare("SELECT Status FROM LocationQuality WHERE LocationID = (SELECT ID FROM Locations WHERE Date = 172860000)").first("Status")).toBe("outlier");
});

it("refreshes historical matches when an older visit is reported late", async () => {
  for (const seconds of [172800, 172830]) await report(env.DB, seconds);
  await report(env.DB, 172860, 121); await report(env.DB, 172890); await report(env.DB, 172920);
  const older = await report(env.DB, 0, 121);
  const { db, metrics } = tracedDatabase();
  await report(db, 30, 121);
  expect(metrics.historyQueries).toBe(1);
  expect(metrics.queries).toBe(6);
  const evidence = await env.DB.prepare(`SELECT Evidence FROM LocationQuality WHERE LocationID =
    (SELECT ID FROM Locations WHERE Date = 172860000)`).first<string>("Evidence");
  expect(JSON.parse(evidence!).historicalMatches).toMatchObject([{ previousId: older.location.id }]);
});

it("invalidates cached history when its reference becomes unreliable in the current window", async () => {
  const older = await report(env.DB, 0, 121); await report(env.DB, 30, 121);
  for (const [longitude, seconds] of [[120, 172800], [120, 172830], [121, 172860], [120, 172890], [120, 172920]])
    await report(env.DB, seconds, longitude);
  const readEvidence = () => env.DB.prepare(`SELECT Evidence FROM LocationQuality WHERE LocationID =
    (SELECT ID FROM Locations WHERE Date = 172860000)`).first<string>("Evidence");
  expect(JSON.parse((await readEvidence())!).historicalMatches).toMatchObject([{ previousId: older.location.id }]);
  await env.DB.prepare("INSERT INTO Locations (Longitude, Latitude, City, Device, Date) VALUES (120, 30, '', 'phone', 0)").run();
  const { db, metrics } = tracedDatabase();
  await report(db, 172950);
  expect(metrics.historyQueries).toBe(1);
  expect(JSON.parse((await readEvidence())!).historicalMatches).toEqual([]);
});
