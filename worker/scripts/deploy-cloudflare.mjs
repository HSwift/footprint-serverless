import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { workerRoot } from "./render-cloudflare.mjs";

export async function resolveApiDatabase(config, readWranglerJson) {
  const result = structuredClone(config);
  const binding = result.d1_databases?.find(database => database.binding === "DB");
  if (!binding) throw new Error("The API configuration must declare the DB binding");
  if (binding.database_id) return result;

  const deployment = await readWranglerJson(["deployments", "status", "--json"]);
  const versions = deployment.versions?.filter(version => version.percentage > 0);
  if (!versions?.length) throw new Error("Deploy the API Worker and bind its D1 database as DB before enabling Builds");
  const databases = await Promise.all(versions.map(async version => {
    const details = await readWranglerJson(["versions", "view", version.version_id, "--json"]);
    const database = details.resources?.bindings?.find(value => value.name === "DB" && value.type === "d1");
    if (typeof database?.id !== "string" || !database.id) throw new Error("Bind a D1 database as DB on the API Worker before deploying");
    return database.id;
  }));
  if (new Set(databases).size !== 1) throw new Error("Active API versions use different DB bindings; select one database before running migrations");
  binding.database_id = databases[0];
  // The public template's generic name must not override the existing database.
  delete binding.database_name;
  return result;
}

export function deploymentCommands(target, hasSecrets) {
  if (target !== "api" && target !== "console") throw new Error("Select api or console");
  const config = `${target}/wrangler.generated.jsonc`;
  return [
    ...(target === "api" ? [["d1", "migrations", "apply", "DB", "--remote", "--config", config]] : []),
    ["deploy", "--config", config, ...(hasSecrets ? ["--secrets-file", `${target}/.deploy-secrets.generated.json`] : [])],
  ];
}

async function deploy(target) {
  const config = resolve(workerRoot, target, "wrangler.generated.jsonc");
  const secrets = resolve(workerRoot, target, ".deploy-secrets.generated.json");
  if (!existsSync(config)) throw new Error("Render this Worker's configuration before deploying");
  const require = createRequire(import.meta.url);
  const binary = resolve(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  try {
    if (target === "api") {
      const rendered = JSON.parse(readFileSync(config, "utf8"));
      const resolved = await resolveApiDatabase(rendered, async args => {
        try {
          const { stdout } = await promisify(execFile)(process.execPath, [binary, ...args, "--config", config], {
            cwd: workerRoot, timeout: 60_000, maxBuffer: 1024 * 1024,
          });
          return JSON.parse(stdout);
        } catch {
          throw new Error("Wrangler could not read the API Worker's deployed DB binding. Check Cloudflare authentication and bind D1 as DB, or provide D1_DATABASE_ID for the first deployment.");
        }
      });
      writeFileSync(config, JSON.stringify(resolved, null, 2) + "\n", { mode: 0o600 });
      console.log("API migrations and deployment will reuse the configured DB binding.");
    }
    for (const args of deploymentCommands(target, existsSync(secrets))) {
      await new Promise((accept, reject) => {
        const child = spawn(process.execPath, [binary, ...args], { cwd: workerRoot, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? accept() : reject(new Error(`Deployment failed (${code})`)));
      });
    }
  } finally { rmSync(config, { force: true }); rmSync(secrets, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await deploy(process.argv[2]);
