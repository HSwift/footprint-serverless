import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerRoot = fileURLToPath(new URL("../", import.meta.url));

export function wranglerArgs(args, hasPrivateConfig) {
  const explicitConfig = args.some(arg => arg === "--config" || arg === "-c" || arg.startsWith("--config=") || arg.startsWith("-c="));
  return explicitConfig ? args : [...args, "--config", hasPrivateConfig ? "api/wrangler.local.jsonc" : "api/wrangler.jsonc"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const binary = resolve(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const args = wranglerArgs(process.argv.slice(2), existsSync(resolve(workerRoot, "api/wrangler.local.jsonc")));
  const child = spawn(process.execPath, [binary, ...args], { cwd: workerRoot, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
}
