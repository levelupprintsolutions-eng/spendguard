import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBudget } from "./budget.js";
import { handleHook, type HookOptions } from "./hook.js";
import { isRecord } from "./jsonutil.js";
import { clearKill, engageKill } from "./kills.js";
import { buildStatus, formatStatus } from "./status.js";

export interface DemoResult {
  ok: boolean;
  text: string;
  home: string;
}

/**
 * Simulated Claude Code session. No Claude install required.
 * Prices  claude-opus-5-5 input at $4 / million tokens against a $1 session cap.
 */
export function runDemo(options?: { home?: string; now?: Date }): DemoResult {
  const home = options?.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-demo-"));
  const now = options?.now ?? new Date("2026-11-22T15:00:00.000Z");
  const project = path.join(home, "project");
  const transcript = path.join(project, "demo-session.jsonl");
  fs.mkdirSync(project, { recursive: true });
  setBudget(home, { kind: "global-session" }, { usd: 1 });

  const lines: string[] = [];
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  const hookOptions: HookOptions = { home, now, adapter: "claude-code" };

  lines.push("spendguard demo — simulated Claude Code session");
  lines.push("Model claude-opus-5-5 input is $4 / million tokens. Session cap is $1.00. Warnings at 50% and 80%.");
  lines.push("");

  writeTranscript(transcript, [message("m1", 100_000)]);
  const first = handleHook(payload("demo-session", transcript, project, "PreToolUse"), hookOptions);
  lines.push(`1. $0.4000 (40%)  PreToolUse ${first.stdout ? "responded" : "allow"}`);
  if (first.exitCode !== 0 || first.stdout !== "") fail("step 1 should allow with no output");

  writeTranscript(transcript, [message("m1", 100_000), message("m2", 50_000)]);
  const warn50 = handleHook(payload("demo-session", transcript, project, "PreToolUse"), hookOptions);
  lines.push(`2. $0.6000 (60%)  PreToolUse warn`);
  lines.push(`   ${warn50.stdout}`);
  if (!warn50.stdout.includes("50%")) fail("step 2 should warn at 50%");

  const repeat = handleHook(payload("demo-session", transcript, project, "PreToolUse"), hookOptions);
  lines.push(`3. same spend again  ${repeat.stdout ? "warned again" : "silent (warning already delivered)"}`);
  if (repeat.stdout !== "") fail("step 3 should not repeat the 50% warning");

  writeTranscript(transcript, [message("m1", 100_000), message("m2", 50_000), message("m3", 50_000)]);
  const warn80 = handleHook(payload("demo-session", transcript, project, "PreToolUse"), hookOptions);
  lines.push(`4. $0.8000 (80%)  PreToolUse warn`);
  lines.push(`   ${warn80.stdout}`);
  if (!warn80.stdout.includes("80%")) fail("step 4 should warn at 80%");
  if (!warn80.stdout.includes("additionalContext")) fail("step 4 should tell the model the cap is close");

  writeTranscript(transcript, [
    message("m1", 100_000),
    message("m2", 50_000),
    message("m3", 50_000),
    message("m4", 100_000),
  ]);
  const blocked = handleHook(payload("demo-session", transcript, project, "PreToolUse"), hookOptions);
  const blockedJson = parseObject(blocked.stdout);
  lines.push("5. $1.2000 (120%)  PreToolUse BLOCK");
  lines.push(`   ${blocked.stdout}`);
  if (blocked.exitCode !== 0) fail("step 5 should exit 0 and stop via JSON");
  if (blockedJson?.continue !== false) fail("step 5 should set continue:false");
  const specific = isRecord(blockedJson?.hookSpecificOutput) ? blockedJson.hookSpecificOutput : undefined;
  if (specific?.permissionDecision !== "deny") fail("step 5 should deny the tool call");

  const stopped = handleHook(payload("demo-session", transcript, project, "Stop"), hookOptions);
  const stoppedJson = parseObject(stopped.stdout);
  lines.push("6. Stop hook at the same spend");
  lines.push(`   ${stopped.stdout}`);
  if (stoppedJson?.continue !== false) fail("step 6 Stop should set continue:false");
  if ("decision" in (stoppedJson ?? {})) fail("step 6 Stop must not send decision:block (that keeps Claude working)");

  const killTranscript = path.join(project, "demo-kill.jsonl");
  writeTranscript(killTranscript, [message("k1", 10_000)]);
  const under = handleHook(payload("demo-kill", killTranscript, project, "PreToolUse"), hookOptions);
  if (under.stdout !== "") fail("kill setup should be under the cap");
  engageKill(home, { kind: "session", sessionId: "demo-kill" }, "demo kill switch", now);
  const killed = handleHook(payload("demo-kill", killTranscript, project, "PreToolUse"), hookOptions);
  const killedJson = parseObject(killed.stdout);
  lines.push("7. kill switch on a $0.0400 session");
  lines.push(`   ${killed.stdout}`);
  if (killedJson?.continue !== false) fail("step 7 kill switch should stop the run");
  clearKill(home, { kind: "session", sessionId: "demo-kill" });
  const resumed = handleHook(payload("demo-kill", killTranscript, project, "PreToolUse"), hookOptions);
  lines.push(`8. resume  ${resumed.stdout ? "still blocked" : "allow"}`);
  if (resumed.stdout !== "") fail("step 8 resume should allow the under-cap session");

  lines.push("");
  lines.push(formatStatus(buildStatus({ home, now, scan: false })));
  if (failures.length > 0) {
    lines.push("");
    lines.push("Demo failed:");
    for (const failure of failures) lines.push(`- ${failure}`);
  } else {
    lines.push("");
    lines.push("Demo passed. Caps, the one-time warnings, the hard stop, and the kill switch all fired.");
  }
  return { ok: failures.length === 0, text: lines.join("\n"), home };
}

function message(id: string, inputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-22T15:00:00.000Z",
    message: {
      id,
      model: "claude-opus-5-5",
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function writeTranscript(file: string, rows: string[]): void {
  fs.writeFileSync(file, `${rows.join("\n")}\n`);
}

function payload(sessionId: string, transcript: string, cwd: string, event: string): string {
  return JSON.stringify({
    hook_event_name: event,
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
}

function parseObject(stdout: string): Record<string, unknown> | null {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

