import { authenticate } from "./auth";
import { ApiError, errorResponse, json, requireMethod } from "./http";
import { findProject, latestLocation, listLocations, mapData, reportLocation } from "./locations";
import { createProject, updateProject } from "./projects";
import { projectJson, type ApiEnv, type ProjectRow } from "./types";
import { integerParam, text } from "./validate";

async function route(request: Request, env: ApiEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    requireMethod(request, ["GET"]);
    return json({ status: "ok", name: "footprint-serverless-api" });
  }
  const legacy = ["/location", "/locations", "/data"].includes(url.pathname);
  if (!legacy && !url.pathname.startsWith("/api/")) throw new ApiError(404, "not_found", "Unknown route");
  authenticate(request, env, legacy);

  switch (url.pathname) {
    case "/api/me":
      requireMethod(request, ["GET"]);
      return json({ authenticated: true, method: "bearer" });
    case "/api/location":
    case "/location":
      requireMethod(request, ["GET", "PUT"]);
      return request.method === "PUT" ? reportLocation(request, env, legacy) : latestLocation(url, env, legacy);
    case "/api/locations":
    case "/locations":
      requireMethod(request, ["GET"]);
      return listLocations(url, env, legacy);
    case "/data":
      requireMethod(request, ["POST"]);
      return mapData(request, env);
    case "/api/projects": {
      requireMethod(request, ["GET", "POST"]);
      if (request.method === "POST") return createProject(request, env);
      const limit = integerParam(url, "limit", 100, 1, 500);
      const offset = integerParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const result = await env.DB.prepare("SELECT ID, Name, StartTime, EndTime FROM Projects ORDER BY StartTime DESC, ID DESC LIMIT ? OFFSET ?")
        .bind(limit + 1, offset).all<ProjectRow>();
      return json({ projects: result.results.slice(0, limit).map(projectJson), pagination: { limit, offset, hasMore: result.results.length > limit } });
    }
  }
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match) {
    requireMethod(request, ["GET", "PATCH"]);
    if (request.method === "PATCH") return updateProject(request, env, match[1]);
    let name: string;
    try { name = decodeURIComponent(match[1]); }
    catch { throw new ApiError(400, "bad_request", "Invalid project name encoding", "project"); }
    return json({ project: projectJson(await findProject(env, text(name, "project", 200))) });
  }
  throw new ApiError(404, "not_found", "Unknown route");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      // Avoid exposing database internals, request bodies or tokens to callers.
      console.error("API request failed", { path: new URL(request.url).pathname, ray: request.headers.get("cf-ray") });
      return errorResponse(new ApiError(500, "internal_error", "The request could not be completed"));
    }
  },
} satisfies ExportedHandler<ApiEnv>;
