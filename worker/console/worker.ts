import { createRemoteJWKSet, jwtVerify } from "jose";

type Forwarder = { fetch(request: Request): Promise<Response> };
export interface ConsoleEnv {
  API: Forwarder;
  ASSETS: Forwarder;
  INGEST_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  MAPBOX_PUBLIC_TOKEN?: string;
  MAPBOX_STYLE?: string;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
function error(status: number, code: string, message: string) { return json({ error: { code, message } }, status); }

async function authenticate(request: Request, env: ConsoleEnv): Promise<Response | null> {
  let issuer: string;
  try {
    const team = new URL(env.ACCESS_TEAM_DOMAIN || "");
    if (team.protocol !== "https:" || !team.hostname.endsWith(".cloudflareaccess.com") || team.pathname !== "/"
      || team.search || team.hash || team.username || team.password || !env.ACCESS_AUD?.trim()) throw new Error();
    issuer = team.origin;
  } catch { return error(503, "access_not_configured", "Configure Cloudflare Access for this console"); }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return error(401, "unauthorized", "Cloudflare Access authentication is required");
  try {
    let keys = keySets.get(issuer);
    if (!keys) { keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keySets.set(issuer, keys); }
    await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub"] });
    return null;
  } catch { return error(401, "unauthorized", "Cloudflare Access authentication is required"); }
}

export async function routeConsoleRequest(request: Request, env: ConsoleEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    return json({ status: "ok", name: "footprint-serverless-console" });
  }
  const unauthorized = await authenticate(request, env);
  if (unauthorized) return unauthorized;
  if (path === "/api/console-config") {
    if (request.method !== "GET") return error(405, "method_not_allowed", "Use GET");
    return json({ mapboxToken: env.MAPBOX_PUBLIC_TOKEN?.startsWith("pk.") ? env.MAPBOX_PUBLIC_TOKEN : "",
      mapboxStyle: env.MAPBOX_STYLE || "mapbox://styles/mapbox/light-v11", localPreview: false });
  }
  if (path === "/api" || path.startsWith("/api/")) {
    const read = request.method === "GET" && (/^\/api\/(me|location|locations|projects)$/.test(path) || /^\/api\/projects\/[^/]+$/.test(path));
    const write = (request.method === "POST" && path === "/api/projects")
      || (request.method === "PATCH" && /^\/api\/projects\/[1-9]\d*$/.test(path));
    if (!read && !write) return error(405, "method_not_allowed", "This console only reads tracks and manages projects");
    if (write && (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")) {
      return error(403, "forbidden", "Project writes require a same-origin request");
    }
    if (!env.INGEST_TOKEN) return error(503, "api_not_configured", "The console API binding is not configured");
    const forwarded = new Request(`https://footprint-api.internal${path}${url.search}`, request);
    for (const key of [...forwarded.headers.keys()]) if (key !== "content-type" && key !== "accept") forwarded.headers.delete(key);
    forwarded.headers.set("authorization", `Bearer ${env.INGEST_TOKEN}`);
    try {
      const response = await env.API.fetch(forwarded);
      const result = new Response(response.body, response);
      result.headers.set("Cache-Control", "no-store");
      result.headers.delete("set-cookie");
      return result;
    } catch { return error(502, "api_unavailable", "The API is temporarily unavailable"); }
  }
  return env.ASSETS.fetch(request);
}

export default { fetch: routeConsoleRequest };
