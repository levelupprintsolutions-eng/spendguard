# spendguard

Hard budget caps and a kill switch for AI coding agents. A runaway Claude Code session can no longer spend until the invoice arrives: you set a dollar or token cap, get a warning at 50% and 80%, and the next tool call is refused when the cap is hit. A manual kill switch stops a run even when it is under budget.

Claude Code is enforced. Codex CLI and Cursor can be wired to the same decision, with the limits below. OpenClaw ships as a sample, not an installed enforcer.

Dollars are first-party Claude API list price (the rate card dated 2026-11-09). Claude Pro and Max subscriptions are not invoiced from this table. The figure is the API-equivalent cost of the tokens the session used.

## Install

Node 20 or newer.

```bash
npm install
npx spendguard demo
```

`npm install` compiles the CLI. `npx spendguard` runs it from this checkout. The command name stays `spendguard`. To put it on your PATH:

```bash
npm install -g .
```

State is stored in `~/.spendguard`. Override it with `SPENDGUARD_HOME` or `--home`.

## Quickstart

The demo does not need Claude Code. It writes a fake session transcript, feeds it to the same hook handler Claude Code will call, and checks the warnings, the hard stop, and the kill switch.

```bash
npx spendguard demo
```

You should see, in order:

1. **$0.40 of a $1.00 cap.** The `PreToolUse` hook allows the tool call.
2. **$0.60.** One warning: past the 50% mark.
3. **The same spend again.** Silent. A threshold warns once.
4. **$0.80.** A second warning, plus a note the model can read.
5. **$1.20.** The hook denies the tool and sets `continue: false`, which stops the session.
6. **The `Stop` hook** at the same spend also sets `continue: false`. It does **not** send `decision: "block"`. On `Stop`, that field means "keep working", which would spend more.
7. **A kill switch** on a separate $0.04 session denies the next tool call.
8. **`resume`** allows that session again.

The last line is `Demo passed.`

## Any agent

`spendguard proxy` is a localhost reverse proxy for the Anthropic, OpenAI, Gemini, and xAI APIs. Point the agent's base URL at it. The request that crosses the cap is already billed. The next request is HTTP 402 and is not forwarded. `spendguard kill` stops the next request even when the run is under the cap.

```bash
npx spendguard budget set --usd 5
npx spendguard proxy --provider openai
```

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8791/v1
```

The same pattern covers the OpenAI Agents SDK, LangChain, LangGraph, and CrewAI, because they already take a base URL. Gemini CLI can also refuse the next model call from its own hooks (`spendguard init --adapter gemini`); the token split it reports is thinner than the proxy's. [docs/agents.md](docs/agents.md) says, for each host, what is actually stopped and what is only visible after the fact.

## Use it with Claude Code

```bash
npx spendguard init
npx spendguard budget set --usd 5
npx spendguard budget set --daily --usd 20
```

`init` merges hooks into `~/.claude/settings.json`. It does not remove hooks you already have. Run it again after you move the install; the hook command uses the absolute path of this CLI.

Then start Claude Code in a project. `spendguard status` shows what the hooks have metered. `spendguard sessions` is the same report.

| Command | What it does |
| --- | --- |
| `spendguard budget set --usd 5` | Default cap for every session that does not have its own |
| `spendguard budget set --daily --usd 20` | Ceiling for all sessions today, on top of the per-session cap |
| `spendguard budget set --project --usd 3` | Default cap for sessions started under this directory |
| `spendguard budget set --project --daily --usd 10` | Today's ceiling for this project |
| `spendguard budget set --session <id> --usd 1` | Cap for one session. Replaces the project and global defaults |
| `spendguard budget set --subagent <agent> --session <id> --usd 0.25` | Cap for one subagent. Its spend still counts toward the session |
| `spendguard budget set --tokens 2000000` | Token cap. Dollars and tokens can both be set; either one stops the run |
| `spendguard budget set --block-at 0.95` | Stop at 95% of each cap, leaving room for one more model call |
| `spendguard budget thresholds 0.5 0.8` | Warning points. Each fires once per cap |
| `spendguard budget show` | The caps as stored |
| `spendguard status` | Measured spend. `--json` for a machine-readable report |
| `spendguard kill` | Stop every session at the next hook |
| `spendguard kill --session <id>` | Stop one session |
| `spendguard kill --project` | Stop sessions under this directory |
| `spendguard resume` | Clear the matching kill switch. A cap that is already spent stays in force |
| `spendguard uninstall` | Remove the hooks this tool added |

`--project` uses the current directory. Pass `--cwd /path` to target another one. A project cap applies to that directory and its children, not to a sibling whose path merely shares a prefix.

A session id can be a unique prefix of at least four characters.

## How enforcement works

Claude Code does not put token counts on the hook payload. It does write a JSONL transcript, and each assistant row carries `message.usage` for that API request: input, output, cache read, and cache creation (split into 5-minute and 1-hour writes when the client recorded the split). The `Stop` and `PreToolUse` hooks receive `transcript_path`.

spendguard is a command hook. On each event it:

1. Reads the transcript and keeps the **last** row for each message id. Streaming snapshots of one reply share an id; summing them would multiply the bill. `usage.iterations` is a breakdown of the same request and is not added.
2. Prices those rows from `prices/anthropic.json`.
3. Adds subagent transcripts seen under the same session. The same message id in two files is counted once.
4. Compares the result with every cap that applies. The first one to be exhausted stops the run. A kill flag stops it immediately.

The host-specific response is what actually stops the agent:

| Event | What the hook returns | What Claude Code does |
| --- | --- | --- |
| `PreToolUse` | `permissionDecision: "deny"` and `continue: false` | Refuses the tool call and stops the loop |
| `PermissionRequest` | `behavior: "deny"` and `continue: false` | Denies the approval |
| `PostToolBatch` | `continue: false` | Stops before the next model call |
| `UserPromptSubmit` | `decision: "block"` and `continue: false` | Rejects the prompt |
| `Stop`, `SubagentStop` | `continue: false` only | Ends the turn |

`Stop` must not receive `decision: "block"`. In Claude Code and Codex that value means "do not stop; keep working", and the model would spend another turn. Exit code 2 on `Stop` has the same effect. The hook exits 0 and prints `continue: false`.

`PreToolUse`, `PermissionRequest`, and `UserPromptSubmit` are installed with `onFailure: "block"`. If the hook crashes, the price table cannot be read, or the process cannot start, Claude Code blocks the action instead of letting it through. `spendguard uninstall` is the way out if a bug ever wedges the session.

Warnings use `systemMessage`. At 80% the `PreToolUse` hook also adds a short factual note to the model's context so it can wind down before the hard stop. Neither warning is repeated.

`spendguard init --project` writes the same hooks to `./.claude/settings.json`, which is what a cloud session can see. A cloud VM does not read your laptop's `~/.claude/settings.json`.

## Cost model

Rates are USD per million tokens. For one API request:

```
cost = input            × input rate
     + output           × output rate
     + cache write 5m   × 1.25 × input rate
     + cache write 1h   × 2 × input rate
     + cache read       × model read rate
     + web searches     × $10 / 1,000
