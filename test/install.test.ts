import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./env.js";
import { installHooks, invocation, uninstallHooks } from "../src/install.js";
import { isRecord } from "../src/jsonutil.js";

test("Claude install is idempotent and leaves existing hooks in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-install-"));
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] }],
      },
    }),
  );
  const invoke = invocation("claude-code", "/usr/bin/node", "/opt/spendguard/dist/src/cli.js");
  installHooks({ adapter: "claude-code", settingsPath: settings, invocation: invoke });
  installHooks({ adapter: "claude-code", settingsPath: settings, invocation: invoke });
  const parsed = JSON.parse(fs.readFileSync(settings, "utf8")) as unknown;
  assert.ok(isRecord(parsed) && isRecord(parsed.hooks));
  const groups = parsed.hooks.PreToolUse;
  assert.ok(Array.isArray(groups));
  const commands: unknown[] = [];
  for (const group of groups) {
    assert.ok(isRecord(group) && Array.isArray(group.hooks));
    commands.push(...group.hooks);
  }
  const ours = commands.filter((hook) => isRecord(hook) && Array.isArray(hook.args) && hook.args.includes("--spendguard"));
  const kept = commands.filter((hook) => isRecord(hook) && hook.command === "echo keep");
  assert.equal(ours.length, 1);
  assert.equal(kept.length, 1);
  const pre = ours[0];
  assert.ok(isRecord(pre));
  assert.equal(pre.onFailure, "block");
  uninstallHooks(settings);
  const after = JSON.parse(fs.readFileSync(settings, "utf8")) as { hooks: { PreToolUse: Array<{ hooks: unknown[] }> } };
  const remaining = after.hooks.PreToolUse.flatMap((group) => group.hooks);
  assert.equal(remaining.length, 1);
});

test("Cursor install writes a fail-closed permission hook", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-cursor-"));
  const settings = path.join(dir, "hooks.json");
  const invoke = invocation("cursor", "/usr/bin/node", "/tmp/my dir/cli.js");
  installHooks({ adapter: "cursor", settingsPath: settings, invocation: invoke });
  const parsed = JSON.parse(fs.readFileSync(settings, "utf8")) as {
    version: number;
    hooks: { preToolUse: Array<{ command: string; failClosed: boolean }> };
  };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.hooks.preToolUse.length, 1);
  assert.equal(parsed.hooks.preToolUse[0]?.failClosed, true);
  assert.match(parsed.hooks.preToolUse[0]?.command ?? "", /--adapter' 'cursor'/);
  assert.match(parsed.hooks.preToolUse[0]?.command ?? "", /my dir/);
});
