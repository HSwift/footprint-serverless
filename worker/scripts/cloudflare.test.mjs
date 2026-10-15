import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderConfig, workerRoot } from "./render-cloudflare.mjs";
import { deploymentCommands } from "./deploy-cloudflare.mjs";
const template = target => JSON.parse(readFileSync(`${workerRoot}/${target}/wrangler.jsonc`, "utf8").split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n"));

test("API Builder binds its own database without modifying the public template", () => {
  const source = template("api"), id = randomUUID();
  const config = renderConfig("api", source, { D1_DATABASE_ID: id, D1_DATABASE_NAME: "example-database" });
  assert.equal(config.d1_databases[0].database_id, id);
  assert.equal(config.d1_databases[0].database_name, "example-database");
  assert.equal(source.d1_databases[0].database_id, undefined);
  assert.throws(() => renderConfig("api", source, {}), /D1_DATABASE_ID/);
});
test("Console Builder binds only the API service and preserves separately managed runtime variables", () => {
  const config = renderConfig("console", template("console"), { API_WORKER_NAME: "example-api" });
  assert.equal(config.services[0].service, "example-api");
  assert.equal(config.d1_databases, undefined);
  assert.equal(config.vars, undefined);
  assert.equal(config.keep_vars, true);
  assert.equal(config.assets.run_worker_first, true);
});
test("incomplete Access settings and private Mapbox tokens are rejected", () => {
  const source = template("console");
  assert.throws(() => renderConfig("console", source, { ACCESS_AUD: "example-audience" }), /both/);
  assert.throws(() => renderConfig("console", source, { MAPBOX_PUBLIC_TOKEN: "sk.example" }), /public/);
  assert.throws(() => renderConfig("console", source, { ACCESS_AUD: "example-audience", ACCESS_TEAM_DOMAIN: "http://example.invalid" }), /HTTPS/);
});
test("independent Builders migrate only for the API and upload secrets only for bootstrap", () => {
  assert.equal(deploymentCommands("api", false).length, 2);
  assert.equal(deploymentCommands("console", false).length, 1);
  assert.deepEqual(deploymentCommands("console", false)[0], ["deploy", "--config", "console/wrangler.generated.jsonc"]);
  assert(deploymentCommands("api", true)[1].includes("api/.deploy-secrets.generated.json"));
  assert(!deploymentCommands("api", false)[1].includes("--secrets-file"));
});
