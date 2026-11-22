import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./env.js";
import { setBudget } from "../src/budget.js";
import { handleHook } from "../src/hook.js";
import { isRecord } from "../src/jsonutil.js";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-gemini-"));
}

function hook(dir: string, event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const result = handleHook(
    JSON.stringify({
      hook_event_name: event,
      session_id: "gem-1",
      cwd: dir,
      timestamp: "2026-11-22T15:00:00.000Z",
      ...extra,
    }),
    { home: dir, adapter: "gemini-cli" },
  );
  const parsed = JSON.parse(result.stdout) as unknown;
  assert.ok(isRecord(parsed));
  return parsed;
}

test("Gemini CLI records one snapshot once, so a repeated chunk does not double the bill", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 1 });
  const usage = {
    llm_request: { model: "gemini-3.8-flash" },
    llm_response: { usageMetadata: { promptTokenCount: 800_000, candidatesTokenCount: 0 } },
  };
  hook(dir, "AfterModel", usage);
  hook(dir, "AfterModel", usage);
  const next = hook(dir, "BeforeModel", { llm_request: { model: "gemini-3.8-flash" } });
  assert.equal(next.decision, "allow");
});

test("Gemini CLI blocks the next model call once recorded spend is over the cap", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 0.5 });
  hook(dir, "AfterModel", {
    llm_request: { model: "gemini-3.8-flash" },
    llm_response: { usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 0 } },
  });
  const next = hook(dir, "BeforeModel", { llm_request: { model: "gemini-3.8-flash" } });
  assert.equal(next.decision, "deny");
  assert.equal(next.continue, false);
});

test("a Gemini total-only usage snapshot is priced as output and can stop the loop", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 1 });
  hook(dir, "AfterModel", {
    llm_request: { model: "gemini-3.8-flash" },
    llm_response: { usageMetadata: { totalTokenCount: 1_000_000 } },
  });
  const next = hook(dir, "BeforeTool", { tool_name: "run_shell_command", tool_input: { command: "ls" } });
  assert.equal(next.continue, false);
  assert.equal(next.decision, "deny");
});

test("Gemini AfterAgent does not use decision deny, which would retry and spend more", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 0.01 });
  hook(dir, "AfterModel", {
    llm_request: { model: "gemini-3.8-flash" },
    llm_response: { usageMetadata: { promptTokenCount: 100_000, candidatesTokenCount: 0 } },
  });
  const stop = hook(dir, "AfterAgent", { prompt: "go", prompt_response: "done" });
  assert.equal(stop.continue, false);
  assert.equal("decision" in stop, false);
});
