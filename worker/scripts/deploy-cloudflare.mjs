import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workerRoot } from "./render-cloudflare.mjs";

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
