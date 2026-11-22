---
name: spendguard
description: Check the Spendguard budget before expensive fan-out, subagents, or a long autonomous run. Use when a task may spawn many model calls, when a system message mentions a spend cap, or when a tool call was denied by spendguard. Hooks enforce the cap even if you skip this skill.
---

# Spendguard

Spendguard is a local budget cap and kill switch. Hooks block further tool calls when the cap is hit. You cannot raise the cap.

## Check spend

If the `spendguard` MCP server is connected, call `spendguard_status`. Otherwise run:

```bash
spendguard status --json
```

Read the session cap, the amount already spent, and the percent used.

## How to work

- Under 50%: work normally.
- At or past 80%: finish the current task. Do not spawn subagents or start a second long search.
- At the cap: stop. Tell the user the run was stopped and quote the `spendguard budget set` command from the hook message. Do not retry the blocked tool.

A denied tool call is the cap working. Retrying it can spend another model call if the session has not stopped yet.
