import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "./env.js";
import { runDemo } from "../src/demo.js";

test("the simulated Claude session warns, blocks, and honors the kill switch", () => {
  const result = runDemo();
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /Demo passed/);
  assert.match(result.text, /permissionDecision/);
  assert.match(result.text, /kill switch/);
});

test("the CLI demo command exits 0", () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
  const child = spawnSync(process.execPath, [cli, "demo"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /Demo passed/);
});
