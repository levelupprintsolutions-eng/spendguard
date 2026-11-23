import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./env.js";
import { setBudget } from "../src/budget.js";
import { handleHook } from "../src/hook.js";
import { isRecord } from "../src/jsonutil.js";
import { loadPriceTable } from "../src/pricing.js";
import { pictureFor } from "../src/rollup.js";
import { loadLedger } from "../src/store.js";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-cursor-"));
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function assistant(id: string, input: number): unknown {
  return {
    type: "assistant",
    timestamp: "2026-11-22T15:00:00.000Z",
    message: {
      id,
      model: "claude-opus-5-5",
      usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

function cursor(event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: event,
    cursor_version: "2026.10.17",
    ...fields,
  });
}

function json(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  assert.ok(isRecord(parsed));
  return parsed;
}

function priced(dir: string, sessionId: string, agentId?: string) {
  const ledger = loadLedger(dir);
  const table = loadPriceTable({ home: dir });
  const picture = pictureFor({
    ledger,
    sessionId,
    ...(agentId ? { agentId } : {}),
    projectKey: "",
    day: "2026-11-22",
    table,
  });
  return { ledger, picture };
}

test("Cursor subagent transcripts are billed once on the parent, including after Task postToolUse", () => {
  const dir = home();
  const parentId = "conv-parent";
  const parentFile = path.join(dir, "agent-transcripts", parentId, `${parentId}.jsonl`);
  const childFile = path.join(dir, "agent-transcripts", parentId, "subagents", "agent-1.jsonl");
  writeJsonl(parentFile, [assistant("parent-msg", 100_000), assistant("shared", 25_000)]);
  writeJsonl(childFile, [assistant("child-msg", 50_000), assistant("shared", 25_000)]);

  handleHook(
    cursor("subagentStart", {
      conversation_id: parentId,
      parent_conversation_id: parentId,
      subagent_id: "agent-1",
      subagent_type: "explore",
      transcript_path: parentFile,
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  // Hook inside the subagent: child conversation id, no parent id, and the
  // new transcript_path under agent-transcripts/<parent>/subagents/.
  handleHook(
    cursor("preToolUse", {
      conversation_id: "conv-child",
      transcript_path: childFile,
      tool_name: "Shell",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );

  const during = priced(dir, parentId, "agent-1");
  assert.deepEqual(Object.keys(during.ledger.sessions), [parentId]);
  assert.equal(during.picture.session.nanoUsd, 700_000_000);
  assert.equal(during.picture.dailyGlobal.nanoUsd, 700_000_000);

  const observed = handleHook(
    cursor("postToolUse", {
      conversation_id: parentId,
      transcript_path: parentFile,
      tool_name: "Task",
      tool_use_id: "task-1",
      tool_input: { description: "explore the repo" },
      tool_output: JSON.stringify({ result: "done", usage: { input_tokens: 9_999_999 } }),
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  assert.equal(observed.exitCode, 0);

  handleHook(
    cursor("subagentStop", {
      conversation_id: parentId,
      parent_conversation_id: parentId,
      subagent_id: "agent-1",
      subagent_type: "explore",
      transcript_path: parentFile,
      agent_transcript_path: childFile,
      status: "completed",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );

  const failed = handleHook(
    cursor("postToolUseFailure", {
      conversation_id: parentId,
      transcript_path: parentFile,
      tool_name: "Task",
      tool_use_id: "task-1",
      error_message: "subagent failed",
      failure_type: "error",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  assert.equal(failed.exitCode, 0);
  assert.equal(failed.stdout, "");

  const after = priced(dir, parentId, "agent-1");
  assert.deepEqual(Object.keys(after.ledger.sessions), [parentId]);
  assert.equal(after.picture.session.nanoUsd, 700_000_000);
  assert.equal(after.picture.session.tokens, 175_000);
  assert.equal(after.picture.agent?.nanoUsd, 300_000_000);
  assert.equal(after.picture.dailyGlobal.nanoUsd, 700_000_000);
  const session = after.ledger.sessions[parentId];
  assert.equal(session?.transcripts[parentFile]?.agentId, null);
  assert.equal(session?.transcripts[childFile]?.agentId, "agent-1");
  assert.equal(
    Object.values(after.ledger.sessions).filter((item) => item.transcripts[childFile]).length,
    1,
  );

  setBudget(dir, { kind: "subagent", sessionId: parentId, agentId: "agent-1" }, { usd: 0.25 });
  const denied = handleHook(
    cursor("preToolUse", {
      conversation_id: "conv-child",
      parent_conversation_id: parentId,
      subagent_id: "agent-1",
      transcript_path: childFile,
      tool_name: "Shell",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  const body = json(denied.stdout);
  assert.equal(body.permission, "deny");
  assert.match(String(body.user_message), /\$0\.3000/);
  assert.doesNotMatch(String(body.user_message), /\$0\.7000/);
});

test("the same Cursor subagent file is not billed on both the child and parent sessions", () => {
  const dir = home();
  const parentId = "conv-parent";
  const childId = "conv-child";
  const legacy = path.join(dir, "agent-transcripts", childId, `${childId}.jsonl`);
  writeJsonl(legacy, [assistant("legacy", 100_000)]);

  handleHook(
    cursor("preToolUse", {
      conversation_id: childId,
      transcript_path: legacy,
      tool_name: "Shell",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  handleHook(
    cursor("subagentStop", {
      conversation_id: parentId,
      parent_conversation_id: parentId,
      subagent_id: "agent-1",
      transcript_path: path.join(dir, "agent-transcripts", parentId, `${parentId}.jsonl`),
      agent_transcript_path: legacy,
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );

  const ledger = loadLedger(dir);
  const holders = Object.values(ledger.sessions).filter((session) => session.transcripts[legacy]);
  assert.equal(holders.length, 1);
  assert.equal(holders[0]?.id, parentId);
  const picture = pictureFor({
    ledger,
    sessionId: parentId,
    projectKey: "",
    day: "2026-11-22",
    table: loadPriceTable({ home: dir }),
  });
  assert.equal(picture.session.nanoUsd, 400_000_000);
  assert.equal(picture.dailyGlobal.nanoUsd, 400_000_000);
});

test("a Cursor transcript without usage stays unknown when subagent and Task hooks both see it", () => {
  const dir = home();
  setBudget(dir, { kind: "global-session" }, { usd: 0.01 });
  const parentId = "conv-parent";
  const parentFile = path.join(dir, "agent-transcripts", parentId, `${parentId}.jsonl`);
  const childFile = path.join(dir, "agent-transcripts", parentId, "subagents", "agent-1.jsonl");
  const native = (text: string) => [
    { role: "assistant", message: { content: [{ type: "text", text }] } },
    { type: "turn_ended", status: "success" },
  ];
  writeJsonl(parentFile, native("parent"));
  writeJsonl(childFile, native("child"));

  handleHook(
    cursor("preToolUse", {
      conversation_id: "conv-child",
      transcript_path: childFile,
      tool_name: "Shell",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  const result = handleHook(
    cursor("postToolUse", {
      conversation_id: parentId,
      transcript_path: parentFile,
      tool_name: "Task",
      tool_use_id: "task-1",
      tool_output: "{\"result\":\"ok\"}",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  assert.equal(result.exitCode, 0);

  const allowed = handleHook(
    cursor("preToolUse", {
      conversation_id: parentId,
      transcript_path: parentFile,
      tool_name: "Shell",
      cwd: dir,
    }),
    { home: dir, adapter: "cursor" },
  );
  assert.deepEqual(json(allowed.stdout), { permission: "allow" });
  const { ledger, picture } = priced(dir, parentId);
  assert.equal(ledger.sessions[parentId]?.usageKnown, false);
  assert.equal(picture.session.nanoUsd, 0);
  assert.equal(picture.session.known, false);
});
