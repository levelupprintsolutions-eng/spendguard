import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./env.js";
import { setBudget, setStrict } from "../src/budget.js";
import { handleHook } from "../src/hook.js";
import { isRecord } from "../src/jsonutil.js";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-hook-"));
}

function transcript(dir: string, name: string, rows: unknown[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

function assistant(id: string, input: number, model = "claude-opus-5-5"): unknown {
  return {
    type: "assistant",
    timestamp: "2026-11-22T15:00:00.000Z",
    message: {
      id,
      model,
      usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

function claude(event: string, sessionId: string, file: string, dir: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: sessionId,
    transcript_path: file,
    cwd: dir,
    tool_name: "Bash",
    ...extra,
  });
}

function json(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  assert.ok(isRecord(parsed));
  return parsed;
}

test("Claude PreToolUse denies and stops, and Stop does not ask the model to continue", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 1 });
  const file = transcript(dir, "s.jsonl", [assistant("m", 300_000)]);
  const blocked = handleHook(claude("PreToolUse", "s", file, dir), { home: dir });
  const body = json(blocked.stdout);
  assert.equal(body.continue, false);
  assert.equal(isRecord(body.hookSpecificOutput) && body.hookSpecificOutput.permissionDecision, "deny");
  const stopped = handleHook(claude("Stop", "s", file, dir), { home: dir });
  const stopBody = json(stopped.stdout);
  assert.equal(stopBody.continue, false);
  assert.equal("decision" in stopBody, false);
});

test("Claude SubagentStop sends continue:false and never decision:block", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 1 });
  const file = transcript(dir, "s.jsonl", [assistant("m", 300_000)]);
  const stopped = handleHook(claude("SubagentStop", "s", file, dir, { agent_id: "explore" }), { home: dir });
  const stopBody = json(stopped.stdout);
  assert.equal(stopped.exitCode, 0);
  assert.equal(stopBody.continue, false);
  assert.equal(stopBody.decision, undefined);
  assert.equal("decision" in stopBody, false);
});

test("the same message id in two transcripts is billed once", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 0.5 });
  const shared = assistant("same", 100_000);
  const parent = transcript(dir, "parent.jsonl", [shared]);
  const child = transcript(dir, "child.jsonl", [shared]);
  handleHook(claude("PreToolUse", "s", parent, dir), { home: dir });
  const result = handleHook(
    claude("PreToolUse", "s", child, dir, { agent_id: "explore", agent_type: "Explore" }),
    { home: dir },
  );
  assert.equal(result.stdout, "", result.stdout);
});

test("a subagent's own messages roll into the parent session and its own cap", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 10 });
  const parent = transcript(dir, "parent.jsonl", [assistant("p", 100_000)]);
  const child = transcript(dir, "child.jsonl", [assistant("c", 75_000)]);
  handleHook(claude("SubagentStart", "s", parent, dir, { agent_id: "explore" }), { home: dir });
  handleHook(claude("PreToolUse", "s", parent, dir), { home: dir });
  setBudget(dir, { kind: "subagent", sessionId: "s", agentId: "explore" }, { usd: 0.25 });
  const result = handleHook(claude("PreToolUse", "child-session", child, dir, { agent_id: "explore" }), { home: dir });
  assert.match(json(result.stdout).stopReason as string, /\$0\.3000/);
});

test("Codex records token_usage and denies without continue:false", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 1 });
  const recorded = handleHook(
    JSON.stringify({
      hook_event_name: "PostModelRequest",
      session_id: "cx",
      turn_id: "turn-1",
      model: "claude-opus-5-5",
      status: "completed",
      token_usage: { input_tokens: 300_000, output_tokens: 0 },
    }),
    { home: dir, adapter: "codex" },
  );
  assert.equal(recorded.stdout, "");
  const denied = handleHook(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "cx",
      turn_id: "turn-2",
      cwd: dir,
      tool_name: "Bash",
    }),
    { home: dir, adapter: "codex" },
  );
  const body = json(denied.stdout);
  assert.equal("continue" in body, false);
  assert.equal(isRecord(body.hookSpecificOutput) && body.hookSpecificOutput.permissionDecision, "deny");
});

test("Cursor allows with permission:allow when spend is unknown, and strict mode denies", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 1 });
  const payload = JSON.stringify({
    hook_event_name: "preToolUse",
    conversation_id: "conv",
    cursor_version: "1.7.2",
    cwd: dir,
    tool_name: "Shell",
  });
  const open = handleHook(payload, { home: dir, adapter: "cursor" });
  assert.deepEqual(json(open.stdout), { permission: "allow" });
  setStrict(dir, true);
  const closed = handleHook(payload, { home: dir, adapter: "cursor" });
  assert.equal(json(closed.stdout).permission, "deny");
});

test("a broken price overlay fails closed on PreToolUse", () => {
  const dir = home();
  fs.writeFileSync(path.join(dir, "prices.json"), "{ \"models\": \"nope\" }\n");
  const result = handleHook(
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: dir }),
    { home: dir },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /price table|models/);
});

test("a token cap blocks a Claude session", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { tokens: 50_000 });
  const file = transcript(dir, "s.jsonl", [assistant("m", 80_000)]);
  const result = handleHook(claude("PreToolUse", "s", file, dir), { home: dir });
  assert.match(String(json(result.stdout).stopReason), /token/);
});
