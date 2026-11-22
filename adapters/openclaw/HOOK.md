---
name: spendguard
description: Sample Spendguard hook. Not installed by spendguard init. Confirm token fields before enabling.
metadata:
  openclaw:
    emoji: "💸"
    events: ["before_tool_call", "before_agent_run", "reply_payload_sending"]
---

# Spendguard sample

OpenClaw can block a run from `before_tool_call` and `before_agent_run`. The official `model_call_ended` event does not include token counts. `reply_payload_sending` may carry a best-effort `usageState`.

`handler.mjs` shells out to `spendguard hook --adapter openclaw` and, when the CLI returns `outcome: "block"`, returns `{ outcome: "block", reason }`. That return shape matches `before_agent_run`. Check the current `before_tool_call` contract before you depend on it.

This directory is a sample. `spendguard init` does not copy it into an OpenClaw hooks folder.
