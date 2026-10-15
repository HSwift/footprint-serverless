import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderConfig, workerRoot } from "./render-cloudflare.mjs";
import { deploymentCommands, resolveApiDatabase } from "./deploy-cloudflare.mjs";
const template = target => JSON.parse(readFileSync(`${workerRoot}/${target}/wrangler.jsonc`, "utf8").split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n"));

test("API Builder does not require a database ID and accepts an explicit first-deployment override", () => {
  const source = template("api"), id = randomUUID();
  const config = renderConfig("api", source, { D1_DATABASE_ID: id, D1_DATABASE_NAME: "example-database" });
  assert.equal(config.d1_databases[0].database_id, id);
  assert.equal(config.d1_databases[0].database_name, "example-database");
  assert.equal(source.d1_databases[0].database_id, undefined);
  assert.equal(renderConfig("api", source, {}).d1_databases[0].database_id, undefined);
  assert.throws(() => renderConfig("api", source, { D1_DATABASE_ID: "invalid" }), /UUID/);
});
test("migrations reuse DB from active versions and ignore versions without traffic", async () => {
  const id = randomUUID(), source = template("api"), seen = [];
  const config = await resolveApiDatabase(source, async args => {
    seen.push(args);
    if (args[0] === "deployments") return { versions: [
      { version_id: "active-a", percentage: 90 }, { version_id: "active-b", percentage: 10 },
      { version_id: "inactive", percentage: 0 },
    ] };
    assert.notEqual(args[2], "inactive");
    return { resources: { bindings: [{ name: "OTHER", type: "d1", id: randomUUID() }, { name: "DB", type: "d1", id }] } };
  });
  assert.equal(config.d1_databases[0].database_id, id);
  assert.equal(config.d1_databases[0].database_name, undefined);
  assert.equal(config.d1_databases[0].migrations_dir, "migrations");
  assert.equal(source.d1_databases[0].database_id, undefined);
  assert.equal(source.d1_databases[0].database_name, "footprint");
  assert.equal(seen.length, 3);
});
test("missing or inconsistent deployed DB bindings stop migrations", async () => {
  const source = template("api");
  await assert.rejects(resolveApiDatabase(source, async () => ({ versions: [] })), /bind.*DB/);
  await assert.rejects(resolveApiDatabase(source, async args => args[0] === "deployments"
    ? { versions: [{ version_id: "active", percentage: 100 }] }
    : { resources: { bindings: [{ name: "DB", type: "plain_text", text: "wrong-type" }] } }), /Bind a D1 database as DB/);
  await assert.rejects(resolveApiDatabase(source, async args => args[0] === "deployments"
    ? { versions: [{ version_id: "first", percentage: 50 }, { version_id: "second", percentage: 50 }] }
    : { resources: { bindings: [{ name: "DB", type: "d1", id: randomUUID() }] } }), /different DB bindings/);
});
test("an explicit database ID supports the first deployment without looking up an existing Worker", async () => {
  const id = randomUUID();
  const config = renderConfig("api", template("api"), { D1_DATABASE_ID: id });
  const resolved = await resolveApiDatabase(config, async () => { throw new Error("No Worker exists yet"); });
  assert.equal(resolved.d1_databases[0].database_id, id);
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
