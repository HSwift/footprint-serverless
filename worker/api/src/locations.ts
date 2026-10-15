import { ApiError, badRequest, json } from "./http";
import { locationJson, type ApiEnv, type LocationRow, type ProjectRow } from "./types";
import { integerParam, locationInput, readBody, text, timestamp } from "./validate";
import { analyzeRecentLocations, ingestLocation, QUALITY_COLUMNS, QUALITY_JOIN, qualityJson, type LocationWithQuality } from "./location-quality";

export async function findProject(env: ApiEnv, name: string): Promise<ProjectRow> {
  // The old schema permits duplicate names; preserve it and choose consistently.
  const row = await env.DB.prepare("SELECT ID, Name, StartTime, EndTime FROM Projects WHERE Name = ? ORDER BY ID LIMIT 1")
    .bind(name).first<ProjectRow>();
  if (!row) throw new ApiError(404, "project_not_found", "Project does not exist");
  return row;
}

async function filters(url: URL, env: ApiEnv, qualityView = false) {
  const clauses: string[] = [];
  const values: (number | string)[] = [];
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const start = since === null ? null : timestamp(since, "since");
  const end = until === null ? null : timestamp(until, "until");
  if (start !== null && end !== null && start > end) badRequest("since", "since must not be after until");
  if (start !== null) { clauses.push("Date >= ?"); values.push(start); }
  if (end !== null) { clauses.push("Date <= ?"); values.push(end); }
  const device = url.searchParams.get("device");
  if (device !== null) { clauses.push("Device = ?"); values.push(text(device, "device", 200)); }
  const name = url.searchParams.get("project");
  if (name !== null) {
    const project = await findProject(env, text(name, "project", 200));
    clauses.push("Date BETWEEN ? AND ?"); values.push(project.StartTime, project.EndTime);
  }
  if (qualityView) {
    const view = url.searchParams.get("view") ?? "raw";
    if (view !== "raw" && view !== "filtered") badRequest("view", "view must be raw or filtered");
    if (view === "filtered") clauses.push("(q.Status IS NULL OR q.Status <> 'outlier')");
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

export async function latestLocation(url: URL, env: ApiEnv, legacy: boolean): Promise<Response> {
  const filter = await filters(url, env, !legacy);
  const row = await env.DB.prepare(`SELECT ${legacy ? "*" : QUALITY_COLUMNS} FROM ${legacy ? "Locations" : QUALITY_JOIN}
    ${filter.sql} ORDER BY Date DESC, ID DESC LIMIT 1`).bind(...filter.values).first<LocationWithQuality>();
  return legacy ? json({ success: true, name: "location-report-service", data: row })
    : json({ location: row ? { ...locationJson(row), quality: qualityJson(row) } : null });
}

export async function listLocations(url: URL, env: ApiEnv, legacy: boolean): Promise<Response> {
  const filter = await filters(url, env, !legacy);
  if (legacy) {
    const result = await env.DB.prepare(`SELECT * FROM Locations ${filter.sql} ORDER BY Date DESC, ID DESC`)
      .bind(...filter.values).all<LocationRow>();
    // Match the original D1 result envelope for existing consumers.
    return json({ success: true, name: "location-report-service", data: result });
  }
  const limit = integerParam(url, "limit", 500, 1, 5000);
  const offset = integerParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const order = url.searchParams.get("order") ?? "asc";
  if (order !== "asc" && order !== "desc") badRequest("order", "order must be asc or desc");
  const direction = order === "asc" ? "ASC" : "DESC";
  const result = await env.DB.prepare(`SELECT ${QUALITY_COLUMNS} FROM ${QUALITY_JOIN} ${filter.sql}
    ORDER BY Date ${direction}, ID ${direction} LIMIT ? OFFSET ?`)
    .bind(...filter.values, limit + 1, offset).all<LocationWithQuality>();
  const hasMore = result.results.length > limit;
  return json({ locations: result.results.slice(0, limit).map(row => ({ ...locationJson(row), quality: qualityJson(row) })),
    pagination: { limit, offset, hasMore } });
}

export async function reportLocation(request: Request, env: ApiEnv, legacy: boolean): Promise<Response> {
  const input = await locationInput(request, legacy);
  const row = await ingestLocation(env.DB, input);
  const processed = await analyzeRecentLocations(env.DB, row);
  return legacy ? json({ success: true }) : json({ location: { ...locationJson(row), quality: processed.quality }, analysis: processed.analysis }, 201);
}

// Compatibility with the old Pages /data endpoint, now always token-protected.
export async function mapData(request: Request, env: ApiEnv): Promise<Response> {
  const body = await readBody(request);
  const name = text(body.project, "project", 200);
  let condition = "";
  let suffix = "ORDER BY Date ASC, ID ASC";
  const values: number[] = [];
  if (name === "current") suffix = "ORDER BY Date DESC, ID DESC LIMIT 1";
  else if (name !== "all") {
    const project = await findProject(env, name);
    condition = "WHERE Date BETWEEN ? AND ?";
    values.push(project.StartTime, project.EndTime);
  }
  const result = await env.DB.prepare(`SELECT Longitude, Latitude, City, Date FROM Locations ${condition} ${suffix}`)
    .bind(...values).all();
  return json(result.results);
}
