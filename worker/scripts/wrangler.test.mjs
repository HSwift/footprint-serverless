import assert from "node:assert/strict";
import { test } from "node:test";
import { wranglerArgs } from "./wrangler.mjs";

test("a fresh checkout uses the public deployment template", () => {
  assert.deepEqual(wranglerArgs(["deploy", "--dry-run"], false), ["deploy", "--dry-run", "--config", "api/wrangler.jsonc"]);
});

test("local deployment settings are selected without entering the shared config", () => {
  assert.deepEqual(wranglerArgs(["d1", "migrations", "apply", "DB", "--remote"], true),
    ["d1", "migrations", "apply", "DB", "--remote", "--config", "api/wrangler.local.jsonc"]);
});

test("explicit configs take precedence over local settings", () => {
  for (const config of [["--config", "api/wrangler.jsonc"], ["-c", "api/wrangler.jsonc"], ["--config=api/wrangler.jsonc"], ["-c=api/wrangler.jsonc"]]) {
    const args = ["deploy", ...config];
    assert.deepEqual(wranglerArgs(args, true), args);
  }
});
