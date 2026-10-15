import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { routeConsoleRequest, type ConsoleEnv } from "../worker";

const issuer = "https://example.cloudflareaccess.com", audience = "example-console-audience";
let pair: Awaited<ReturnType<typeof generateKeyPair>>, jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => { pair = await generateKeyPair("RS256"); jwk = { ...await exportJWK(pair.publicKey), kid: "example-key", alg: "RS256" }; });
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
  expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
})));
afterEach(() => vi.unstubAllGlobals());

async function token(options: { issuer?: string; audience?: string; expired?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "example-key" }).setSubject("example-user")
    .setIssuer(options.issuer || issuer).setAudience(options.audience || audience)
    .setIssuedAt(now - 60).setExpirationTime(options.expired ? now - 30 : now + 300).sign(pair.privateKey);
}
function env() {
  return { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, INGEST_TOKEN: "example-server-only-token",
    MAPBOX_PUBLIC_TOKEN: "pk.example", MAPBOX_STYLE: "mapbox://styles/mapbox/light-v11",
    API: { fetch: vi.fn(async (_request: Request) => Response.json({ locations: [] })) },
    ASSETS: { fetch: vi.fn(async (_request: Request) => new Response("application assets")) } } satisfies ConsoleEnv;
}
async function request(path: string, init: RequestInit = {}, options?: Parameters<typeof token>[0]) {
  const headers = new Headers(init.headers); headers.set("cf-access-jwt-assertion", await token(options));
  return new Request(`https://console.example.com${path}`, { ...init, headers });
}

describe("production Console Worker", () => {
  it("keeps the health check independent of authentication and D1", async () => {
    const bindings = env();
    expect((await routeConsoleRequest(new Request("https://console.example.com/health"), bindings)).status).toBe(200);
    expect(bindings.API.fetch).not.toHaveBeenCalled();
  });
  it("fails closed until Access is configured, including static assets", async () => {
    const bindings = { ...env(), ACCESS_AUD: undefined };
    expect((await routeConsoleRequest(new Request("https://console.example.com/"), bindings)).status).toBe(503);
    expect(bindings.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it("rejects a forged identity header without a signed JWT", async () => {
    const bindings = env();
    const req = new Request("https://console.example.com/api/locations", { headers: { "cf-access-authenticated-user-email": "person@example.invalid" } });
    expect((await routeConsoleRequest(req, bindings)).status).toBe(401);
    expect(bindings.API.fetch).not.toHaveBeenCalled();
  });
  it.each([{ audience: "wrong-audience" }, { issuer: "https://another.cloudflareaccess.com" }, { expired: true }])("rejects invalid Access claims: %j", async options => {
    const bindings = env();
    expect((await routeConsoleRequest(await request("/api/locations", {}, options), bindings)).status).toBe(401);
    expect(bindings.API.fetch).not.toHaveBeenCalled();
  });
  it("returns only the public map configuration after signature verification", async () => {
    const bindings = env();
    const response = await routeConsoleRequest(await request("/api/console-config"), bindings);
    expect(await response.json()).toEqual({ mapboxToken: "pk.example", mapboxStyle: bindings.MAPBOX_STYLE, localPreview: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bindings.API.fetch).not.toHaveBeenCalled();
  });
  it("replaces browser credentials with the server Token over the Service Binding", async () => {
    const bindings = env();
    const response = await routeConsoleRequest(await request("/api/locations?limit=1", { headers: { authorization: "Bearer untrusted", cookie: "private-cookie", token: "untrusted" } }), bindings);
    expect(response.status).toBe(200);
    const forwarded = bindings.API.fetch.mock.calls[0][0];
    expect(forwarded.url).toBe("https://footprint-api.internal/api/locations?limit=1");
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${bindings.INGEST_TOKEN}`);
    for (const name of ["cookie", "token", "cf-access-jwt-assertion"]) expect(forwarded.headers.get(name)).toBeNull();
  });
  it("forwards project writes from the console and preserves their request body", async () => {
    const bindings = env();
    await routeConsoleRequest(await request("/api/projects", { method: "POST", headers: { origin: "https://console.example.com", "content-type": "application/json" }, body: JSON.stringify({ name: "example" }) }), bindings);
    expect(await bindings.API.fetch.mock.calls[0][0].json()).toEqual({ name: "example" });
  });
  it("rejects cross-origin project writes and location mutations", async () => {
    const bindings = env();
    expect((await routeConsoleRequest(await request("/api/projects", { method: "POST", headers: { origin: "https://other.example.com" }, body: "{}" }), bindings)).status).toBe(403);
    expect((await routeConsoleRequest(await request("/api/location", { method: "PUT" }), bindings)).status).toBe(405);
    expect(bindings.API.fetch).not.toHaveBeenCalled();
  });
  it("serves assets only after Access verification", async () => {
    const bindings = env();
    expect(await (await routeConsoleRequest(await request("/"), bindings)).text()).toBe("application assets");
    expect(bindings.ASSETS.fetch).toHaveBeenCalledOnce();
  });
});
