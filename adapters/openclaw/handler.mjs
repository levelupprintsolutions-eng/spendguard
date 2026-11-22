#!/usr/bin/env node
// Sample OpenClaw hook. spendguard init does not install this file.
// model_call_ended does not include token counts. Pass usageState through
// when reply_payload_sending has it. Confirm before_tool_call's block shape
// against the current OpenClaw docs before enabling the hook.

import { spawnSync } from "node:child_process";

const handler = async (event) => {
  const type = event?.type ?? event?.event;
  const usage = event?.context?.usageState ?? event?.usageState;
  const payload = {
    hook_event_name: type,
    sessionKey: event?.sessionKey,
    model: event?.context?.model ?? event?.model,
    ...(usage ? { usageState: usage } : {}),
  };
  const child = spawnSync("spendguard", ["hook", "--adapter", "openclaw", "--spendguard"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (child.status !== 0) {
    return { outcome: "block", reason: child.stderr || "spendguard hook failed" };
  }
  const stdout = (child.stdout || "").trim();
  if (!stdout) return undefined;
  try {
    const decision = JSON.parse(stdout);
    if (decision.outcome === "block") {
      return { outcome: "block", reason: decision.reason ?? "spendguard cap reached" };
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export default handler;
