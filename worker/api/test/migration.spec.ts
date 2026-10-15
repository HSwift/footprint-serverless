import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import migration from "../migrations/0001_init.sql?raw";
import qualityMigration from "../migrations/0002_location_quality.sql?raw";
import historyMigration from "../migrations/0003_location_history_index.sql?raw";
import timezoneMigration from "../migrations/0004_location_timezone.sql?raw";

it("adopts the old schema without dropping rows and adds indexes idempotently", async () => {
  // Each test file has its own local D1 binding. These are the original table definitions.
  await env.DB.exec("CREATE TABLE Locations (ID INTEGER PRIMARY KEY AUTOINCREMENT, Longitude NUMERIC(10,6), Latitude NUMERIC(10,6), City TEXT, Device TEXT, Date DATETIME);");
  await env.DB.exec("CREATE TABLE Projects (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, StartTime DATETIME, EndTime DATETIME);");
  await env.DB.exec("INSERT INTO Locations VALUES (42, 121.47, 31.23, 'Shanghai', 'phone', 1000);");
  await env.DB.exec("INSERT INTO Projects VALUES (7, 'trip', 1000, 3000);");
  const sql = `${migration}\n${qualityMigration}\n${historyMigration}`.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  for (let pass = 0; pass < 2; pass++) {
    for (const statement of sql.split(";")) {
      const query = statement.replace(/\s+/g, " ").trim();
      if (query) await env.DB.exec(query);
    }
  }
  expect(await env.DB.prepare("SELECT ID, Longitude, Date FROM Locations").first()).toEqual({ ID: 42, Longitude: 121.47, Date: 1000 });
  expect(await env.DB.prepare("SELECT ID, Name, StartTime, EndTime FROM Projects").first()).toEqual({ ID: 7, Name: "trip", StartTime: 1000, EndTime: 3000 });
  const indexes = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all<{ name: string }>();
  expect(indexes.results.map(row => row.name).sort()).toEqual(["idx_locations_date", "idx_locations_device_date", "idx_locations_device_id", "idx_locations_device_latitude_longitude_date", "idx_projects_name"]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM LocationQuality").first("count")).toBe(0);
  await env.DB.exec(timezoneMigration.split("\n").filter(line => !line.startsWith("--")).join(" "));
  expect(await env.DB.prepare("SELECT ID, Date, Timezone FROM Locations").first()).toEqual({ ID: 42, Date: 1000, Timezone: null });
});
