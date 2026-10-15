import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workerRoot = fileURLToPath(new URL("../", import.meta.url));
export function renderConfig(target, template, variables) {
  if (target !== "api" && target !== "console") throw new Error("Select api or console");
  const config = structuredClone(template);
  const name = variables[target === "api" ? "API_WORKER_NAME" : "CONSOLE_WORKER_NAME"]?.trim();
  if (name) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Worker name is invalid");
    config.name = name;
  }
  if (target === "api") {
    const id = variables.D1_DATABASE_ID?.trim();
    if (id && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new Error("D1_DATABASE_ID must be a database UUID");
    const binding = config.d1_databases.find(database => database.binding === "DB");
    if (id) binding.database_id = id;
    if (variables.D1_DATABASE_NAME?.trim()) binding.database_name = variables.D1_DATABASE_NAME.trim();
  } else {
    config.services.find(service => service.binding === "API").service = variables.API_WORKER_NAME?.trim() || "footprint-serverless-api";
    const values = Object.fromEntries(["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "MAPBOX_PUBLIC_TOKEN", "MAPBOX_STYLE"]
      .filter(key => variables[key]?.trim()).map(key => [key, variables[key].trim()]));
    if (Boolean(values.ACCESS_TEAM_DOMAIN) !== Boolean(values.ACCESS_AUD)) throw new Error("Set both ACCESS_TEAM_DOMAIN and ACCESS_AUD");
    if (values.ACCESS_TEAM_DOMAIN) {
      const url = new URL(values.ACCESS_TEAM_DOMAIN);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") || url.pathname !== "/" || url.search || url.hash) throw new Error("ACCESS_TEAM_DOMAIN must be a Cloudflare Access HTTPS origin");
      values.ACCESS_TEAM_DOMAIN = url.origin;
    }
    if (values.MAPBOX_PUBLIC_TOKEN && !values.MAPBOX_PUBLIC_TOKEN.startsWith("pk.")) throw new Error("Use a public Mapbox token");
    if (Object.keys(values).length) config.vars = { ...config.vars, ...values };
  }
  return config;
}

export function renderDeployment(target, variables = process.env) {
  const directory = resolve(workerRoot, target);
  const text = readFileSync(resolve(directory, "wrangler.jsonc"), "utf8").split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n");
  const config = renderConfig(target, JSON.parse(text), variables);
  const secrets = resolve(directory, ".deploy-secrets.generated.json");
  rmSync(secrets, { force: true });
  const token = variables.RUNTIME_INGEST_TOKEN?.trim();
  if (token) {
    if (token.length < 32 || /change-me|local-development/i.test(token)) throw new Error("Use a random production RUNTIME_INGEST_TOKEN of at least 32 characters");
    writeFileSync(secrets, JSON.stringify({ INGEST_TOKEN: token }), { mode: 0o600 });
  }
  writeFileSync(resolve(directory, "wrangler.generated.jsonc"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Rendered ${target} deployment configuration; values are not logged.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) renderDeployment(process.argv[2]);