```

Cache reads are 0.1× input on most models, 0.05× on Opus 5.5 and Sonnet 5.5, and 0.025× on Fable 5.2, Mythos 5.2, Fable 5.1, and Mythos 5.1. Haiku 5.5 prices the **whole** request at the higher rate when input + cache read + cache write is over 100,000 tokens. A request at exactly 100,000 stays on the lower rate.

These multipliers stack, matching the rate card:

- Fast mode, where the model publishes it, is 2×.
- Batch is 0.5×.
- `inference_geo: "us"` is 1.1× on Claude 4.6 and later.

A token cap counts input + output + cache read + both cache writes. It does not count web searches, which are a dollar charge instead.

Unknown model ids are priced as Claude Fable 5.2 ($8 / $40 per million) and marked **estimated**, so a missing row cannot hide under a cap. Priority tier and code-execution container hours are not in the table; priority is billed at standard rates and called out in the cost notes. Bedrock, Vertex, and Foundry have their own rate cards. This table is the first-party API list price, which is a proxy for those bills, not the invoice.

### Updating prices

`spendguard prices` prints the table and the date it was taken from.

To add or replace a model, copy the row into `~/.spendguard/prices.json`:

```json
{
  "updated": "2026-11-22",
  "models": [
    {
      "id": "claude-example",
      "match": ["claude-example"],
      "input": 3,
      "output": 15,
      "cacheWrite5m": 3.75,
      "cacheWrite1h": 6,
      "cacheRead": 0.3
    }
  ]
}
```

Rows merge by `id`. A model id matches the longest prefix, so `claude-sonnet-4-5-20250929` matches `claude-sonnet-4-5` and not `claude-sonnet-4`. `SPENDGUARD_PRICES=/path/to.json` replaces the built-in file instead of merging.

Claude 3.5 and Claude 3 rows are the last widely published list prices, kept so old transcripts still price. They are not on the current price page.

## MCP and the skill

The agent can read its budget. It cannot raise it.

```bash
npx spendguard init --skill
npx spendguard init --mcp --project
```

`--skill` copies `skill/SKILL.md` into the Claude skills directory. The skill tells the model to check spend before fanning out, and to stop when a tool call is denied instead of retrying it.

`--mcp --project` adds a stdio server to `./.mcp.json`. The only tool is `spendguard_status`. There is no tool that sets a cap or clears the kill switch. `spendguard mcp` speaks MCP over stdio with `Content-Length` framing.

Hooks enforce the cap whether or not the model calls the tool. The skill is a hint. The hook is the gate.

## Adapters

`spendguard adapters` prints this in the terminal.

| Host | Status | What is real |
| --- | --- | --- |
| Claude Code | Enforced | Transcript pricing, threshold warnings, hard stop, kill switch, subagent caps |
| Codex CLI | Partial | `spendguard init --adapter codex` writes `~/.codex/hooks.json`. `PreToolUse` can deny. `Stop` can end the turn with `continue: false`. Spend comes from `PostModelRequest.token_usage` when the field names are recognized (`input_tokens`, `prompt_tokens`, and the usual cache fields). Codex says its transcript format is not stable, so rollout files are not priced. Unrecognized usage stays unknown and does not trip a dollar cap. New hooks do nothing until you trust them with `/hooks`. |
| Cursor | Partial | `spendguard init --adapter cursor` writes `~/.cursor/hooks.json` with `failClosed: true`. The kill switch denies the next shell command, tool call, file read, prompt, or subagent. Hook payloads do not include token counts. A dollar cap applies only when `transcript_path` is Claude-style JSONL with `usage`. Otherwise spend is unknown, not $0. `spendguard budget set --strict` blocks unmetered actions too. User-level hooks do not run on cloud agents; project hooks do. |
| Gemini CLI | Partial | `spendguard init --adapter gemini` writes `~/.gemini/settings.json`. `BeforeModel` and `BeforeTool` refuse the next call when recorded spend is over the cap. `AfterModel` prices `usageMetadata`. A total with no split is priced as output tokens. The proxy is the accurate bill. |
| Provider proxy | Enforced | `spendguard proxy` meters Anthropic, OpenAI, Gemini, and xAI (and any OpenAI-compatible `--upstream`) and refuses the next request. |
| OpenClaw | Sample | `adapters/openclaw/` is a hook you can read. It is not installed. Official `model_call_ended` events do not include token counts. `before_agent_run` can return `{ outcome: "block" }`. Confirm `before_tool_call` against the current docs before enabling the sample. |

Codex `PreToolUse` rejects `continue: false` and then lets the tool run, so that adapter sends `permissionDecision: "deny"` only. The shared decision engine is the same; the renderer is not.

## Limitations

- The transcript is written asynchronously. A hook can be one model call behind, and that call is already billed. `--block-at 0.95` leaves headroom if you want it. The default is the full cap.
- Tool calls already in flight when the cap trips still finish. The next `PreToolUse` is the gate.
- A kill switch stops the run at the next hook. It does not send a signal to the agent process mid-token.
- Subagent caps follow `agent_id` on the hook and `agent_transcript_path`. Rows that appear only as sidechain entries inside the parent transcript count toward the session total.
- `status` scans `~/.claude/projects` for transcripts touched in the last 7 days (`--all` widens that). Sessions that never ran a hook and have no transcript show nothing.
- Fail-closed hooks mean a broken install blocks tool calls. `spendguard uninstall` removes them.
- The price table is list price. It is not your contract, your subscription, or a cloud-provider invoice.

## Tests

```bash
npm test
```

The suite covers the rate card (including fast × US and batch × US stacking, and Haiku 5.5's 100k step), transcript dedupe, cache-write splits, the warning and block decisions, Claude / Codex / Cursor hook payloads, hook install, the MCP status tool, and the demo.

## What to build next

The local tool is the gate. A paid tier is the thing a team cannot get from a file in `~/.spendguard`:

- Shared daily caps and a central kill switch, so one runaway agent stops for the org and not only on that laptop.
- Slack, email, or webhook alerts at the same 50/80/100 thresholds. The CLI can only show a `systemMessage` to the person sitting at the terminal.
- A host that refreshes the price table and reconciles list price with the real invoice, including contracts, subscriptions, and Bedrock or Vertex.
- Per-seat policy: max model, fast mode off, default subagent caps, and an audit log of who raised a cap.

On the open-source side, the useful follow-ups are narrower:

1. Pin Codex `token_usage` against a real session and check the fixture in.
2. Find a Cursor usage source. Until the hook payload or a stable local log carries tokens, Cursor dollar caps stay off unless the transcript happens to be Claude-shaped. The kill switch does not have that problem.
3. Turn the OpenClaw sample into a real plugin once `usageState` is a stable field, and confirm the `before_tool_call` return value.
4. Tail large transcripts instead of rereading them. The current cache keys off size and mtime, which is enough for a session that appends.
5. Optional OpenTelemetry export. Claude can emit usage on OTEL, but that stream cannot refuse a tool call. Hooks stay the enforcement point.

## npm

The package is not published. The unscoped name `spendguard` is already registered on npm by a different project. This package is set up to publish as `@levelupprintsolutions/spendguard` with `"publishConfig": { "access": "public" }`. Publishing that scope requires an npm account that owns `@levelupprintsolutions`. Do not publish until that account exists.

## License

MIT. See [LICENSE](LICENSE).
